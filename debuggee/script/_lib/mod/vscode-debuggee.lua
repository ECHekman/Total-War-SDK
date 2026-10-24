--------------------------------------------------------------------------------
-- Total War Modding Tools debugger - in-game debuggee (protocol 2)
--
-- Talks to the VS Code extension through files in <game folder>/tw_lua_debugger/:
--   session.json  written by VS Code while a debug session is active
--   to_game       VS Code -> game messages
--   from_game     game -> VS Code messages
-- Every message is framed as "#<byte length>\n<json>".
--
-- Based on the devCAT VSCodeLuaDebug debuggee (MIT, NEXON Korea Corporation).
--------------------------------------------------------------------------------

if type(debuggee) == 'table' and debuggee.protocol == 2 then
	return debuggee
end

local PROTOCOL = 2
local MOD_VERSION = '0.0.1'
local COMM_DIR = 'tw_lua_debugger/'
local WELCOME_TIMEOUT = 5      -- seconds to wait for VS Code to answer our hello
local SESSION_CHECK_INTERVAL = 1
local PAUSE_FALLBACK = 1.5     -- seconds before a pause stops inside the poller
local ROTATE_BYTES = 1024 * 1024 -- communication files are started over above this size
local ALIVE_CONNECT_WAIT = 1     -- seconds to see VS Code's heartbeat before connecting
local ALIVE_TIMEOUT_STOPPED = 3  -- resume the game when the heartbeat stops this long while paused
local ALIVE_TIMEOUT_RUNNING = 5  -- detach when the heartbeat stops this long while running

local M = { protocol = PROTOCOL, version = MOD_VERSION }
debuggee = M

-- Make the game write its script log (script_log_*.txt), as the original mod did.
__write_output_to_logfile = true

if not io or not debug or not debug.getinfo then
	-- Nothing we can do without these libraries.
	function M.start() return false end
	function M.poll() end
	function M.print() return false end
	return M
end

local json = M.json
do
	local ok, lib = pcall(require, 'script._lib.mod.twdt_json')
	if ok and type(lib) == 'table' then
		json = lib
	elseif type(tw_json) == 'table' then
		json = tw_json
	end
end

-- Keep private references. While a debugger is attached, debug.sethook is
-- replaced so other scripts cannot take the hook away (see installWrappers).
local getinfo, getlocal, setlocal = debug.getinfo, debug.getlocal, debug.setlocal
local getupvalue, setupvalue, sethook = debug.getupvalue, debug.setupvalue, debug.sethook
local rawgetmetatable = debug.getmetatable or getmetatable

local rawError = error
local unpack = unpack or table.unpack
local loadstring = loadstring or load
local clock = os.clock
-- Total War replaces string.find/sub/len with UTF-8 aware versions that count
-- characters and do not support patterns. The protocol and the JSON parser work
-- in bytes, so use the standard Lua functions, which the game keeps as *_lua.
local strfind = string.find_lua or string.find
local strsub = string.sub_lua or string.sub
-- The table our bare globals (print, out, error...) live in; the game may load
-- mod scripts with their own environment.
local ENV = (getfenv and getfenv(1)) or _G

local OWN_SOURCE = getinfo(1, 'S').source

local function pack(...)
	return { n = select('#', ...), ... }
end

--------------------------------------------------------------------------------
-- state
--------------------------------------------------------------------------------

local T = {                    -- transport
	connected = false,
	nonce = nil,
	failedNonce = nil,
	id = nil,
	inFile = nil,
	outFile = nil,
	inOffset = 0,
	inBuf = '',
	queue = {},
	seq = 1,
	lastSessionCheck = -100,
}

local env = 'unknown'
local inDebugger = false       -- true while we run our own code (stopped, evaluating)
local captureOutput = false
local exceptionFilters = {}

local bpByKey = {}             -- key -> { [line] = bp }
local keyParts = {}            -- key -> split path
local bpLines = {}             -- line -> number of breakpoints on that line in any file
local chunkKeyCache = {}       -- chunk source -> key or false

local stepMode = nil           -- nil | 'over' | 'in' | 'out'
local stepHeight = 0
local pausePending = false
local pauseRequestedAt = 0

local ctxHeight = 0            -- height of the frame being inspected (user frame)
local stopCtx = nil            -- set while stopped: { threads = { [id] = co } }
local refs = {}                -- variablesReference -> entry
local nextRef = 1

local coroutines = setmetatable({}, { __mode = 'k' })
local hookActive = false
local mainHookDirty = false

--------------------------------------------------------------------------------
-- helpers
--------------------------------------------------------------------------------

--- Number of stack frames from the caller of height() down to the bottom.
local function height()
	local i = 2
	while getinfo(i, 'l') do
		i = i + 1
	end
	return i - 2
end

--- Level (relative to the caller) of frame k counted from the inspected user frame.
local function frameLevel(k)
	return height() - ctxHeight + k
end

local function isInternal(source)
	return source == OWN_SOURCE or (source and strfind(source, 'twdt_', 1, true) ~= nil)
end

--- Lower-case path components; the '.lua' extension is dropped because the
-- game may load scripts by module name (script/campaign/mod/foo).
local function splitPath(s)
	local parts = {}
	for word in s:gmatch('[^/\\]+') do
		parts[#parts + 1] = word:lower()
	end
	if #parts > 0 then
		parts[#parts] = parts[#parts]:gsub('%.lua$', '')
	end
	return parts
end

--- Number of trailing path components two split paths share.
local function matchCount(a, b)
	local n = math.min(#a, #b)
	for i = 0, n - 1 do
		if a[#a - i] ~= b[#b - i] then
			return i
		end
	end
	return n
end

local function chunkName(source)
	if not source then
		return nil
	end
	local first = strsub(source, 1, 1)
	if first == '@' or first == '=' then
		return strsub(source, 2)
	end
	-- Total War loads scripts with loadstring(code, 'script\\...\\file.lua'), so
	-- the chunk name is a bare path. Anything else here is a chunk of code.
	if #source < 260 and not strfind(source, '\n', 1, true) and source:match('%.lua$') then
		return source
	end
	return nil
end

--- Whether a mod script is on the stack: the game loads mods from 'mod' folders
-- (script/campaign/mod, script/_lib/mod, ...). The debugger's own files don't count.
local function modScriptOnStack()
	for level = 3, 100 do
		local info = getinfo(level, 'S')
		if not info then
			return false
		end
		local name = chunkName(info.source)
		if name and not isInternal(info.source) and name:lower():gsub('\\', '/'):match('/mod/') then
			return true
		end
	end
	return false
end

local function safeToString(v)
	local ok, s = pcall(tostring, v)
	if ok and type(s) == 'string' then
		return s
	end
	return '<' .. type(v) .. '>'
end

local function quoteString(s, max)
	max = max or 4000
	if #s > max then
		s = strsub(s, 1, max) .. '...'
	end
	s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\r', '\\r'):gsub('\n', '\\n'):gsub('\t', '\\t')
	return '"' .. s .. '"'
end

local function keyToName(k)
	if type(k) == 'string' then
		return k
	elseif type(k) == 'number' then
		return '[' .. safeToString(k) .. ']'
	end
	return '[' .. safeToString(k) .. ']'
end

local function shortValue(v)
	local t = type(v)
	if t == 'string' then
		return quoteString(v, 40)
	elseif t == 'table' then
		return '{...}'
	elseif t == 'number' or t == 'boolean' or t == 'nil' then
		return tostring(v)
	end
	return t
end

local function formatValue(v)
	local t = type(v)
	if t == 'string' then
		return quoteString(v)
	elseif t == 'table' then
		local mt = rawgetmetatable(v)
		if mt and rawget(mt, '__tostring') then
			return safeToString(v)
		end
		local items, count = {}, 0
		local n = #v
		for i = 1, math.min(n, 5) do
			items[#items + 1] = shortValue(rawget(v, i))
		end
		for k, val in next, v do
			count = count + 1
			local isArrayPart = type(k) == 'number' and k >= 1 and k <= n and k % 1 == 0
			if not isArrayPart and #items < 5 then
				items[#items + 1] = keyToName(k) .. '=' .. shortValue(val)
			end
			if count > 100 then
				break
			end
		end
		local more = count > #items and ', ...' or ''
		return '{' .. table.concat(items, ', ') .. more .. '}'
	elseif t == 'function' then
		local info = getinfo(v, 'S')
		if info and info.what ~= 'C' then
			return 'function ' .. (info.short_src or '?') .. ':' .. (info.linedefined or 0)
		end
		return 'function (builtin)'
	end
	return safeToString(v)
end

--------------------------------------------------------------------------------
-- transport
--------------------------------------------------------------------------------

--- Diagnostic log (tw_lua_debugger/debuggee.log), enabled by the session's "log" flag
-- ("trace": true in the launch configuration).
local function dlog(...)
	if not T.logFile then
		return
	end
	local parts = { string.format('[time %d clock %.3f] ', os.time(), clock()) }
	for i = 1, select('#', ...) do
		parts[#parts + 1] = tostring((select(i, ...)))
	end
	T.logFile:write(table.concat(parts, ' '), '\n')
	T.logFile:flush()
end

local function readWholeFile(path)
	local f = io.open(path, 'rb')
	if not f then
		return nil
	end
	local s = f:read('*a')
	f:close()
	return s
end

local function readSession()
	local s = readWholeFile(COMM_DIR .. 'session.json')
	if not s or s == '' then
		return nil
	end
	local ok, obj = pcall(json.decode, s)
	if ok and type(obj) == 'table' then
		return obj
	end
	return nil
end

local function send(msg)
	if not T.outFile then
		return
	end
	msg.seq = T.seq
	T.seq = T.seq + 1
	local ok, body = pcall(json.encode, msg)
	if not ok then
		-- Never let an unencodable value break the protocol.
		body = json.encode({ type = msg.type, seq = msg.seq, req = msg.req, ok = false,
			evt = msg.evt, err = 'debuggee could not encode message: ' .. tostring(body) })
	end
	T.outFile:write('#', #body, '\n', body)
	T.outFile:flush()
end

local function sendEvent(name, body)
	send({ type = 'evt', evt = name, body = body })
end

local function respond(req, ok, bodyOrErr)
	if ok then
		send({ type = 'res', req = req.seq, ok = true, body = bodyOrErr })
	else
		send({ type = 'res', req = req.seq, ok = false, err = tostring(bodyOrErr) })
	end
end

local function readIncoming()
	if not T.connected then
		return
	end
	-- Reopened on every read: in the game, a file kept open does not see data
	-- appended to it later.
	local f = io.open(COMM_DIR .. 'to_game', 'rb')
	if not f then
		dlog('readIncoming: cannot open to_game')
		return
	end
	f:seek('set', T.inOffset)
	local data = f:read('*a')
	f:close()
	if data and #data > 0 then
		dlog('readIncoming: offset', T.inOffset, 'read', #data, 'bytes')
		T.inOffset = T.inOffset + #data
		T.inBuf = T.inBuf .. data
	end
	while true do
		local nl = strfind(T.inBuf, '\n', 1, true)
		if not nl then
			break
		end
		local size = tonumber(strsub(T.inBuf, 1, nl - 1):match('^#(%d+)'))
		if not size then
			T.inBuf = '' -- corrupt stream; drop what we have
			break
		end
		if #T.inBuf < nl + size then
			break
		end
		local body = strsub(T.inBuf, nl + 1, nl + size)
		T.inBuf = strsub(T.inBuf, nl + size + 1)
		local ok, msg = pcall(json.decode, body)
		if ok and type(msg) == 'table' then
			T.queue[#T.queue + 1] = msg
		else
			dlog('readIncoming: could not decode', strsub(body, 1, 200), msg)
		end
	end
end

local function recv()
	if #T.queue == 0 then
		readIncoming()
	end
	if #T.queue == 0 then
		return nil
	end
	return table.remove(T.queue, 1)
end

-- Global functions are only wrapped while VS Code is attached, so the mod
-- changes nothing for players who leave it enabled. Defined further down.
local installWrappers, removeWrappers

local function closeTransport()
	if T.connected then
		removeWrappers()
	end
	if T.outFile then
		T.outFile:close()
	end
	T.outFile = nil
	T.connected = false
	T.nonce = nil
	T.queue = {}
	T.inBuf = ''
end

--------------------------------------------------------------------------------
-- hook management
--------------------------------------------------------------------------------

local hook -- forward
local resolveKey -- forward
local finishDisconnect -- forward

local function needHook()
	return T.connected and (next(bpByKey) ~= nil or stepMode ~= nil or pausePending)
end

-- The line hook runs on every line of every script while it is installed, so
-- its fast path is a single lookup in lineFilter: the lines that have a
-- breakpoint in any file, or every line while stepping or pausing.
-- (Hooking calls/returns instead and turning line events on only inside files
-- with breakpoints was measured: much slower for call-heavy code, which game
-- scripts are.)
local ALL_LINES = setmetatable({}, { __index = function() return true end })
local lineFilter = {}

local mainHooked = ''

-- The sampling profiler (see "SDK tools") adds a count hook: every
-- `profiler.interval` VM instructions the hook records the call stack.
local profiler = { on = false, interval = 5000, samples = {}, distinct = 0, total = 0, started = 0 }
-- The event monitor (see "SDK tools").
local monitor = { on = false, original = nil, wrapper = nil, windowStart = 0, inWindow = 0, dropped = 0 }

--- Sets the current hook (line and/or count) on a thread, or removes it.
local function hookThread(co, lines, counting)
	local mask = lines and 'l' or ''
	local count = counting and profiler.interval or 0
	if co then
		if lines or counting then
			sethook(co, hook, mask, count)
		else
			sethook(co)
		end
	elseif lines or counting then
		sethook(hook, mask, count)
	else
		sethook()
	end
end

local function updateHook()
	local want = needHook()
	local counting = T.connected and profiler.on
	lineFilter = (stepMode or pausePending) and ALL_LINES or bpLines
	local running = coroutine.running()
	if running then
		-- Total War runs its scripts inside a coroutine; hooks are per thread,
		-- so that coroutine has to be hooked, not the main thread.
		coroutines[running] = true
	end
	for co in pairs(coroutines) do
		if coroutine.status(co) ~= 'dead' then
			hookThread(co, want, counting)
		end
	end
	local state = (want and 'l' or '') .. (counting and 'c' or '')
	if running == nil then
		if state ~= mainHooked or mainHookDirty then
			hookThread(nil, want, counting)
			mainHooked = state
			mainHookDirty = false
		end
	elseif state ~= mainHooked then
		-- debug.sethook only reaches the running thread; fix the main thread on the next poll from it.
		mainHookDirty = true
	end
	hookActive = want or counting
	dlog('updateHook: hook', state ~= '' and state or 'off', 'running in', tostring(running))
end

local function rebuildLineIndex()
	bpLines = {}
	keyParts = {}
	for key, lines in pairs(bpByKey) do
		keyParts[key] = splitPath(key)
		for line in pairs(lines) do
			bpLines[line] = (bpLines[line] or 0) + 1
		end
	end
	chunkKeyCache = {}
end

local function setBreakpoints(key, list)
	key = key:lower():gsub('\\', '/')
	local lines = nil
	for _, bp in ipairs(list or {}) do
		if type(bp.line) == 'number' then
			lines = lines or {}
			lines[bp.line] = {
				line = bp.line,
				condition = bp.condition,
				hitCondition = bp.hitCondition,
				logMessage = bp.logMessage,
				hits = 0,
			}
		end
	end
	bpByKey[key] = lines
end

--- Finds the breakpoint key that best matches a chunk name (longest common path suffix).
resolveKey = function(source)
	local cached = chunkKeyCache[source]
	if cached ~= nil then
		return cached
	end
	local name = chunkName(source)
	local best, bestCount = false, 0
	if name then
		local parts = splitPath(name)
		for key, kp in pairs(keyParts) do
			local count = matchCount(parts, kp)
			if count > bestCount then
				best, bestCount = key, count
			end
		end
	end
	chunkKeyCache[source] = best
	return best
end

local function clearDebugState()
	bpByKey = {}
	rebuildLineIndex()
	stepMode = nil
	pausePending = false
	exceptionFilters = {}
	captureOutput = false
	-- The SDK tools are per session (the monitor's wrapper stays, inactive).
	profiler.on = false
	profiler.samples, profiler.distinct = {}, 0
	monitor.on = false
	updateHook()
end

--------------------------------------------------------------------------------
-- frames, variables and evaluation
--------------------------------------------------------------------------------

local function threadOf(tid)
	return stopCtx and stopCtx.threads[tid]
end

-- Frame accessors. For thread 1 (the stopped one) frames are counted from the
-- inspected user frame; frameLevel() must be called directly as an argument so
-- it computes the level relative to the accessor.
local function fGetinfo(tid, k, what)
	if tid == 1 then
		return getinfo(frameLevel(k), what)
	end
	local co = threadOf(tid)
	return co and getinfo(co, k, what)
end

local function fGetlocal(tid, k, i)
	if tid == 1 then
		return getlocal(frameLevel(k), i)
	end
	local co = threadOf(tid)
	if co then
		return getlocal(co, k, i)
	end
end

local function fSetlocal(tid, k, i, v)
	if tid == 1 then
		return setlocal(frameLevel(k), i, v)
	end
	local co = threadOf(tid)
	if co then
		return setlocal(co, k, i, v)
	end
end

local function decodeFrameId(id)
	return math.floor(id / 10000), (id % 10000) - 1
end

local function encodeFrameId(tid, k)
	return tid * 10000 + k + 1
end

local function newRef(entry)
	local ref = nextRef
	nextRef = nextRef + 1
	refs[ref] = entry
	return ref
end

local function isExpandable(v)
	local t = type(v)
	if t == 'table' then
		return next(v) ~= nil or rawgetmetatable(v) ~= nil
	elseif t == 'function' then
		return true
	elseif t == 'userdata' then
		return rawgetmetatable(v) ~= nil
	end
	return false
end

local PAGE_THRESHOLD = 200 -- tables with a larger array part are shown in pages

local function makeVar(name, value)
	local var = { name = name, type = type(value), value = formatValue(value) }
	if isExpandable(value) then
		var.ref = newRef({ kind = 'value', value = value })
		if type(value) == 'table' and #value > PAGE_THRESHOLD then
			-- VS Code then asks for the array part in pages (filter 'indexed').
			local total = 0
			for _ in next, value do
				total = total + 1
			end
			var.indexed = #value
			var.named = total - #value
		end
	end
	return var
end

--- Snapshot of a frame's locals and upvalues: name -> { value, index[, func] }.
local function frameScope(tid, k)
	local locals, upvalues = {}, {}
	for i = 1, 1000 do
		local name, value = fGetlocal(tid, k, i)
		if name == nil then
			break
		end
		if strsub(name, 1, 1) ~= '(' then
			locals[name] = { value = value, index = i } -- later locals shadow earlier ones
		end
	end
	local info = fGetinfo(tid, k, 'f')
	if info and info.func then
		for i = 1, 1000 do
			local name, value = getupvalue(info.func, i)
			if name == nil then
				break
			end
			upvalues[name] = { value = value, index = i, func = info.func }
		end
	end
	return locals, upvalues
end

--- Compiles and runs an expression or statement in a frame's context.
-- Assignments to locals are returned in `assigned` and applied by the caller
-- (only the caller knows the right stack level).
local function evaluate(expr, tid, k)
	local locals, upvalues = {}, {}
	if tid then
		locals, upvalues = frameScope(tid, k)
	end
	local assigned = {}
	local envMeta = {
		__index = function(_, name)
			local l = locals[name]
			if l then
				return l.value
			end
			local u = upvalues[name]
			if u then
				return u.value
			end
			return ENV[name]
		end,
		__newindex = function(_, name, value)
			local l = locals[name]
			if l then
				l.value = value
				assigned[#assigned + 1] = { local_index = l.index, value = value }
				return
			end
			local u = upvalues[name]
			if u then
				u.value = value
				setupvalue(u.func, u.index, value)
				return
			end
			ENV[name] = value
		end,
	}
	local fenv = setmetatable({}, envMeta)
	local fn, err = loadstring('return ' .. expr, '=eval')
	if not fn then
		fn, err = loadstring(expr, '=eval')
	end
	if not fn then
		return false, (tostring(err):gsub('^eval:%d+: ', ''))
	end
	if setfenv then
		setfenv(fn, fenv)
	end
	local result = pack(pcall(fn))
	if not result[1] then
		return false, (tostring(result[2]):gsub('^eval:%d+: ', ''))
	end
	return true, result, assigned
end

local function applyAssignments(tid, k, assigned)
	for _, a in ipairs(assigned or {}) do
		fSetlocal(tid, k, a.local_index, a.value)
	end
end

local function evalResult(result)
	local var = makeVar('', result[2])
	local value = var.value
	if result.n > 2 then
		local parts = {}
		for i = 2, result.n do
			parts[#parts + 1] = formatValue(result[i])
		end
		value = table.concat(parts, ', ')
	end
	return { value = value, type = var.type, ref = var.ref, indexed = var.indexed, named = var.named }
end

--------------------------------------------------------------------------------
-- stopping
--------------------------------------------------------------------------------

local handlers = {}
local resumeCommands = { ['continue'] = true, step = true, disconnect = true }

local function dispatch(msg, stopped)
	if msg.type ~= 'req' then
		return nil
	end
	local fn = handlers[msg.cmd]
	if not fn then
		respond(msg, false, 'unknown command: ' .. tostring(msg.cmd))
		return nil
	end
	if not stopped and stopCtx == nil and fn.needsStop then
		respond(msg, false, 'the game is not paused')
		return nil
	end
	local ok, body = pcall(fn.run, msg.args or {}, msg)
	respond(msg, ok, body)
	if ok and resumeCommands[msg.cmd] then
		return 'resume'
	end
	return nil
end

local function collectThreads()
	local threads = { [1] = coroutine.running() or false }
	local id = 2
	for co in pairs(coroutines) do
		if coroutine.status(co) == 'suspended' and getinfo(co, 0, 'l') then
			threads[id] = co
			id = id + 1
		end
	end
	return threads
end

local function sessionStillValid()
	local s = readSession()
	return s ~= nil and s.nonce == T.nonce
end

--- Busy waits (Lua 5.1 in the game has no sleep); used to read files less often.
local function spin(seconds)
	local t = clock() + seconds
	while clock() < t do
	end
end

-- Heartbeat: VS Code rewrites tw_lua_debugger/alive every 250 ms. If it stops
-- changing, VS Code is gone (crashed, killed) and we must not keep the game
-- waiting for it. os.clock, not os.time: in the game os.time stands still.
local function readAlive()
	return readWholeFile(COMM_DIR .. 'alive')
end

--- Seconds since the heartbeat last changed.
local function heartbeatAge()
	local v = readAlive()
	local now = clock()
	if v and v ~= '' and v ~= T.aliveValue then
		T.aliveValue, T.aliveSeenAt = v, now
	end
	return now - (T.aliveSeenAt or now)
end

--- Whether VS Code is really there: its heartbeat must change within ALIVE_CONNECT_WAIT.
local function adapterAlive()
	local first = readAlive()
	local deadline = clock() + ALIVE_CONNECT_WAIT
	while clock() < deadline do
		spin(0.02)
		local v = readAlive()
		if v and v ~= '' then
			if first and first ~= '' and v ~= first then
				return true
			end
			first = first and first ~= '' and first or v
		end
	end
	return false
end

local function debugLoop()
	local lastCheck = clock()
	local idleSince = clock()
	while T.connected do
		local msg = recv()
		if msg then
			idleSince = clock()
			if dispatch(msg, true) == 'resume' then
				if T.pendingDisconnect then
					finishDisconnect()
				end
				return
			end
		else
			if clock() - lastCheck > SESSION_CHECK_INTERVAL then
				lastCheck = clock()
				if not sessionStillValid() or heartbeatAge() > ALIVE_TIMEOUT_STOPPED then
					-- VS Code is gone: let the game run on rather than freeze it forever.
					dlog('debugLoop: debugger gone; resuming the game')
					T.failedNonce = T.nonce
					closeTransport()
					clearDebugState()
					return
				end
			end
			-- Answer quickly right after activity; when idle, read less often.
			if clock() - idleSince > 0.1 then
				spin(0.005)
			end
		end
	end
end

--- Blocks the game until VS Code resumes it. `userHeight` is the height of
-- the frame the user should see on top.
local function stop(reason, userHeight, text)
	if inDebugger or not T.connected then
		return
	end
	inDebugger = true
	local savedHeight = ctxHeight
	ctxHeight = userHeight
	stepMode = nil
	pausePending = false
	refs, nextRef = {}, 1
	stopCtx = { threads = collectThreads(), height = userHeight }

	local details
	if reason == 'exception' and debug.traceback then
		-- frameLevel(0) is the user frame, relative to this function.
		details = debug.traceback('', frameLevel(0))
	end
	sendEvent('stopped', { reason = reason, thread = 1, text = text, details = details })
	local ok, err = pcall(debugLoop)
	if not ok then
		sendEvent('output', { category = 'stderr', output = 'debuggee error: ' .. tostring(err) .. '\n' })
	end

	stopCtx = nil
	refs, nextRef = {}, 1
	ctxHeight = savedHeight
	inDebugger = false
	updateHook()
end

local function hitConditionMet(cond, hits)
	local op, n = cond:match('^%s*([<>=%%]*)%s*(%d+)%s*$')
	n = tonumber(n)
	if not n then
		return true
	end
	if op == '' or op == '>=' then
		return hits >= n
	elseif op == '>' then
		return hits > n
	elseif op == '==' or op == '=' then
		return hits == n
	elseif op == '<' then
		return hits < n
	elseif op == '<=' then
		return hits <= n
	elseif op == '%' then
		return hits % n == 0
	end
	return true
end

local function interpolate(message)
	return (message:gsub('{(.-)}', function(expr)
		local ok, result = evaluate(expr, 1, 0)
		if ok then
			local parts = {}
			for i = 2, result.n do
				local v = result[i]
				parts[#parts + 1] = type(v) == 'string' and v or formatValue(v)
			end
			return table.concat(parts, ', ')
		end
		return '{' .. tostring(result) .. '}'
	end))
end

--- Decides whether a breakpoint stops. Runs with ctxHeight pointing at the user frame.
local function checkBreakpoint(bp, source, line)
	bp.hits = bp.hits + 1
	if bp.condition and bp.condition ~= '' then
		local ok, result = evaluate(bp.condition, 1, 0)
		if not ok then
			sendEvent('output', { category = 'stderr',
				output = 'Breakpoint condition error (' .. bp.condition .. '): ' .. tostring(result) .. '\n' })
			return true
		end
		if not result[2] then
			return false
		end
	end
	if bp.hitCondition and bp.hitCondition ~= '' and not hitConditionMet(bp.hitCondition, bp.hits) then
		return false
	end
	if bp.logMessage and bp.logMessage ~= '' then
		sendEvent('output', { category = 'stdout', output = interpolate(bp.logMessage) .. '\n',
			chunk = chunkName(source), line = line })
		return false
	end
	return true
end

local profileSample -- forward (SDK tools)

hook = function(event, line)
	if event == 'count' then
		if not inDebugger then
			profileSample()
		end
		return
	end
	if not lineFilter[line] or inDebugger then
		return
	end
	local info = getinfo(2, 'S')
	if not info or isInternal(info.source) then
		return
	end
	local userHeight = height() - 1

	-- Note: no tail calls to stop(); they would change the stack levels.
	if pausePending then
		stop('pause', userHeight)
		return
	end
	if stepMode then
		if stepMode == 'in'
			or (stepMode == 'over' and userHeight <= stepHeight)
			or (stepMode == 'out' and userHeight < stepHeight) then
			stop('step', userHeight)
			return
		end
	end
	if bpLines[line] then
		local key = resolveKey(info.source)
		local lines = key and bpByKey[key]
		local bp = lines and lines[line]
		if bp then
			inDebugger = true
			local savedHeight = ctxHeight
			ctxHeight = userHeight
			local ok, shouldStop = pcall(checkBreakpoint, bp, info.source, line)
			ctxHeight = savedHeight
			inDebugger = false
			if not ok or shouldStop then
				stop('breakpoint', userHeight)
			end
		end
	end
end

--------------------------------------------------------------------------------
-- request handlers
--------------------------------------------------------------------------------

local function handler(needsStop, run)
	return { needsStop = needsStop, run = run }
end

handlers.welcome = handler(false, function(args)
	bpByKey = {}
	for key, list in pairs(args.breakpoints or {}) do
		setBreakpoints(key, list)
	end
	rebuildLineIndex()
	exceptionFilters = {}
	for _, f in ipairs(args.exceptionFilters or {}) do
		exceptionFilters[f] = true
	end
	captureOutput = args.captureOutput and true or false
	updateHook()
	return {}
end)

handlers.setBreakpoints = handler(false, function(args)
	setBreakpoints(args.key or '', args.breakpoints)
	rebuildLineIndex()
	updateHook()
	return {}
end)

handlers.setExceptionFilters = handler(false, function(args)
	exceptionFilters = {}
	for _, f in ipairs(args.filters or {}) do
		exceptionFilters[f] = true
	end
	return {}
end)

handlers.pause = handler(false, function()
	if not inDebugger then
		pausePending = true
		pauseRequestedAt = clock()
		updateHook()
	end
	return {}
end)

handlers['continue'] = handler(true, function()
	stepMode = nil
	return {}
end)

handlers.step = handler(true, function(args)
	-- stop() clears stepMode on entry; set it for when we resume.
	stepMode = args.kind == 'in' and 'in' or args.kind == 'out' and 'out' or 'over'
	stepHeight = stopCtx.height
	return {}
end)

handlers.disconnect = handler(false, function()
	-- Answered before the transport closes; see poll/debugLoop.
	T.pendingDisconnect = true
	return {}
end)

handlers.threads = handler(false, function()
	if not stopCtx then
		return { { id = 1, name = 'main' } }
	end
	local list = {}
	for id, co in pairs(stopCtx.threads) do
		local name
		if id == 1 then
			name = co and ('coroutine (stopped) ' .. safeToString(co):gsub('^thread: ', '')) or 'main'
		else
			name = 'coroutine ' .. safeToString(co):gsub('^thread: ', '')
		end
		list[#list + 1] = { id = id, name = name }
	end
	table.sort(list, function(a, b) return a.id < b.id end)
	return list
end)

handlers.stack = handler(true, function(args)
	local tid = args.thread or 1
	local start = args.start or 0
	local levels = (args.levels and args.levels > 0) and args.levels or 1000
	local frames = {}
	local k = start
	while #frames < levels do
		local info = fGetinfo(tid, k, 'nSl')
		if not info then
			break
		end
		local file = (info.what == 'Lua' or info.what == 'main') and chunkName(info.source) or nil
		local name = info.name
		if info.what == 'tail' then
			name = '(tail call)'
		elseif not name or name == '' then
			if info.what == 'main' then
				name = 'main chunk'
			elseif info.what == 'C' then
				name = '[C]'
			else
				-- Called from the game (or pcall): Lua knows no name, show where it is defined.
				local src = file and file:match('[^/\\]+$') or info.short_src or '?'
				name = 'function ' .. src .. ':' .. tostring(info.linedefined or 0)
			end
		end
		frames[#frames + 1] = {
			id = encodeFrameId(tid, k),
			name = name,
			chunk = file,
			line = (info.currentline and info.currentline > 0) and info.currentline or 0,
			what = info.what,
		}
		k = k + 1
	end
	local total = k
	if #frames == levels then
		while fGetinfo(tid, total, 'l') do
			total = total + 1
		end
	end
	return { frames = frames, total = total }
end)

handlers.scopes = handler(true, function(args)
	local tid, k = decodeFrameId(args.frame)
	return {
		{ name = 'Locals', ref = newRef({ kind = 'locals', tid = tid, k = k }) },
		{ name = 'Upvalues', ref = newRef({ kind = 'upvalues', tid = tid, k = k }) },
		{ name = 'Globals', ref = newRef({ kind = 'globals' }), expensive = true },
	}
end)

local function sortVars(vars)
	table.sort(vars, function(a, b)
		local an = tonumber(a.name:match('^%[(%-?[%d%.]+)%]$'))
		local bn = tonumber(b.name:match('^%[(%-?[%d%.]+)%]$'))
		if an and bn then
			return an < bn
		elseif an or bn then
			return an ~= nil
		end
		return a.name < b.name
	end)
end

--- Lists the children of a variables reference; also records how to assign each one.
-- For paged tables, `filter` is 'indexed' (array part, from `start`, `count`
-- items) or 'named' (everything else).
local function listVariables(entry, filter, start, count)
	local vars, setters, seen = {}, {}, {}
	local function add(name, value, setter)
		if seen[name] then
			seen[name] = seen[name] + 1
			name = name .. ' (' .. seen[name] .. ')'
		else
			seen[name] = 1
		end
		vars[#vars + 1] = makeVar(name, value)
		setters[name] = setter
	end

	if entry.kind == 'locals' then
		for i = 1, 1000 do
			local name, value = fGetlocal(entry.tid, entry.k, i)
			if name == nil then
				break
			end
			if strsub(name, 1, 1) ~= '(' then
				add(name, value, { kind = 'local', index = i, tid = entry.tid, k = entry.k })
			end
		end
	elseif entry.kind == 'upvalues' then
		local info = fGetinfo(entry.tid, entry.k, 'f')
		if info and info.func then
			for i = 1, 1000 do
				local name, value = getupvalue(info.func, i)
				if name == nil then
					break
				end
				add(name, value, { kind = 'upvalue', func = info.func, index = i })
			end
		end
	elseif entry.kind == 'globals' then
		for name, value in next, ENV do
			add(keyToName(name), value, { kind = 'table', tbl = ENV, key = name })
		end
		sortVars(vars)
	elseif entry.kind == 'value' then
		local v = entry.value
		local t = type(v)
		if t == 'table' and filter == 'indexed' then
			local first = (start or 0) + 1
			local last = math.min(#v, first + ((count and count > 0) and count or #v) - 1)
			for i = first, last do
				add('[' .. i .. ']', rawget(v, i), { kind = 'table', tbl = v, key = i })
			end
		elseif t == 'table' then
			local n = filter == 'named' and #v or 0
			local listed = 0
			for key, value in next, v do
				local inArray = type(key) == 'number' and key >= 1 and key <= n and key % 1 == 0
				if not inArray then
					listed = listed + 1
					if listed > 5000 then
						vars[#vars + 1] = { name = '...', type = 'string', value = 'more than 5000 entries' }
						break
					end
					add(keyToName(key), value, { kind = 'table', tbl = v, key = key })
				end
			end
			sortVars(vars)
		elseif t == 'function' then
			local info = getinfo(v, 'S')
			if info then
				add('(source)', info.short_src or '?')
				add('(line)', info.linedefined or 0)
			end
			for i = 1, 1000 do
				local name, value = getupvalue(v, i)
				if name == nil then
					break
				end
				add(name, value, { kind = 'upvalue', func = v, index = i })
			end
		end
		if t == 'table' or t == 'userdata' then
			local mt = rawgetmetatable(v)
			if mt then
				add('(metatable)', mt)
			end
		end
	end
	entry.setters = setters
	return vars
end

handlers.vars = handler(false, function(args)
	local entry = refs[args.ref]
	if not entry then
		return {}
	end
	local start, count = args.start or 0, args.count or 0
	local vars = listVariables(entry, args.filter, start, count)
	if args.filter ~= 'indexed' and (start > 0 or count > 0) then
		local sliced = {}
		local last = count > 0 and math.min(#vars, start + count) or #vars
		for i = start + 1, last do
			sliced[#sliced + 1] = vars[i]
		end
		vars = sliced
	end
	return vars
end)

--- Debug Console completions for the identifier (or a.b.c / obj:meth chain)
-- before the cursor: locals, upvalues and globals, or the fields and methods of
-- what precedes the last '.' or ':' (including __index tables of metatables,
-- which is where the game's interfaces keep their methods).
handlers.complete = handler(false, function(args)
	local expr = (args.text or ''):match('[%w_%.:]*$') or ''
	local base, sep, partial = expr:match('^(.-)([%.:])([%w_]*)$')
	if not base then
		partial = expr
	end
	local tid, k
	if args.frame and stopCtx then
		tid, k = decodeFrameId(args.frame)
	end

	local items, seen = {}, {}
	local function add(name, value, kind)
		if type(name) == 'string' and not seen[name] and name:match('^[%a_][%w_]*$')
			and strsub(name, 1, #partial) == partial and (sep ~= ':' or type(value) == 'function') then
			seen[name] = true
			items[#items + 1] = { label = name, type = type(value) == 'function' and 'function' or kind }
		end
	end
	local function addFields(t, depth)
		if type(t) ~= 'table' or depth > 3 then
			return
		end
		for key, value in next, t do
			add(key, value, 'property')
		end
		local mt = rawgetmetatable(t)
		if type(mt) == 'table' then
			addFields(rawget(mt, '__index'), depth + 1)
		end
	end

	if base and base ~= '' then
		local savedIn = inDebugger
		inDebugger = true
		local ok, result = evaluate(base, tid, k)
		inDebugger = savedIn
		local value = ok and result[2]
		if type(value) == 'table' then
			addFields(value, 0)
		elseif type(value) == 'userdata' then
			local mt = rawgetmetatable(value)
			if type(mt) == 'table' then
				addFields(rawget(mt, '__index'), 0)
			end
		end
	else
		if tid then
			local locals, upvalues = frameScope(tid, k)
			for name, l in pairs(locals) do
				add(name, l.value, 'variable')
			end
			for name, u in pairs(upvalues) do
				add(name, u.value, 'variable')
			end
		end
		addFields(ENV, 0)
		addFields(_G, 0)
	end
	table.sort(items, function(a, b) return a.label < b.label end)
	while #items > 500 do
		items[#items] = nil
	end
	return items
end)

--- Script files the game has loaded, as far as package.loaded tells
-- (the game's loader records scripts there by module name).
handlers.sources = handler(false, function()
	local list = {}
	if type(package) ~= 'table' or type(package.loaded) ~= 'table' then
		return list
	end
	for name in pairs(package.loaded) do
		if type(name) == 'string' and name:match('^script[%./\\]') then
			local path = name:gsub('[%./\\]', '/'):gsub('/lua$', '')
			list[#list + 1] = path .. '.lua'
		end
	end
	table.sort(list)
	return list
end)

handlers.setVar = handler(true, function(args)
	local entry = refs[args.ref]
	if not entry then
		rawError('variable is no longer available', 0)
	end
	if not entry.setters then
		listVariables(entry)
	end
	local setter = entry.setters[args.name]
	if not setter then
		rawError('this value cannot be changed', 0)
	end
	local tid, k = entry.tid or 1, entry.k or 0
	local ok, result, assigned = evaluate(args.value, tid, k)
	if not ok then
		rawError(result, 0)
	end
	applyAssignments(tid, k, assigned)
	local value = result[2]
	if setter.kind == 'local' then
		fSetlocal(setter.tid, setter.k, setter.index, value)
	elseif setter.kind == 'upvalue' then
		setupvalue(setter.func, setter.index, value)
	elseif setter.kind == 'table' then
		setter.tbl[setter.key] = value
	end
	local var = makeVar(args.name, value)
	return { value = var.value, type = var.type, ref = var.ref }
end)

handlers.eval = handler(false, function(args)
	local tid, k
	if args.frame and stopCtx then
		tid, k = decodeFrameId(args.frame)
	end
	local savedIn = inDebugger
	inDebugger = true
	local ok, result, assigned = evaluate(args.expr or '', tid, k)
	inDebugger = savedIn
	if not ok then
		rawError(result, 0)
	end
	if tid then
		applyAssignments(tid, k, assigned)
	end
	return evalResult(result)
end)

--------------------------------------------------------------------------------
-- SDK tools: running code, the event monitor and the profiler
--------------------------------------------------------------------------------

local MAX_PLAIN_ENTRIES = 2000

--- A JSON-safe copy of a value: tables (depth-limited) with string keys or as
-- arrays, everything else that JSON cannot hold as its text.
local function plain(v, depth)
	local t = type(v)
	depth = depth or 0
	if t == 'nil' or t == 'boolean' or t == 'string' then
		return v
	elseif t == 'number' then
		if v ~= v or v == math.huge or v == -math.huge then
			return tostring(v)
		end
		return v
	elseif t == 'table' and depth < 6 then
		local out = {}
		local n = #v
		if n > 0 then
			for i = 1, math.min(n, MAX_PLAIN_ENTRIES) do
				local x = plain(v[i], depth + 1)
				if x == nil then
					x = false
				end
				out[i] = x
			end
			return out
		end
		local count = 0
		for k, x in pairs(v) do
			count = count + 1
			if count > MAX_PLAIN_ENTRIES then
				break
			end
			out[type(k) == 'string' and k or ('[' .. safeToString(k) .. ']')] = plain(x, depth + 1)
		end
		return out
	end
	return safeToString(v)
end

--- Runs Lua code in the scripts' environment; returns its first result, JSON-safe.
-- `chunk` names the code like a script file (so a re-run file keeps its breakpoints).
handlers.run = handler(false, function(args)
	local fn, err = loadstring(args.code or '', args.chunk or '=run')
	if not fn then
		rawError(tostring(err), 0)
	end
	if setfenv then
		setfenv(fn, ENV)
	end
	-- Breakpoints don't stop inside code run from VS Code (the game waits for the answer).
	local savedIn = inDebugger
	inDebugger = true
	local result = pack(pcall(fn))
	inDebugger = savedIn
	if not result[1] then
		rawError(tostring(result[2]), 0)
	end
	return { value = plain(result[2]) }
end)

-- Event monitor: script events as they reach core's listeners.
local MONITOR_MAX_PER_SECOND = 200

-- Interesting facts of an event context, from getters most contexts have.
local CONTEXT_GETTERS = {
	{ 'faction', 'name' },
	{ 'character', 'command_queue_index' },
	{ 'region', 'name' },
	{ 'military_force', 'command_queue_index' },
	{ 'garrison_residence', 'command_queue_index' },
	{ 'building', 'name' },
	{ 'dilemma', nil },
	{ 'mission', nil },
}

local function contextSummary(context)
	local summary = {}
	if type(context) == 'table' and type(context.string) == 'string' then
		summary.string = context.string
	elseif type(context) == 'userdata' then
		local ok, s = pcall(function() return context.string end)
		if ok and type(s) == 'string' then
			summary.string = s
		end
	end
	for _, g in ipairs(CONTEXT_GETTERS) do
		local ok, value = pcall(function()
			local method = context[g[1]]
			if type(method) ~= 'function' then
				return nil
			end
			local obj = method(context)
			if obj == nil then
				return nil
			end
			if type(obj) ~= 'userdata' and type(obj) ~= 'table' then
				return obj
			end
			if obj.is_null_interface and obj:is_null_interface() then
				return nil
			end
			return g[2] and obj[g[2]](obj) or nil
		end)
		if ok and value ~= nil then
			summary[g[1]] = plain(value)
		end
	end
	return summary
end

local function monitorRecord(eventname, context)
	local now = clock()
	if now - monitor.windowStart >= 1 then
		if monitor.dropped > 0 then
			pcall(sendEvent, 'scriptEvent', { name = '(dropped)', count = monitor.dropped, time = now })
		end
		monitor.windowStart, monitor.inWindow, monitor.dropped = now, 0, 0
	end
	monitor.inWindow = monitor.inWindow + 1
	if monitor.inWindow > MONITOR_MAX_PER_SECOND then
		monitor.dropped = monitor.dropped + 1
		return
	end
	local ok, summary = pcall(contextSummary, context)
	pcall(sendEvent, 'scriptEvent', { name = tostring(eventname), time = now, context = ok and summary or nil })
end

--- (Re)installs the monitor's wrapper of core:event_callback when the monitor is on.
local function applyMonitor()
	local core = ENV.core
	if type(core) ~= 'table' or type(core.event_callback) ~= 'function' then
		return
	end
	if monitor.on then
		if core.event_callback ~= monitor.wrapper then
			local original = core.event_callback
			monitor.original = original
			monitor.wrapper = function(self, eventname, context)
				if monitor.on and T.connected and not inDebugger then
					monitorRecord(eventname, context)
				end
				return original(self, eventname, context)
			end
			core.event_callback = monitor.wrapper
		end
	elseif monitor.wrapper and core.event_callback == monitor.wrapper then
		-- Back to the class method (or whatever was there before).
		if rawget(core, 'event_callback') == monitor.wrapper then
			core.event_callback = nil
			if core.event_callback == nil then
				core.event_callback = monitor.original
			end
		end
		monitor.wrapper, monitor.original = nil, nil
	end
end

handlers.monitorEvents = handler(false, function(args)
	monitor.on = args.on and true or false
	applyMonitor()
	return { on = monitor.on, available = type(ENV.core) == 'table' }
end)

-- Profiler: call stacks sampled every `interval` VM instructions, folded as
-- "outer;...;inner" lines (the flame graph format).
local MAX_STACK = 40
local MAX_DISTINCT = 20000

profileSample = function()
	local frames = {}
	local level = 3 -- 1 this function, 2 the hook
	while #frames < MAX_STACK do
		local info = getinfo(level, 'Sn')
		if not info then
			break
		end
		if info.what ~= 'C' and not isInternal(info.source) then
			local file = chunkName(info.source) or info.short_src or '?'
			frames[#frames + 1] = (info.name or '?') .. ' (' .. file .. ':' .. tostring(info.linedefined or 0) .. ')'
		elseif info.what == 'C' and info.name then
			frames[#frames + 1] = info.name .. ' [C]'
		end
		level = level + 1
	end
	if #frames == 0 then
		return
	end
	-- Outermost first.
	local n = #frames
	for i = 1, math.floor(n / 2) do
		frames[i], frames[n - i + 1] = frames[n - i + 1], frames[i]
	end
	local key = table.concat(frames, ';')
	local count = profiler.samples[key]
	if count then
		profiler.samples[key] = count + 1
	elseif profiler.distinct < MAX_DISTINCT then
		profiler.samples[key] = 1
		profiler.distinct = profiler.distinct + 1
	end
	profiler.total = profiler.total + 1
end

handlers.profileStart = handler(false, function(args)
	profiler.on = true
	profiler.interval = math.max(100, tonumber(args.interval) or 5000)
	profiler.samples, profiler.distinct, profiler.total, profiler.started = {}, 0, 0, clock()
	mainHookDirty = true
	updateHook()
	return { interval = profiler.interval }
end)

handlers.profileStop = handler(false, function()
	local list = {}
	for stack, count in pairs(profiler.samples) do
		list[#list + 1] = { s = stack, n = count }
	end
	table.sort(list, function(a, b) return a.n > b.n end)
	local result = { samples = list, total = profiler.total, seconds = clock() - profiler.started, interval = profiler.interval }
	profiler.on = false
	profiler.samples, profiler.distinct = {}, 0
	mainHookDirty = true
	updateHook()
	return result
end)

--------------------------------------------------------------------------------
-- connection
--------------------------------------------------------------------------------

local function detectEnv()
	if type(__game_mode) == 'number' then
		if __game_mode == __lib_type_campaign then
			return 'campaign'
		elseif __game_mode == __lib_type_battle then
			return 'battle'
		elseif __game_mode == __lib_type_frontend then
			return 'frontend'
		end
	end
	if cm then
		return 'campaign'
	elseif bm then
		return 'battle'
	end
	return 'unknown'
end

finishDisconnect = function()
	T.pendingDisconnect = false
	closeTransport()
	clearDebugState()
end

--- Size of a file in bytes, or 0 when it cannot be opened.
local function fileSize(path)
	local f = io.open(path, 'rb')
	if not f then
		return 0
	end
	local size = f:seek('end')
	f:close()
	return size or 0
end

local function connect(session)
	closeTransport()
	-- The communication files only grow. A new Lua state starts them over once
	-- they are large: nothing in them is still needed, and the adapter notices
	-- a file got shorter and reads it from the start. The threshold makes sure
	-- the new content cannot outgrow the adapter's old read position before it
	-- polls again.
	local rotateBytes = tonumber(TWDBG_ROTATE_BYTES) or ROTATE_BYTES
	local inSize = fileSize(COMM_DIR .. 'to_game')
	if inSize > rotateBytes then
		local f = io.open(COMM_DIR .. 'to_game', 'wb')
		if f then
			f:close()
			inSize = 0
		end
	end
	local outMode = fileSize(COMM_DIR .. 'from_game') > rotateBytes and 'wb' or 'ab'
	local outFile = io.open(COMM_DIR .. 'from_game', outMode)
	if not outFile then
		return false
	end
	T.outFile = outFile
	if session.log and not T.logFile then
		T.logFile = io.open(COMM_DIR .. 'debuggee.log', 'ab')
	end
	-- Anything already in to_game was meant for an earlier Lua state.
	T.inOffset = inSize
	dlog('connect: env', env, 'to_game offset', T.inOffset, _VERSION)
	T.inBuf, T.queue = '', {}
	T.nonce = session.nonce
	T.aliveValue, T.aliveSeenAt = nil, clock()
	T.connected = true
	T.id = tostring(os.time()) .. '-' .. tostring(clock()) .. '-' .. tostring({}):gsub('^table: ', '')

	sendEvent('hello', {
		protocol = PROTOCOL, nonce = session.nonce, env = env, id = T.id,
		lua = _VERSION, mod = MOD_VERSION,
	})

	-- os.clock, not os.time: in the game os.time stands still.
	local deadline = clock() + WELCOME_TIMEOUT
	local iterations = 0
	while clock() < deadline do
		iterations = iterations + 1
		if iterations <= 3 or iterations % 20000 == 0 then
			dlog('connect: waiting for welcome, iteration', iterations, 'buffered', #T.inBuf, 'queued', #T.queue)
		end
		local msg = recv()
		if msg then
			dlog('connect: received', msg.cmd)
			local isWelcome = msg.cmd == 'welcome'
			dispatch(msg, false)
			if isWelcome then
				installWrappers()
				return true
			end
			if T.pendingDisconnect then
				finishDisconnect()
				return false
			end
		end
	end
	-- VS Code did not answer: the session file is probably stale.
	dlog('connect: no welcome after', iterations, 'iterations; giving up')
	T.failedNonce = session.nonce
	closeTransport()
	return false
end

local function checkSession()
	local s = readSession()
	if T.connected then
		if not s or s.nonce ~= T.nonce then
			closeTransport()
			clearDebugState()
		elseif heartbeatAge() > ALIVE_TIMEOUT_RUNNING then
			dlog('checkSession: heartbeat stopped; detaching')
			T.failedNonce = T.nonce
			closeTransport()
			clearDebugState()
		end
	end
	if not T.connected and s and s.protocol == PROTOCOL and s.nonce and s.nonce ~= T.failedNonce then
		if adapterAlive() then
			connect(s)
		else
			-- Left behind by a VS Code that is no longer running.
			T.failedNonce = s.nonce
		end
	end
end

--------------------------------------------------------------------------------
-- output capture and error hooks
--------------------------------------------------------------------------------

local function argsToString(...)
	local n = select('#', ...)
	local t = {}
	for i = 1, n do
		t[i] = safeToString((select(i, ...)))
	end
	return table.concat(t, '\t')
end

local function mirror(category, ...)
	if captureOutput and T.connected and not inDebugger then
		inDebugger = true
		pcall(sendEvent, 'output', { category = category, output = argsToString(...) .. '\n' })
		inDebugger = false
	end
end

-- Our wrappers and the functions they replaced. Wrappers are re-applied when
-- the game's libraries replace a function again (the battle manager, for
-- example, redefines script_error), and removed when the debugger detaches.
local wrappers = {}
local originals = {}

local function wrapOutputFunctions()
	if type(print) == 'function' and print ~= wrappers.print then
		local original = print
		originals.print = original
		wrappers.print = function(...)
			mirror('stdout', ...)
			return original(...)
		end
		print = wrappers.print
	end
	if type(out) == 'function' and out ~= wrappers.out then
		local original = out
		originals.out = original
		wrappers.out = function(...)
			mirror('stdout', ...)
			return original(...)
		end
		out = wrappers.out
	elseif type(out) == 'table' then
		-- The game's out is a table of channels (out.design, out.ui, ...) callable through __call.
		local mt = getmetatable(out)
		if type(mt) == 'table' and type(rawget(mt, '__call')) == 'function' and mt.__call ~= wrappers.outCall then
			local original = mt.__call
			originals.outCall, originals.outMeta = original, mt
			wrappers.outCall = function(self, ...)
				mirror('stdout', ...)
				return original(self, ...)
			end
			mt.__call = wrappers.outCall
		end
	end
end

local function wrapErrorFunctions()
	if type(error) == 'function' and error ~= wrappers.error then
		local original = error
		originals.error = original
		wrappers.error = function(msg, level)
			if exceptionFilters.error and T.connected and not inDebugger then
				stop('exception', height() - 1, 'error(): ' .. safeToString(msg))
			end
			level = level or 1
			if level > 0 then
				level = level + 1
			end
			original(msg, level) -- not a tail call: keeps the level correct
		end
		error = wrappers.error
	end
	if type(script_error) == 'function' and script_error ~= wrappers.script_error then
		local original = script_error
		originals.script_error = original
		wrappers.script_error = function(msg, ...)
			if T.connected and not inDebugger
				and (exceptionFilters.script_error or (exceptionFilters.script_error_mod and modScriptOnStack())) then
				stop('exception', height() - 1, 'script_error: ' .. safeToString(msg))
			end
			return original(msg, ...)
		end
		script_error = wrappers.script_error
	end
end

--------------------------------------------------------------------------------
-- coroutines
--------------------------------------------------------------------------------

-- Coroutines are tracked so hooks can be set on them; only those created while
-- the debugger is attached are known (Lua 5.1 cannot enumerate threads).
local cocreate, coresume = coroutine.create, coroutine.resume

wrappers.cocreate = function(f)
	local co = cocreate(f)
	coroutines[co] = true
	if hookActive then
		hookThread(co, needHook(), T.connected and profiler.on)
	end
	return co
end

wrappers.cowrap = function(f)
	local co = wrappers.cocreate(f)
	return function(...)
		local r = pack(coresume(co, ...))
		if r[1] then
			return unpack(r, 2, r.n)
		end
		rawError(r[2], 0)
	end
end

wrappers.sethook = function() end

function M.addCoroutine(co)
	coroutines[co] = true
	updateHook()
end

installWrappers = function()
	if debug.sethook ~= wrappers.sethook then
		originals.sethook = debug.sethook
		debug.sethook = wrappers.sethook
	end
	if coroutine.create ~= wrappers.cocreate then
		originals.cocreate, originals.cowrap = coroutine.create, coroutine.wrap
		coroutine.create, coroutine.wrap = wrappers.cocreate, wrappers.cowrap
	end
	wrapOutputFunctions()
	wrapErrorFunctions()
end

--- Puts back what we replaced, unless someone else replaced our wrapper since.
removeWrappers = function()
	local function restore(tbl, key, wrapperKey)
		if wrappers[wrapperKey] and tbl[key] == wrappers[wrapperKey] then
			tbl[key] = originals[wrapperKey]
		end
	end
	restore(debug, 'sethook', 'sethook')
	restore(coroutine, 'create', 'cocreate')
	restore(coroutine, 'wrap', 'cowrap')
	restore(ENV, 'print', 'print')
	restore(ENV, 'out', 'out')
	restore(ENV, 'error', 'error')
	restore(ENV, 'script_error', 'script_error')
	if originals.outMeta then
		restore(originals.outMeta, '__call', 'outCall')
	end
	-- Function wrappers are rebuilt on the next connect; keep the static ones.
	wrappers.print, wrappers.out, wrappers.outCall, wrappers.error, wrappers.script_error = nil, nil, nil, nil, nil
	originals = {}
end

--------------------------------------------------------------------------------
-- public API
--------------------------------------------------------------------------------

--- Connects to VS Code if a debug session is active. Safe to call repeatedly.
-- `name` names the environment (frontend, campaign, battle); older bootstraps
-- passed the json library here, which is ignored.
function M.start(name)
	if type(name) == 'string' and name ~= env then
		env = name
		if T.connected then
			sendEvent('env', { env = env })
		end
	end
	if not json then
		return false
	end
	if not T.connected then
		T.lastSessionCheck = clock()
		checkSession()
	end
	return T.connected
end

--- Processes messages from VS Code. Call regularly (the bootstraps do every 50 ms).
function M.poll()
	if inDebugger or not json then
		return
	end
	local now = clock()
	if now - T.lastSessionCheck >= SESSION_CHECK_INTERVAL then
		T.lastSessionCheck = now
		if T.connected then
			-- The game's libraries may have replaced a wrapped function since.
			installWrappers()
			applyMonitor()
		end
		checkSession()
	end
	if not T.connected then
		return
	end
	local running = coroutine.running()
	if (mainHookDirty and running == nil) or (running and hookActive and not coroutines[running]) then
		updateHook()
	end
	while T.connected do
		local msg = recv()
		if not msg then
			break
		end
		dispatch(msg, false)
		if T.pendingDisconnect then
			finishDisconnect()
			return
		end
	end
	if pausePending and clock() - pauseRequestedAt > PAUSE_FALLBACK then
		-- No script line ran since the pause request; stop right here.
		stop('pause', height() - 1)
	end
end

--- Whether VS Code is connected.
function M.isConnected()
	return T.connected
end

--- Prints to the VS Code debug console. Categories: 'log', 'warning', 'error'.
function M.print(category, ...)
	if not T.connected then
		return false
	end
	local c = 'stdout'
	if category == 'warning' then
		c = 'console'
	elseif category == 'error' then
		c = 'stderr'
	end
	sendEvent('output', { category = c, output = argsToString(...) .. '\n' })
	return true
end

--- Stops in the debugger as if a breakpoint was hit at the caller.
function M.breakHere(text)
	if not T.connected then
		return false
	end
	stop('pause', height() - 1, text)
	return true
end

-- Backwards compatible name used by older scripts.
function M.enterDebugLoop(_, text)
	if not T.connected then
		return false
	end
	stop('pause', height() - 1, text)
	return true
end

env = detectEnv()
M.start()

return M

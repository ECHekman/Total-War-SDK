-- Fake Total War: runs the debuggee and a test script in a loop, like the game's
-- timers would. Usage:
--   lua51 run_game.lua <debuggee root> <fixtures root> <env> <ticks> [flags]
-- flags: 'fail'      script_error() is called on tick 5
--        'co'        run a coroutine every tick
--        'raise'     call error() (inside pcall) on tick 3
--        'tail'      call helper() through a tail call every tick
--        'vanillaerror' script_error() from outside a mod folder on tick 3
--        'rotate'    tiny size limit for the communication files
--        'bench'     time a busy loop every tick (line hook overhead)
--        'reconnect' after the ticks, simulate an environment switch to battle
--                    (fresh debuggee instance) and run the ticks again
--        'events'    a FactionTurnStart script event through core every tick
local debuggeeRoot, fixturesRoot, envName, ticks, flags = ...
ticks = tonumber(ticks) or 40
flags = flags or ''

-- Behave like Total War's Lua: string.find/sub/len are replaced by versions that
-- do not work like the standard ones (the originals are kept as *_lua), and
-- os.time does not advance.
local find, sub, len = string.find, string.sub, string.len
string.find_lua, string.sub_lua, string.len_lua = find, sub, len
string.find = function() end
string.sub = function(_, i, j) return tostring(j or i) end
string.len = function(s) return s, len(s) end
local frozenTime = os.time()
os.time = function() return frozenTime end

local function hasFlag(name)
	return find(flags, name, 1, true) ~= nil
end

package.path = debuggeeRoot .. '/?.lua;' .. package.path

-- Minimal stand-ins for the game's script library.
out = function(...)
	io.stdout:write('[out] ', table.concat({ ... }, ' '), '\n')
	io.stdout:flush()
end
script_error = function(msg)
	io.stdout:write('[script_error] ', tostring(msg), '\n')
	io.stdout:flush()
end
-- Like the game's core object: event_callback is a method of its class.
local core_object = {}
core_object.__index = core_object
function core_object:event_callback(eventname, context)
	self.handled = (self.handled or 0) + 1
end
core = setmetatable({}, core_object)
fail_on_five = hasFlag('fail')
if hasFlag('rotate') then
	TWDBG_ROTATE_BYTES = 300 -- start the communication files over on every reconnect
end

-- What a fresh Lua state would have; restored to simulate an environment switch.
local pristine = {
	sethook = debug.sethook, error = error, print = print, out = out,
	script_error = script_error, cocreate = coroutine.create, cowrap = coroutine.wrap,
}

-- 'bare': the chunk name Total War uses (a path without '@', backslashes)
local chunkName = hasFlag('noext') and '@script/campaign/mod/test_script'
	or hasFlag('bare') and 'script\\campaign\\mod\\test_script.lua'
	or '@script/campaign/mod/test_script.lua'

local function loadEnvironment(name)
	debug.sethook = pristine.sethook
	debug.sethook()
	error, print, out, script_error = pristine.error, pristine.print, pristine.out, pristine.script_error
	coroutine.create, coroutine.wrap = pristine.cocreate, pristine.cowrap
	debuggee = nil
	-- The game's script library sets these before mods are loaded.
	__lib_type_battle, __lib_type_campaign, __lib_type_frontend = 0, 1, 2
	__game_mode = name == 'battle' and 0 or name == 'campaign' and 1 or 2

	dofile(debuggeeRoot .. '/script/_lib/mod/vscode-debuggee.lua')
	debuggee.start(name)

	-- Load the test script with a chunk name like the game uses.
	local f = assert(io.open(fixturesRoot .. '/script/campaign/mod/test_script.lua', 'rb'))
	local code = f:read('*a')
	f:close()
	assert(loadstring(code, chunkName))()
end

local function sleep(seconds)
	local t = os.clock() + seconds
	while os.clock() < t do end
end

local function run()
	for i = 1, ticks do
		on_tick(i)
		if hasFlag('co') then
			run_coroutine()
		end
		if hasFlag('tail') then
			tail_caller(i + 100)
		end
		if hasFlag('bench') then
			local t = os.clock()
			local sum = 0
			for n = 1, 200000 do
				sum = sum + n % 7
				sum = sum - n % 3
			end
			out(string.format('bench %.1f ms', (os.clock() - t) * 1000))
			local function inc(x)
				return x + 1
			end
			t = os.clock()
			for n = 1, 200000 do
				sum = inc(sum) + math.floor(n / 2)
			end
			out(string.format('callbench %.1f ms', (os.clock() - t) * 1000))
		end
		if hasFlag('vanillaerror') and i == 3 then
			script_error('error reported by the game itself') -- caller is not in a mod folder
		end
		if hasFlag('events') then
			local faction = { name = function() return 'wh_main_emp_empire' end, is_null_interface = function() return false end }
			core:event_callback('FactionTurnStart', { faction = function() return faction end })
		end
		if hasFlag('raise') and i == 3 then
			pcall(raise, 'oops from raise')
		end
		debuggee.poll()
		sleep(0.05)
	end
end

-- Total War runs its scripts inside a coroutine, not on the main thread
-- ('mainthread' runs them on the main thread instead).
local function main()
	loadEnvironment(envName)
	run()
	if hasFlag('reconnect') then
		out('switching environment')
		loadEnvironment('battle')
		run()
	end

	-- Report whether the debuggee left the game's globals as it found them.
	local untouched = debug.sethook == pristine.sethook and error == pristine.error and print == pristine.print
		and out == pristine.out and script_error == pristine.script_error
		and coroutine.create == pristine.cocreate and coroutine.wrap == pristine.cowrap
	out('globals untouched: ' .. tostring(untouched))
	out('done', get_counter())
end

if hasFlag('mainthread') then
	main()
else
	local co = pristine.cocreate(main)
	local ok, err = coroutine.resume(co)
	if not ok then
		error(err, 0)
	end
end

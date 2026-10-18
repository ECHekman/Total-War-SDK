-- TW Lua Debugger: campaign bootstrap. Connects the debugger and polls VS Code.
if not debuggee then
	return
end

debuggee.start('campaign')

cm:add_pre_first_tick_callback(function()
	debuggee.poll()
	cm:repeat_real_callback(function()
		debuggee.poll()
	end, 50, 'TwLuaDebuggerPoll')
end)

-- Total War Modding Tools debugger: battle bootstrap. Connects the debugger and polls VS Code.
if not debuggee then
	return
end

debuggee.start('battle')

bm:register_phase_change_callback('Startup', function()
	bm:repeat_real_callback(function()
		debuggee.poll()
	end, 50, 'TwLuaDebuggerPoll')
end)

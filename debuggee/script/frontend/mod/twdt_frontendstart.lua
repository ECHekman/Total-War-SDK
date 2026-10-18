-- Total War Modding Tools debugger: frontend bootstrap. Connects the debugger and polls VS Code.
if not debuggee then
	return
end

debuggee.start('frontend')

core:add_ui_created_callback(function()
	tm:repeat_real_callback(function()
		debuggee.poll()
	end, 50, 'TwLuaDebuggerPoll')
end)

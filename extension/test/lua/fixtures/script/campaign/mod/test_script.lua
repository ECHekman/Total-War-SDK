-- Test script loaded by the fake game (run_game.lua). Line numbers are used by the tests.
local counter = 0
local data = { name = "karl", list = { 10, 20, 30 }, nested = { deep = true } }

local function helper(x)
	local doubled = x * 2
	return doubled
end

function on_tick(i)
	counter = counter + 1
	local result = helper(i)
	if i == 3 then
		debuggee.print('log', 'tick three')
	end
	if i == 5 and fail_on_five then
		script_error('boom at five')
	end
	if i == 6 and data.name ~= "karl" then
		out('name changed to ' .. data.name)
	end
	return result
end

function get_counter()
	return counter
end

function run_coroutine()
	local co = coroutine.create(function(a)
		local inside = a + 1
		coroutine.yield(inside)
		return inside * 2
	end)
	local _, v = coroutine.resume(co, 1)
	return v
end

function raise(msg)
	error(msg)
end

function tail_caller(x)
	return helper(x)
end

big_list = { extra = true }
for n = 1, 500 do
	big_list[n] = n * 2
end

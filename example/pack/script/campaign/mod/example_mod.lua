-- example_mod: a small campaign script to try the Total War Modding Tools debugger with.
--
-- Things to try (see README.md):
--   * a breakpoint in on_heartbeat is hit every 10 seconds on the campaign map
--   * a breakpoint in on_turn_start is hit when you end your turn
--   * step into describe_faction and look at the locals
--   * in the Debug Console: cm:model():turn_number(), faction_stats, cm:   (completions)

local mod_name = "example_mod"
local turns_seen = 0
local heartbeats = 0

-- Global on purpose, so you can look at it from the Debug Console.
faction_stats = {}

local function describe_faction(faction)
	local name = faction:name()
	local stats = {
		name = name,
		regions = faction:region_list():num_items(),
		characters = faction:character_list():num_items(),
		treasury = faction:treasury(),
	}
	faction_stats[name] = stats
	return stats
end

local function on_turn_start(context)
	local faction = context:faction()
	turns_seen = turns_seen + 1
	local stats = describe_faction(faction)
	out(mod_name .. ": turn " .. cm:model():turn_number() .. " for " .. stats.name
		.. " - " .. stats.regions .. " regions, treasury " .. stats.treasury)
end

local function on_heartbeat()
	heartbeats = heartbeats + 1
	local turn = cm:model():turn_number()
	out(mod_name .. ": heartbeat " .. heartbeats .. " on turn " .. turn)
end

cm:add_first_tick_callback(function()
	local human = cm:get_local_faction(true)
	local stats = describe_faction(human)
	out(mod_name .. ": loaded for " .. stats.name)

	core:add_listener(
		mod_name .. "_turn_start",
		"FactionTurnStart",
		function(context)
			return context:faction():is_human()
		end,
		on_turn_start,
		true
	)

	-- Every 10 seconds of real time, so a breakpoint in on_heartbeat is hit
	-- while you are just looking at the campaign map.
	cm:repeat_real_callback(on_heartbeat, 10000, mod_name .. "_heartbeat")
end)

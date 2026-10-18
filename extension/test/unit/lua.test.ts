import * as assert from 'node:assert/strict';

import { docToMarkdown, generateStubs, luaType, parseEventNames } from '../../src/lua/apiStubs';
import { isListenerEventArg, stringAt } from '../../src/lua/luaText';

const LIB = `
--- @c campaign_manager Campaign Manager
--- @a cm
--- @desc The campaign manager. See @core:add_listener.
local campaign_manager = {};

--- @function set_campaign_name
--- @desc Sets the name of the campaign.
--- @p string campaign name
--- @p [opt=false] @boolean <code>true</code> to shout
--- @r boolean success
--- @example cm:set_campaign_name("x")
function campaign_manager:set_campaign_name(name, loud)
end

--- @function add_infotext
--- @p object first param
--- @p ... additional params
function campaign_manager:add_infotext(first_param, ...)
end

--- @function out
--- @p string text
--- @p string extra text
function campaign_manager:out(text)
end

--- @function is_string
--- @p value value
--- @r boolean is string
function is_string(value)
end

--- @function new_thing
--- @r faction faction
function campaign_manager.new_thing()
end
`;

describe('Lua API stubs', () => {
	const stubs = generateStubs([
		{ path: 'script/_lib/lib_campaign_manager.lua', text: LIB },
		{ path: 'script/events.lua', text: 'module(..., package.seeall)\nFactionTurnStart = {}\nAdviceCleared = {}\nnot_an_event = 1\n' },
	]);
	const lib = stubs.files.get('_lib.lib_campaign_manager.lua')!;
	const types = stubs.files.get('_types.lua')!;

	it('documents methods with parameters, returns and examples', () => {
		assert.match(lib, /---@param name string campaign name\n---@param loud\? boolean `true` to shout \(default false\)\n---@return boolean # success\nfunction campaign_manager:set_campaign_name\(name, loud\) end/);
		assert.match(lib, /```lua\n--- cm:set_campaign_name\("x"\)\n--- ```/);
		assert.match(lib, /function campaign_manager\.new_thing\(\) end/);
		assert.match(lib, /---@return faction # faction/);
	});

	it('keeps varargs last and drops parameters the declaration does not have', () => {
		assert.match(lib, /function campaign_manager:add_infotext\(first_param, \.\.\.\) end/);
		assert.match(lib, /function campaign_manager:out\(text\) end/);
	});

	it('declares global functions, classes, instances and mentioned types', () => {
		assert.match(lib, /function is_string\(value\) end/);
		assert.match(types, /---@class campaign_manager\nlocal campaign_manager = \{\}/);
		assert.match(types, /---@type campaign_manager\ncm = nil/);
		assert.match(types, /---@class faction\n/);
		assert.ok(stubs.globals.includes('cm'));
		assert.equal(stubs.functionCount, 5 + 1);
	});

	it('types add_listener with the event names', () => {
		const events = stubs.files.get('_events.lua')!;
		assert.match(events, /---@alias TwEventName\n---\| "AdviceCleared"\n---\| "FactionTurnStart"\n/);
		assert.match(events, /function core_object:add_listener\(name, event, condition, callback, persistent\) end/);
		assert.deepEqual(parseEventNames('A = {}\nB = { }\nc = {}\n'), ['A', 'B']);
	});

	it('converts doc markup and types', () => {
		assert.equal(docToMarkdown('Call <code>x()</code> or @campaign_manager:foo &lt;now&gt;'), 'Call `x()` or `campaign_manager:foo` <now>');
		assert.equal(luaType('@string'), 'string');
		assert.equal(luaType('bool'), 'boolean');
		assert.equal(luaType('object'), 'any');
		assert.equal(luaType('table of strings'), 'any');
	});
});

describe('Lua text helpers', () => {
	it('finds the string literal at the cursor', () => {
		const line = 'cm:foo("wh_main", \'abc';
		assert.deepEqual(stringAt(line, 12), { quote: '"', start: 7, prefix: 'wh_m' });
		assert.deepEqual(stringAt(line, line.length), { quote: '\'', start: 18, prefix: 'abc' });
		assert.equal(stringAt(line, 18), undefined);
		assert.equal(stringAt('-- "comment', 8), undefined);
		assert.deepEqual(stringAt('"a\\"b', 5), { quote: '"', start: 0, prefix: 'a\\"b' });
	});

	it('recognises the event argument of add_listener', () => {
		assert.ok(isListenerEventArg('core:add_listener("my_listener", ', 33));
		assert.ok(isListenerEventArg('core:add_listener(\n'.trim() + 'name, ', 23));
		assert.ok(!isListenerEventArg('core:add_listener(', 18));
		assert.ok(!isListenerEventArg('cm:foo("a", ', 12));
	});
});

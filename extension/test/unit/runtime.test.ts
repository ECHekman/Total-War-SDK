import * as assert from 'node:assert/strict';

import { chunkNameFor, luaString, matchesName } from '../../src/runtime/helpers';
import { functionTimes } from '../../src/runtime/profileView';

describe('game tools', () => {
	it('quotes keys for Lua', () => {
		assert.equal(luaString('wh_main_emp_empire'), '"wh_main_emp_empire"');
		assert.equal(luaString('a"b\\c'), '"a\\"b\\\\c"');
		assert.throws(() => luaString('a\nb'));
	});

	it('names a file like the game names its chunk', () => {
		assert.equal(chunkNameFor('C:\\mods\\my_mod\\pack\\script\\campaign\\mod\\x.lua'), 'script\\campaign\\mod\\x.lua');
		assert.equal(chunkNameFor('/home/me/pack/Script/battle/y.lua'), 'Script\\battle\\y.lua');
		assert.equal(chunkNameFor('C:\\elsewhere\\z.lua'), undefined);
	});

	it('filters event names with *', () => {
		assert.ok(matchesName('UITrigger', 'uitrigger'));
		assert.ok(matchesName('ComponentMouse*', 'ComponentMouseOn'));
		assert.ok(!matchesName('Component', 'ComponentMouseOn'));
		assert.ok(!matchesName('a.b', 'aXb'));
	});

	it('adds up profiler samples per function', () => {
		const times = functionTimes({ samples: [{ s: 'main;tick;helper', n: 3 }, { s: 'main;tick', n: 2 }, { s: 'main;helper', n: 1 }], total: 6, seconds: 1, interval: 1000 });
		assert.deepEqual(times.map((t) => [t.name, t.self, t.total]), [['helper', 4, 4], ['tick', 2, 5], ['main', 0, 6]]);
	});
});

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BreakpointStore } from '../../src/adapter/breakpoints';
import { buildArgumentString } from '../../src/adapter/launcher';
import { chunkToKey, PathMapper } from '../../src/adapter/pathMapper';
import { asArray, encodeFrame, FrameDecoder, Message } from '../../src/adapter/protocol';
import { FileTransport } from '../../src/adapter/transport';

describe('TWDP framing', () => {
	const msg: Message = { type: 'evt', seq: 1, evt: 'output', body: { output: 'héllo wörld\n' } };

	it('round trips a message with multi-byte characters', () => {
		const d = new FrameDecoder();
		assert.deepEqual(d.push(encodeFrame(msg)), [msg]);
		assert.equal(d.pending, 0);
	});

	it('handles frames split at arbitrary byte boundaries', () => {
		const bytes = Buffer.concat([encodeFrame(msg), encodeFrame({ ...msg, seq: 2 })]);
		const d = new FrameDecoder();
		const got: Message[] = [];
		for (let i = 0; i < bytes.length; i++) {
			got.push(...d.push(bytes.subarray(i, i + 1)));
		}
		assert.deepEqual(got.map((m) => m.seq), [1, 2]);
	});

	it('rejects a corrupt header', () => {
		assert.throws(() => new FrameDecoder().push(Buffer.from('garbage\n{}')), /Broken TWDP header/);
	});

	it('normalises Lua empty tables to arrays', () => {
		assert.deepEqual(asArray([]), []);
		assert.deepEqual(asArray({}), []);
		assert.deepEqual(asArray({ 1: 'a', 2: 'b' }), ['a', 'b']);
		assert.deepEqual(asArray(undefined), []);
	});
});

describe('PathMapper', () => {
	it('derives keys from chunk names', () => {
		assert.equal(chunkToKey('@script/campaign/mod/Foo.lua'), 'script/campaign/mod/foo.lua');
		assert.equal(chunkToKey('@data\\script\\battle\\x.lua'), 'script/battle/x.lua');
		assert.equal(chunkToKey('@C:/Games/TW/script/_lib/lib.lua'), 'script/_lib/lib.lua');
		assert.equal(chunkToKey('@./other/thing.lua'), 'other/thing.lua');
		assert.equal(chunkToKey('@script/campaign/mod/no_extension'), 'script/campaign/mod/no_extension.lua');
	});

	it('maps editor paths and totalwar URIs to keys', () => {
		const m = new PathMapper({ workspaceFolders: ['C:\\mods\\mine'] });
		assert.equal(m.editorPathToKey('totalwar:/script/campaign/mod/My%20File.lua'), 'script/campaign/mod/my file.lua');
		assert.equal(m.editorPathToKey('totalwar:/@basegame/script/_lib/lib_core.lua'), 'script/_lib/lib_core.lua');
		assert.equal(m.editorPathToKey('totalwar:/@mods/van_mct.pack/script/_lib/mod/mct.lua'), 'script/_lib/mod/mct.lua');
		assert.equal(m.editorPathToKey('totalwar:/%40basegame/script/_lib/lib_core.lua'), 'script/_lib/lib_core.lua');
		assert.equal(m.editorPathToKey('C:\\mods\\mine\\pack\\script\\campaign\\mod\\a.lua'), 'script/campaign/mod/a.lua');
		assert.equal(m.editorPathToKey(path.join('C:\\mods\\mine', 'lua', 'b.lua')), 'lua/b.lua');
	});

	it('resolves chunks: source folder, then workspace sub folders, then virtual files', () => {
		const files = new Set([
			path.join('C:\\src', 'script', 'a.lua'),
			path.join('C:\\ws', 'pack', 'script', 'b.lua'),
		].map((p) => p.toLowerCase()));
		const m = new PathMapper({
			sourceFilesPath: 'C:\\src',
			workspaceFolders: ['C:\\ws'],
			fileExists: (p) => files.has(p.toLowerCase()),
			listDirs: (p) => (p === 'C:\\ws' ? [path.join('C:\\ws', 'pack')] : []),
			virtual: {
				uriFor: (key) => (key === 'script/c.lua' ? 'totalwar:/script/c.lua' : undefined),
				read: () => '-- c',
			},
		});
		assert.equal(m.chunkToSource('@script/a.lua').path, path.join('C:\\src', 'script', 'a.lua'));
		assert.equal(m.chunkToSource('@script/b.lua').path, path.join('C:\\ws', 'pack', 'script', 'b.lua'));
		assert.equal(m.chunkToSource('@script/c.lua').path, 'totalwar:/script/c.lua');
		const missing = m.chunkToSource('@script/d.lua');
		assert.equal(missing.path, undefined);
		assert.equal(missing.key, 'script/d.lua');
		assert.equal(missing.name, 'd.lua');
	});
});

describe('launcher', () => {
	it('builds the Total War command line', () => {
		assert.equal(buildArgumentString('used_mods.txt', ''), 'used_mods.txt;');
		assert.equal(buildArgumentString('my_mods.txt;', 'game_startup_mode campaign_load "a b.save";'),
			'my_mods.txt; game_startup_mode campaign_load "a b.save";');
		assert.equal(buildArgumentString(undefined, ' x; '), 'x;');
		assert.equal(buildArgumentString('', ''), '');
	});
});

describe('BreakpointStore', () => {
	it('stores, replaces and serialises breakpoints per key', () => {
		const s = new BreakpointStore();
		const a = s.set('script/a.lua', [{ line: 1 }, { line: 5, condition: 'x > 1', logMessage: '' }]);
		assert.equal(a.length, 2);
		assert.notEqual(a[0].id, a[1].id);
		s.set('script/b.lua', [{ line: 2 }]);
		s.set('script/b.lua', []);
		assert.deepEqual(s.toWire(), { 'script/a.lua': [{ line: 1 }, { line: 5, condition: 'x > 1' }] });
	});
});

describe('FileTransport', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-unit-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function sessionNonce(): string {
		return JSON.parse(fs.readFileSync(path.join(dir, 'tw_lua_debugger', 'session.json'), 'utf8')).nonce;
	}

	function gameWrites(msg: Message): void {
		fs.appendFileSync(path.join(dir, 'tw_lua_debugger', 'from_game'), encodeFrame(msg));
	}

	it('announces the session, accepts hello and correlates responses', async () => {
		const hellos: boolean[] = [];
		const t = new FileTransport(dir, { onHello: (_h, first) => hellos.push(first), onEvent: () => undefined },
			{ slowPollMs: 5, fastPollMs: 5 });
		t.start();
		const nonce = sessionNonce();
		gameWrites({ type: 'evt', seq: 1, evt: 'hello', body: { protocol: 2, nonce: 'stale', env: 'x', id: '0' } });
		gameWrites({ type: 'evt', seq: 2, evt: 'hello', body: { protocol: 2, nonce, env: 'campaign', id: 'a' } });
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(hellos, [true]);
		assert.ok(t.connected);

		const pending = t.request('threads', undefined, 1000);
		const written = fs.readFileSync(path.join(dir, 'tw_lua_debugger', 'to_game'));
		const [req] = new FrameDecoder().push(written);
		assert.equal(req.type, 'req');
		gameWrites({ type: 'res', seq: 3, req: req.seq, ok: true, body: [{ id: 1, name: 'main' }] });
		assert.deepEqual(await pending, [{ id: 1, name: 'main' }]);

		// A new Lua state: pending requests fail, listener is told it is a reconnect.
		const orphan = t.request('stack', {}, 1000);
		gameWrites({ type: 'evt', seq: 4, evt: 'hello', body: { protocol: 2, nonce, env: 'battle', id: 'b' } });
		await assert.rejects(orphan, /reloaded/);
		assert.deepEqual(hellos, [true, false]);

		t.dispose();
		assert.ok(!fs.existsSync(path.join(dir, 'tw_lua_debugger', 'session.json')));
	});

	it('detects the old file protocol', async () => {
		let legacy = false;
		const t = new FileTransport(dir, { onHello: () => undefined, onEvent: () => undefined, onLegacyDebuggee: () => (legacy = true) },
			{ slowPollMs: 5 });
		t.start();
		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(path.join(dir, 'debug_write'), '#10\n');
		await new Promise((r) => setTimeout(r, 1200));
		t.dispose();
		assert.ok(legacy);
	});
});

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DebugProtocol } from '@vscode/debugprotocol';

import { DEBUGGEE_ROOT, FIXTURES, Harness, LUA, luaAvailable, TEST_SCRIPT } from './harness';

// Line numbers in fixtures/script/campaign/mod/test_script.lua
const LINE_COUNTER = 11;  // counter = counter + 1
const LINE_HELPER_CALL = 12; // local result = helper(i)
const LINE_IN_HELPER = 6; // local doubled = x * 2
const LINE_SCRIPT_ERROR = 17;
const LINE_IN_COROUTINE = 31; // local inside = a + 1
const LINE_RAISE = 40; // error(msg)

function samePath(a: string | undefined, b: string): boolean {
	return !!a && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

describe('[lua] debug adapter against the Lua 5.1 debuggee', function () {
	this.timeout(30000);
	let h: Harness;
	let live: Harness | undefined; // not yet disposed

	before(function () {
		if (!luaAvailable()) {
			console.warn('Lua 5.1 not built; run `node scripts/build-lua51.mjs`. Skipping Lua tests.');
			this.skip();
		}
	});

	afterEach(async () => {
		if (live) {
			if (this.ctx.currentTest?.state === 'failed') {
				console.log('--- game output ---\n' + live.gameOutput.join(''));
				console.log('--- debug console ---\n' + live.output());
			}
			await live.dispose();
			live = undefined;
		}
	});

	async function launchWith(breakpoints: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[],
		game = {}, extra = {}, filters?: string[]): Promise<void> {
		h = live = new Harness(game);
		await h.start();
		await h.launch(breakpoints, extra, filters);
	}

	it('stops at a breakpoint and maps the source to the local file', async () => {
		const stopped = launchWith([{ line: LINE_HELPER_CALL }]).then(() => h.waitStopped('breakpoint'));
		await stopped;
		const frame = await h.topFrame();
		assert.equal(frame.line, LINE_HELPER_CALL);
		assert.match(frame.name, /on_tick/);
		assert.ok(samePath(frame.source?.path, TEST_SCRIPT), `unexpected source ${frame.source?.path}`);
		assert.match(h.output(), /Connected to the game \(campaign\)/);
	});

	it('also works when scripts run on the main thread', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { flags: 'mainthread' });
		await h.waitStopped('breakpoint');
		assert.equal((await h.topFrame()).line, LINE_HELPER_CALL);
	});

	it('matches chunks loaded without a .lua extension', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { flags: 'noext' });
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		assert.ok(samePath(frame.source?.path, TEST_SCRIPT), `unexpected source ${frame.source?.path}`);
	});

	it('also works when scripts run on the main thread', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { flags: 'mainthread' });
		await h.waitStopped('breakpoint');
		assert.equal((await h.topFrame()).line, LINE_HELPER_CALL);
	});

	it('matches chunks loaded without a .lua extension', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { flags: 'noext' });
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		assert.ok(samePath(frame.source?.path, TEST_SCRIPT), `unexpected source ${frame.source?.path}`);
	});

	it('matches chunks named like the game names them (bare backslash paths)', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { flags: 'bare' });
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		assert.ok(samePath(frame.source?.path, TEST_SCRIPT), `unexpected source ${frame.source?.path}`);
	});

	it('shows locals, upvalues and expands tables', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		const scopes = await h.scopes(frame.id);
		const locals = await h.variables(scopes.get('Locals')!.variablesReference);
		assert.equal(locals.get('i')?.value, '1');

		const upvalues = await h.variables(scopes.get('Upvalues')!.variablesReference);
		assert.equal(upvalues.get('counter')?.value, '1');
		const data = upvalues.get('data');
		assert.ok(data && data.variablesReference > 0);
		const fields = await h.variables(data.variablesReference);
		assert.equal(fields.get('name')?.value, '"karl"');
		const list = await h.variables(fields.get('list')!.variablesReference);
		assert.deepEqual([...list.keys()], ['[1]', '[2]', '[3]']);
		assert.equal(list.get('[2]')?.value, '20');
	});

	it('evaluates expressions and statements in the frame', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		assert.equal(await h.evaluate('i * 10', frame.id), '10');
		assert.equal(await h.evaluate('data.list[3]', frame.id), '30');
		assert.equal(await h.evaluate('#data.list + counter', frame.id), '4');
		await h.evaluate('counter = 100', frame.id);
		assert.equal(await h.evaluate('counter', frame.id), '100');
		await assert.rejects(h.dc.evaluateRequest({ expression: 'nil + 1', frameId: frame.id, context: 'repl' }),
			/arithmetic/);
	});

	it('steps in, over and out', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');

		let stopped = h.waitStopped('step');
		await h.dc.stepInRequest({ threadId: 1 });
		await stopped;
		let frame = await h.topFrame();
		assert.equal(frame.line, LINE_IN_HELPER);
		assert.match(frame.name, /helper/);

		stopped = h.waitStopped('step');
		await h.dc.nextRequest({ threadId: 1 });
		await stopped;
		frame = await h.topFrame();
		assert.equal(frame.line, LINE_IN_HELPER + 1);

		stopped = h.waitStopped('step');
		await h.dc.stepOutRequest({ threadId: 1 });
		await stopped;
		frame = await h.topFrame();
		assert.match(frame.name, /on_tick/);
		assert.ok(frame.line === LINE_HELPER_CALL || frame.line === LINE_HELPER_CALL + 1, `line ${frame.line}`);
	});

	it('supports conditional and hit count breakpoints', async () => {
		await launchWith([{ line: LINE_COUNTER, condition: 'i == 4' }]);
		await h.waitStopped('breakpoint');
		let frame = await h.topFrame();
		assert.equal(await h.evaluate('i', frame.id), '4');
		await h.dispose();
		live = undefined;

		await launchWith([{ line: LINE_COUNTER, hitCondition: '3' }]);
		await h.waitStopped('breakpoint');
		frame = await h.topFrame();
		assert.equal(await h.evaluate('i', frame.id), '3');
	});

	it('prints logpoints without stopping', async () => {
		await launchWith([{ line: LINE_COUNTER, logMessage: 'tick {i} of {"x"}' }], { ticks: 4 });
		await h.waitGameExit();
		const text = h.output();
		assert.match(text, /tick 1 of x/);
		assert.match(text, /tick 4 of x/);
		assert.match(text, /tick three/); // debuggee.print
	});

	it('completes names in the Debug Console', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		const labels = async (text: string, frameId?: number) =>
			(await h.dc.completionsRequest({ text, column: text.length + 1, frameId })).body.targets.map((t) => t.label);
		assert.ok((await labels('da', frame.id)).includes('data'));
		assert.deepEqual(await labels('data.', frame.id), ['list', 'name', 'nested']);
		assert.deepEqual(await labels('data.na', frame.id), ['name']);
		assert.ok((await labels('hel', frame.id)).includes('helper'));
		assert.ok((await labels('string.for')).includes('format'));
		assert.ok((await labels('x = get_c')).includes('get_counter'));
	});

	it('pages large tables', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		const r = await h.dc.evaluateRequest({ expression: 'big_list', frameId: frame.id, context: 'repl' });
		assert.equal(r.body.indexedVariables, 500);
		assert.equal(r.body.namedVariables, 1);
		const page = await h.dc.variablesRequest({ variablesReference: r.body.variablesReference, filter: 'indexed', start: 100, count: 3 });
		assert.deepEqual(page.body.variables.map((v) => `${v.name}=${v.value}`), ['[101]=202', '[102]=204', '[103]=206']);
		const named = await h.dc.variablesRequest({ variablesReference: r.body.variablesReference, filter: 'named' });
		assert.deepEqual(named.body.variables.map((v) => v.name), ['extra']);
	});

	it('lists loaded scripts', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const r = await h.dc.customRequest('loadedSources') as DebugProtocol.LoadedSourcesResponse;
		assert.ok(r.body.sources.some((s) => s.name === 'twdt_json.lua'), JSON.stringify(r.body.sources.map((s) => s.name)));
	});

	it('changes variables with setVariable', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }]);
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		const scopes = await h.scopes(frame.id);
		const localsRef = scopes.get('Locals')!.variablesReference;
		const r = await h.dc.setVariableRequest({ variablesReference: localsRef, name: 'i', value: 'i + 41' });
		assert.equal(r.body.value, '42');
		assert.equal(await h.evaluate('i', frame.id), '42');
		assert.equal(await h.evaluate('helper(i)', frame.id), '84');
	});

	it('breaks on script_error()', async () => {
		await launchWith([], { flags: 'fail' }, {}, ['script_error']);
		const e = await h.waitStopped('exception');
		assert.match(e.body.text ?? '', /boom at five/);
		const frame = await h.topFrame();
		assert.equal(frame.line, LINE_SCRIPT_ERROR);
		const info = await h.dc.exceptionInfoRequest({ threadId: 1 });
		assert.equal(info.body.exceptionId, 'script_error');
		assert.match(info.body.description ?? '', /boom at five/);
		assert.match(info.body.details?.stackTrace ?? '', /test_script\.lua:17/);
	});

	it("breaks on script_error() from mod scripts by default, but not on the game's own", async () => {
		await launchWith([], { flags: 'fail' }, {}, ['script_error_mod']);
		const e = await h.waitStopped('exception');
		assert.match(e.body.text ?? '', /boom at five/);
		await h.dispose();
		live = undefined;

		await launchWith([], { flags: 'vanillaerror', ticks: 5 }, {}, ['script_error_mod']);
		let stopped = false;
		h.dc.on('stopped', () => { stopped = true; });
		await h.waitGameExit();
		assert.equal(stopped, false, 'stopped on a script_error that came from outside a mod');
		assert.match(h.gameOutput.join(''), /error reported by the game itself/);
	});

	it('breaks on error() when the filter is enabled', async () => {
		await launchWith([], { flags: 'raise' }, {}, ['error']);
		const e = await h.waitStopped('exception');
		assert.match(e.body.text ?? '', /oops from raise/);
		const frame = await h.topFrame();
		assert.equal(frame.line, LINE_RAISE);
		// called through pcall, so Lua has no name for it; we show where it is defined
		assert.match(frame.name, /test_script\.lua:39/);
	});

	it('shows tail calls and anonymous functions without fake sources', async () => {
		await launchWith([{ line: LINE_IN_HELPER, condition: 'x == 102' }], { flags: 'tail', ticks: 3 });
		await h.waitStopped('breakpoint');
		const st = await h.dc.stackTraceRequest({ threadId: 1 });
		const tail = st.body.stackFrames.find((f) => f.name === '(tail call)');
		assert.ok(tail, JSON.stringify(st.body.stackFrames.map((f) => f.name)));
		assert.equal(tail.source, undefined);
		for (const f of st.body.stackFrames) {
			assert.doesNotMatch(f.name, /"\]/, 'frame name contains [string "..."] quoting');
		}
	});

	it('stops inside coroutines', async () => {
		await launchWith([{ line: LINE_IN_COROUTINE }], { flags: 'co' });
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		assert.equal(frame.line, LINE_IN_COROUTINE);
		assert.equal(await h.evaluate('a', frame.id), '1');
		const threads = await h.dc.threadsRequest();
		assert.match(threads.body.threads[0].name, /coroutine/);
	});

	it('applies breakpoints set while the game is running', async () => {
		await launchWith([], { ticks: 200 });
		await new Promise((r) => setTimeout(r, 500));
		const stopped = h.waitStopped('breakpoint');
		await h.dc.setBreakpointsRequest({ source: { path: TEST_SCRIPT }, breakpoints: [{ line: LINE_HELPER_CALL }] });
		await stopped;
		assert.equal((await h.topFrame()).line, LINE_HELPER_CALL);
	});

	it('pauses a running game', async () => {
		await launchWith([], { ticks: 200 });
		await new Promise((r) => setTimeout(r, 1500));
		const stopped = h.waitStopped('pause');
		await h.dc.pauseRequest({ threadId: 1 });
		await stopped;
		const st = await h.dc.stackTraceRequest({ threadId: 1 });
		assert.ok(st.body.stackFrames.length > 0);
		await h.dc.continueRequest({ threadId: 1 });
		const before = Number(await h.evaluate('get_counter()'));
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(Number(await h.evaluate('get_counter()')) > before, 'game did not resume');
	});

	it('evaluates in the REPL while the game is running', async () => {
		await launchWith([], { ticks: 200 });
		await new Promise((r) => setTimeout(r, 1000));
		const value = Number(await h.evaluate('get_counter()'));
		assert.ok(value > 0, `counter ${value}`);
	});

	it('runs code in the game and returns JSON-safe values', async () => {
		await launchWith([], { ticks: 200 });
		await new Promise((r) => setTimeout(r, 500));
		const r = await h.dc.customRequest('tw/run', { code: 'return { n = get_counter() > 0, list = { "x", "y" }, f = print, nested = { deep = 1 } }' });
		const value = r.body.value;
		assert.equal(value.n, true);
		assert.deepEqual(value.list, ['x', 'y']);
		assert.match(value.f, /^function/);
		assert.deepEqual(value.nested, { deep: 1 });
		await assert.rejects(h.dc.customRequest('tw/run', { code: 'error("boom")' }), /boom/);
	});

	it('reports script events while the event monitor is on', async () => {
		await launchWith([], { ticks: 200, flags: 'events' });
		await new Promise((r) => setTimeout(r, 300));
		const started = await h.dc.customRequest('tw/monitorEvents', { on: true });
		assert.deepEqual(started.body, { on: true, available: true });
		const e = await h.dc.waitForEvent('tw/scriptEvent', 5000);
		assert.equal(e.body.name, 'FactionTurnStart');
		assert.deepEqual(e.body.context, { faction: 'wh_main_emp_empire' });
		await h.dc.customRequest('tw/monitorEvents', { on: false });
		// The game's own handling still ran.
		assert.ok(Number(await h.evaluate('core.handled')) > 0);
		assert.equal(await h.evaluate('rawget(core, "event_callback") == nil'), 'true');
	});

	it('samples the scripts\' call stacks with the profiler', async () => {
		await launchWith([], { ticks: 200, flags: 'bench' });
		await new Promise((r) => setTimeout(r, 300));
		await h.dc.customRequest('tw/profileStart', { interval: 1000 });
		await new Promise((r) => setTimeout(r, 1500));
		const r = await h.dc.customRequest('tw/profileStop');
		const { samples, total } = r.body as { samples: { s: string; n: number }[]; total: number };
		assert.ok(total > 10, `only ${total} samples`);
		assert.ok(samples.some((x) => /run \(.*run_game\.lua:\d+\)/.test(x.s)), samples.slice(0, 5).map((x) => x.s).join('\n'));
		// The game runs on normally afterwards.
		const before = Number(await h.evaluate('get_counter()'));
		await new Promise((res) => setTimeout(res, 300));
		assert.ok(Number(await h.evaluate('get_counter()')) > before);
	});

	it('mirrors out() to the debug console', async () => {
		await launchWith([{ line: LINE_HELPER_CALL, condition: 'i == 6' }], { ticks: 8 });
		await h.waitStopped('breakpoint');
		const frame = await h.topFrame();
		await h.evaluate('data.name = "franz"', frame.id);
		await h.dc.continueRequest({ threadId: 1 });
		await h.waitGameExit();
		assert.match(h.output(), /name changed to franz/);
	});

	it('reconnects after an environment switch and keeps breakpoints', async () => {
		await launchWith([{ line: LINE_HELPER_CALL, condition: 'i == 2' }], { ticks: 3, flags: 'reconnect' });
		await h.waitStopped('breakpoint');
		await h.dc.continueRequest({ threadId: 1 });

		const second = h.waitStopped('breakpoint');
		await second;
		assert.match(h.output(), /switched to battle; debugger reconnected/);
		const frame = await h.topFrame();
		assert.equal(await h.evaluate('i', frame.id), '2');
		assert.equal(await h.evaluate('get_counter()', frame.id), '2');
	});

	it('starts the communication files over on reconnect once they are large', async () => {
		await launchWith([{ line: LINE_HELPER_CALL, condition: 'i == 2' }], { ticks: 3, flags: 'reconnect rotate' });
		await h.waitStopped('breakpoint');
		const before = fs.statSync(path.join(h.gameDir, 'tw_lua_debugger', 'from_game')).size;
		await h.dc.continueRequest({ threadId: 1 });
		await h.waitStopped('breakpoint');
		const after = fs.statSync(path.join(h.gameDir, 'tw_lua_debugger', 'from_game')).size;
		assert.ok(after < before, `from_game did not shrink (${before} -> ${after})`);
		assert.match(h.output(), /switched to battle; debugger reconnected/);
		const frame = await h.topFrame();
		assert.equal(await h.evaluate('i', frame.id), '2');
	});

	it('lets the game run on after disconnecting and restores its globals', async () => {
		await launchWith([{ line: LINE_HELPER_CALL }], { ticks: 5 });
		await h.waitStopped('breakpoint');
		assert.equal(await h.evaluate('print == nil'), 'false');
		await h.dc.disconnectRequest({ terminateDebuggee: false });
		const code = await h.waitGameExit();
		assert.equal(code, 0);
		const out = h.gameOutput.join('');
		assert.match(out, /done\s+5/);
		assert.match(out, /globals untouched: true/);
	});

	it('resumes the game when VS Code dies while it is paused', async () => {
		await launchWith([{ line: LINE_HELPER_CALL, condition: 'i == 2' }], { ticks: 4 });
		await h.waitStopped('breakpoint');
		h.simulateCrash();
		const started = Date.now();
		const code = await h.waitGameExit();
		assert.equal(code, 0);
		assert.match(h.gameOutput.join(''), /done\s+4/);
		assert.ok(Date.now() - started < 10000, 'game stayed frozen too long');
	});

	it('ignores a session left behind by a VS Code that is gone', async () => {
		const { spawnSync } = await import('node:child_process');
		const os = await import('node:os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-stale-'));
		try {
			const comm = path.join(dir, 'tw_lua_debugger');
			fs.mkdirSync(comm);
			fs.writeFileSync(path.join(comm, 'session.json'), JSON.stringify({ protocol: 2, nonce: 'stale' }));
			fs.writeFileSync(path.join(comm, 'alive'), '41'); // never changes
			fs.writeFileSync(path.join(comm, 'to_game'), '');
			fs.writeFileSync(path.join(comm, 'from_game'), '');
			const started = Date.now();
			const r = spawnSync(LUA, [path.join(FIXTURES, 'run_game.lua'), DEBUGGEE_ROOT, FIXTURES, 'campaign', '3', ''],
				{ cwd: dir, encoding: 'utf8' });
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /globals untouched: true/);
			assert.equal(fs.readFileSync(path.join(comm, 'from_game'), 'utf8'), '', 'connected to a dead session');
			assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('changes nothing in the game when no debugger is attached', async () => {
		const { spawnSync } = await import('node:child_process');
		const fs = await import('node:fs');
		const os = await import('node:os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-noattach-'));
		try {
			const r = spawnSync(LUA, [path.join(FIXTURES, 'run_game.lua'), DEBUGGEE_ROOT, FIXTURES, 'campaign', '3', 'co'],
				{ cwd: dir, encoding: 'utf8' });
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /globals untouched: true/);
			assert.ok(!fs.existsSync(path.join(dir, 'tw_lua_debugger')), 'debuggee created files without a session');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

import { SessionHost, TwLuaDebugSession } from '../../src/adapter/session';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');
export const LUA = path.join(extensionRoot, '.tools', 'lua51', process.platform === 'win32' ? 'lua51.exe' : 'lua51');
export const DEBUGGEE_ROOT = path.resolve(extensionRoot, '..', 'debuggee');
export const FIXTURES = path.join(extensionRoot, 'test', 'lua', 'fixtures');
export const TEST_SCRIPT = path.join(FIXTURES, 'script', 'campaign', 'mod', 'test_script.lua');

export function luaAvailable(): boolean {
	return fs.existsSync(LUA);
}

export interface GameOptions {
	env?: string;
	ticks?: number;
	flags?: string;
}

/** A debug adapter (in-process, over a socket) plus a fake game running in Lua 5.1. */
export class Harness {
	readonly gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-'));
	readonly exe = path.join(this.gameDir, 'Warhammer3.exe');
	readonly gameOutput: string[] = [];
	readonly outputEvents: DebugProtocol.OutputEvent[] = [];
	dc!: DebugClient;
	session: TwLuaDebugSession | undefined;
	game: ChildProcess | undefined;
	private server!: net.Server;

	constructor(private readonly game_: GameOptions = {}) {
		fs.writeFileSync(this.exe, '');
	}

	async start(): Promise<void> {
		const host: SessionHost = {
			workspaceFolders: () => [],
			transportOptions: { slowPollMs: 10, fastPollMs: 5 },
			launch: () => this.spawnGame(),
		};
		this.server = net.createServer((socket) => {
			const session = new TwLuaDebugSession(host);
			this.session = session;
			session.setRunAsServer(true);
			session.start(socket, socket);
		});
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const port = (this.server.address() as net.AddressInfo).port;
		this.dc = new DebugClient('node', 'unused', 'tw-lua');
		this.dc.defaultTimeout = 15000;
		await this.dc.start(port);
		this.dc.on('output', (e: DebugProtocol.OutputEvent) => this.outputEvents.push(e));
	}

	spawnGame(): ChildProcess {
		const g = this.game_;
		const child = spawn(LUA, [
			path.join(FIXTURES, 'run_game.lua'), DEBUGGEE_ROOT, FIXTURES,
			g.env ?? 'campaign', String(g.ticks ?? 40), g.flags ?? '',
		], { cwd: this.gameDir, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d) => this.gameOutput.push(String(d)));
		child.stderr?.on('data', (d) => this.gameOutput.push(String(d)));
		this.game = child;
		return child;
	}

	launchArgs(extra: object = {}): DebugProtocol.LaunchRequestArguments {
		return {
			executable: this.exe,
			sourceFilesPath: FIXTURES,
			modListFile: 'used_mods.txt',
			...extra,
		} as DebugProtocol.LaunchRequestArguments;
	}

	/** initialize -> breakpoints -> configurationDone -> launch, like VS Code does. */
	async launch(breakpoints: DebugProtocol.SourceBreakpoint[] = [], extra: object = {},
		exceptionFilters?: string[]): Promise<void> {
		const initialized = this.dc.waitForEvent('initialized');
		await this.dc.initializeRequest({ adapterID: 'tw-lua', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
		await initialized;
		if (breakpoints.length) {
			await this.dc.setBreakpointsRequest({ source: { path: TEST_SCRIPT }, breakpoints });
		}
		if (exceptionFilters) {
			await this.dc.setExceptionBreakpointsRequest({ filters: exceptionFilters });
		}
		await this.dc.configurationDoneRequest();
		await this.dc.launchRequest(this.launchArgs(extra));
	}

	async waitStopped(reason?: string): Promise<DebugProtocol.StoppedEvent> {
		const e = await this.dc.waitForEvent('stopped') as DebugProtocol.StoppedEvent;
		if (reason && e.body.reason !== reason) {
			throw new Error(`Expected stop reason ${reason}, got ${e.body.reason}`);
		}
		return e;
	}

	async topFrame(): Promise<DebugProtocol.StackFrame> {
		const st = await this.dc.stackTraceRequest({ threadId: 1 });
		return st.body.stackFrames[0];
	}

	async evaluate(expression: string, frameId?: number): Promise<string> {
		const r = await this.dc.evaluateRequest({ expression, frameId, context: 'repl' });
		return r.body.result;
	}

	async variables(ref: number): Promise<Map<string, DebugProtocol.Variable>> {
		const r = await this.dc.variablesRequest({ variablesReference: ref });
		return new Map(r.body.variables.map((v) => [v.name, v]));
	}

	async scopes(frameId: number): Promise<Map<string, DebugProtocol.Scope>> {
		const r = await this.dc.scopesRequest({ frameId });
		return new Map(r.body.scopes.map((s) => [s.name, s]));
	}

	/** Makes the adapter go silent without cleaning up, like a crashed VS Code. */
	simulateCrash(): void {
		(this.session as unknown as { transport: { abandon(): void } }).transport.abandon();
	}

	waitGameExit(): Promise<number | null> {
		const g = this.game;
		if (!g || g.exitCode !== null) {
			return Promise.resolve(g?.exitCode ?? null);
		}
		return new Promise((resolve) => g.on('exit', (code) => resolve(code)));
	}

	output(): string {
		return this.outputEvents.map((e) => e.body.output).join('');
	}

	async dispose(): Promise<void> {
		try {
			await this.dc.stop();
		} catch {
			// ignore
		}
		this.server.close();
		if (this.game && this.game.exitCode === null) {
			this.game.kill();
		}
		await new Promise((r) => setTimeout(r, 50));
		fs.rmSync(this.gameDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

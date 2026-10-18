import { ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	Event, Handles, InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame,
	StoppedEvent, TerminatedEvent, Thread, ContinuedEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import { GameDatabase } from '../db/effective';
import { BreakpointStore } from './breakpoints';
import { DB_COMMAND, DbVariables, isDbRef } from './dbVariables';
import { buildArgumentString, findProcessesStartedSince, launchGame, LaunchOptions } from './launcher';
import { PathMapper, VirtualSources } from './pathMapper';
import {
	asArray, BreakpointSpec, EvalResult, Event as TwEvent, HelloBody, LuaCompletion, LuaFrame, LuaScope, LuaThread,
	LuaVariable, Message, OutputBody, PROTOCOL_VERSION, StoppedBody, WelcomeArgs,
} from './protocol';
import { FileTransport, TransportOptions } from './transport';

/** Launch/attach arguments, see `contributes.debuggers` in package.json. */
export interface TwLuaArguments {
	executable: string;
	modListFile?: string;
	arguments?: string;
	env?: { [key: string]: string };
	sourceFilesPath?: string;
	terminateDebuggee?: boolean;
	captureOutput?: boolean;
	trace?: boolean;
}

export type TwLaunchArguments = DebugProtocol.LaunchRequestArguments & TwLuaArguments;
export type TwAttachArguments = DebugProtocol.AttachRequestArguments & TwLuaArguments;

/** Everything the session needs from its host (VS Code, or a test harness). */
export interface SessionHost {
	workspaceFolders?(): string[];
	virtualSources?: VirtualSources;
	transportOptions?: TransportOptions;
	/** Starts the game; replaceable for tests. */
	launch?(opts: LaunchOptions): ChildProcess;
	/** Version of the debugger mod shipped with this extension; a different one in the game is reported. */
	modVersion?: string;
	/** The game's effective DB tables, for `:db` in the Debug Console. */
	database?: GameDatabase;
}

export const EXCEPTION_FILTERS: DebugProtocol.ExceptionBreakpointsFilter[] = [
	{
		filter: 'error',
		label: 'error() calls',
		description: 'Break when a script calls error(). The stack is still intact at that point.',
		default: false,
	},
	{
		filter: 'script_error_mod',
		label: 'script_error() in mod scripts',
		description: 'Break when script_error() is called with a mod script (a file in a "mod" folder) on the stack.',
		default: true,
	},
	{
		filter: 'script_error',
		label: 'All script_error() calls',
		description: 'Break on every script_error(), including errors the game\'s own scripts report.',
		default: false,
	},
];

/** Custom DAP events consumed by the extension (waiting notification). */
export const WAITING_EVENT = 'tw/waiting';
export const CONNECTED_EVENT = 'tw/connected';
/** A script event seen by the event monitor (body: name, time, context). */
export const SCRIPT_EVENT = 'tw/scriptEvent';

/**
 * Custom requests for the SDK tools, passed to the game as they are:
 * - `tw/run` { code, chunk? } -> { value }: runs Lua in the scripts' environment;
 * - `tw/monitorEvents` { on } -> { on, available }: the event monitor;
 * - `tw/profileStart` { interval? }, `tw/profileStop` -> { samples, total, seconds, interval }.
 */
const GAME_REQUESTS: Record<string, string> = {
	'tw/run': 'run',
	'tw/monitorEvents': 'monitorEvents',
	'tw/profileStart': 'profileStart',
	'tw/profileStop': 'profileStop',
};

const STOPPED_TIMEOUT_MS = 10000;
const RUNNING_TIMEOUT_MS = 5000;

export class TwLuaDebugSession extends LoggingDebugSession {
	private transport: FileTransport | undefined;
	private mapper: PathMapper | undefined;
	private readonly breakpoints = new BreakpointStore();
	private exceptionFilters: string[] = EXCEPTION_FILTERS.filter((f) => f.default).map((f) => f.filter);
	private readonly sourceRefs = new Handles<string>();
	private readonly db: DbVariables | undefined;

	private configurationDone!: Promise<void>;
	private resolveConfigurationDone!: () => void;

	private args: TwLuaArguments | undefined;
	private child: ChildProcess | undefined;
	private launched = false;
	private launchedAt = 0;
	private childExitedEarly = false;
	private everConnected = false;
	private stopped = false;
	private lastException: { text: string; details?: string } | undefined;
	private ended = false;

	constructor(private readonly host: SessionHost = {}) {
		super();
		this.db = host.database ? new DbVariables(host.database) : undefined;
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
		this.configurationDone = new Promise((resolve) => (this.resolveConfigurationDone = resolve));
	}

	// ---- lifecycle ------------------------------------------------------------

	protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
		response.body = {
			supportsConfigurationDoneRequest: true,
			supportsConditionalBreakpoints: true,
			supportsHitConditionalBreakpoints: true,
			supportsLogPoints: true,
			supportsEvaluateForHovers: true,
			supportsSetVariable: true,
			supportsTerminateRequest: true,
			supportTerminateDebuggee: true,
			supportsCompletionsRequest: true,
			completionTriggerCharacters: ['.', ':'],
			supportsExceptionInfoRequest: true,
			supportsLoadedSourcesRequest: true,
			exceptionBreakpointFilters: EXCEPTION_FILTERS,
		};
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
		this.resolveConfigurationDone();
		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: TwLaunchArguments): void {
		this.startSession(response, args, true);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: TwAttachArguments): void {
		this.startSession(response, args, false);
	}

	private startSession(response: DebugProtocol.Response, args: TwLuaArguments, launch: boolean): void {
		const exe = (args.executable ?? '').trim();
		if (!exe) {
			return this.fail(response, 'The launch configuration has no "executable".');
		}
		if (!fs.existsSync(exe)) {
			return this.fail(response, `The game executable "${exe}" does not exist.`);
		}
		this.args = args;
		const exeDir = path.dirname(path.resolve(exe));

		this.mapper = new PathMapper({
			sourceFilesPath: args.sourceFilesPath,
			workspaceFolders: this.host.workspaceFolders?.() ?? [],
			exeDir,
			virtual: this.host.virtualSources,
		});

		this.transport = new FileTransport(exeDir, {
			onHello: (hello, first) => void this.onHello(hello, first),
			onEvent: (evt) => this.onGameEvent(evt),
			onLegacyDebuggee: () => this.output(
				'An old version of the TW Lua Debugger mod is active in the game. Update the debugger mod '
				+ '(command "TotalWar: Install Debugger Mod into Game", or update it on the Steam Workshop) and restart the game.\n',
				'stderr'),
			onError: (err) => this.output(`Debugger transport error: ${err.message}\n`, 'stderr'),
			onTrace: args.trace ? (dir, msg) => this.trace(dir, msg) : undefined,
		}, { ...this.host.transportOptions, debuggeeLog: !!args.trace });

		try {
			this.transport.start();
		} catch (e) {
			return this.fail(response, `Could not create the debugger folder in "${exeDir}": ${(e as Error).message}`);
		}

		if (launch) {
			const argumentString = buildArgumentString(args.modListFile, args.arguments);
			this.output(`${exe} ${argumentString}\n`, 'console');
			try {
				this.child = (this.host.launch ?? launchGame)({ executable: exe, argumentString, env: args.env });
			} catch (e) {
				return this.fail(response, `Could not start the game: ${(e as Error).message}`);
			}
			this.launched = true;
			this.launchedAt = Date.now();
			this.child.on('error', (err) => {
				this.output(`Could not start the game: ${err.message}\n`, 'stderr');
				this.end();
			});
			this.child.on('exit', (code) => this.onChildExit(code));
		}

		this.sendEvent(new Event(WAITING_EVENT, { mode: launch ? 'launch' : 'attach', exeDir }));
		this.sendResponse(response);
	}

	private onChildExit(code: number | null): void {
		if (this.ended) {
			return;
		}
		this.transport?.drain();
		if (this.everConnected) {
			this.output(`The game exited${code !== null ? ` with code ${code}` : ''}.\n`, 'console');
			this.end();
		} else {
			// Steam may restart the game through its own launcher; keep waiting.
			this.childExitedEarly = true;
			this.output('The launched process exited before the debugger connected. Still waiting for the game...\n', 'console');
		}
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		// The launch config can opt out; VS Code's "Disconnect" (vs "Stop") also asks us not to.
		const terminate = this.launched && this.args?.terminateDebuggee !== false && (args?.terminateDebuggee ?? true);
		this.stopGame(terminate);
		this.sendResponse(response);
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse): void {
		this.stopGame(this.launched && this.args?.terminateDebuggee !== false);
		this.sendResponse(response);
		this.end();
	}

	private stopGame(killGame: boolean): void {
		this.transport?.dispose();
		if (!killGame || !this.launched) {
			return;
		}
		if (this.child && this.child.exitCode === null && !this.childExitedEarly) {
			this.child.kill();
		} else if (this.childExitedEarly && this.args) {
			// The process we started handed over to another one (Steam). Stop only
			// copies of the game that started after our launch, never others.
			void findProcessesStartedSince(this.args.executable, this.launchedAt).then((pids) => {
				for (const pid of pids) {
					execFile('taskkill', ['/PID', String(pid), '/F'], () => undefined);
				}
			});
		}
	}

	private end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.transport?.dispose();
		this.sendEvent(new TerminatedEvent());
	}

	// ---- game connection ------------------------------------------------------

	private async onHello(hello: HelloBody, first: boolean): Promise<void> {
		if (hello.protocol !== PROTOCOL_VERSION) {
			this.output(`The debugger mod in the game speaks protocol ${hello.protocol}, this extension needs ${PROTOCOL_VERSION}. Update the debugger mod.\n`, 'stderr');
			return;
		}
		if (first && this.host.modVersion && hello.mod && hello.mod !== this.host.modVersion) {
			this.output(`The debugger mod in the game is version ${hello.mod}; this extension ships ${this.host.modVersion}. `
				+ 'Run "TotalWar: Install Debugger Mod into Game" (or update the Workshop mod) to get the matching version.\n', 'console');
		}
		await this.configurationDone;
		const transport = this.transport;
		if (!transport || this.ended) {
			return;
		}
		if (this.stopped) {
			// The previous Lua state is gone; it can't be stopped anymore.
			this.stopped = false;
			transport.setFastPolling(false);
			this.sendEvent(new ContinuedEvent(1, true));
		}
		this.mapper?.clearCache();
		const welcome: WelcomeArgs = {
			breakpoints: this.breakpoints.toWire(),
			exceptionFilters: this.exceptionFilters,
			captureOutput: this.args?.captureOutput !== false,
		};
		try {
			await transport.request('welcome', welcome, STOPPED_TIMEOUT_MS);
		} catch (e) {
			this.output(`Handshake with the game failed: ${(e as Error).message}\n`, 'stderr');
			return;
		}
		this.everConnected = true;
		const env = hello.env || 'unknown';
		this.output(first
			? `Connected to the game (${env}).\n`
			: `Game switched to ${env}; debugger reconnected.\n`, 'console');
		this.sendEvent(new Event(CONNECTED_EVENT, { env, first }));
		if (this.monitorOn) {
			// A new Lua state (environment switch): turn the monitor on again.
			transport.request('monitorEvents', { on: true }, RUNNING_TIMEOUT_MS).catch(() => undefined);
		}
	}

	/** Whether the event monitor is on, to restore it after an environment switch. */
	private monitorOn = false;

	protected customRequest(command: string, response: DebugProtocol.Response, args: unknown): void {
		const cmd = GAME_REQUESTS[command];
		if (!cmd) {
			return super.customRequest(command, response, args);
		}
		if (cmd === 'monitorEvents') {
			this.monitorOn = !!(args as { on?: boolean })?.on;
		}
		this.ask<unknown>(response, cmd, args ?? {}, (body) => {
			response.body = body;
		});
	}

	private onGameEvent(evt: TwEvent): void {
		switch (evt.evt) {
			case 'stopped': {
				const body = evt.body as StoppedBody;
				this.stopped = true;
				this.lastException = body.reason === 'exception' ? { text: body.text ?? '', details: body.details } : undefined;
				this.transport?.setFastPolling(true);
				const ev = new StoppedEvent(body.reason, body.thread ?? 1, body.text) as DebugProtocol.StoppedEvent;
				ev.body.allThreadsStopped = true;
				if (body.reason === 'exception' && body.text) {
					ev.body.description = 'Paused on error';
					this.output(body.text + '\n', 'stderr');
				}
				this.sendEvent(ev);
				break;
			}
			case 'scriptEvent':
				this.sendEvent(new Event(SCRIPT_EVENT, evt.body));
				break;
			case 'env': {
				const env = (evt.body as { env?: string })?.env ?? 'unknown';
				this.output(`Game environment: ${env}.
`, 'console');
				break;
			}
			case 'output': {
				const body = evt.body as OutputBody;
				const ev = new OutputEvent(body.output, body.category ?? 'stdout') as DebugProtocol.OutputEvent;
				if (body.chunk && this.mapper) {
					ev.body.source = this.toSource(body.chunk);
					ev.body.line = body.line;
				}
				this.sendEvent(ev);
				break;
			}
		}
	}

	// ---- breakpoints ----------------------------------------------------------

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		const sourcePath = args.source.path;
		if (!sourcePath) {
			response.body = { breakpoints: [] };
			return this.sendResponse(response);
		}
		const key = this.keyFor(sourcePath);
		const specs: BreakpointSpec[] = (args.breakpoints ?? []).map((b) => ({
			line: b.line,
			condition: b.condition,
			hitCondition: b.hitCondition,
			logMessage: b.logMessage,
		}));
		const stored = this.breakpoints.set(key, specs);
		response.body = {
			breakpoints: stored.map((b) => ({ id: b.id, verified: true, line: b.line })),
		};
		this.sendResponse(response);

		if (this.transport?.connected) {
			this.transport.request('setBreakpoints', { key, breakpoints: specs.map(BreakpointStore.toSpec) }, RUNNING_TIMEOUT_MS)
				.catch(() => undefined); // re-sent on the next connect anyway
		}
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		this.exceptionFilters = args.filters ?? [];
		if (this.transport?.connected) {
			this.transport.request('setExceptionFilters', { filters: this.exceptionFilters }, RUNNING_TIMEOUT_MS)
				.catch(() => undefined);
		}
		this.sendResponse(response);
	}

	private keyFor(sourcePath: string): string {
		return this.mapper ? this.mapper.editorPathToKey(sourcePath) : new PathMapper({}).editorPathToKey(sourcePath);
	}

	// ---- execution control ----------------------------------------------------

	protected continueRequest(response: DebugProtocol.ContinueResponse): void {
		response.body = { allThreadsContinued: true };
		this.resume(response, 'continue');
	}

	protected nextRequest(response: DebugProtocol.NextResponse): void {
		this.resume(response, 'step', { kind: 'over' });
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse): void {
		this.resume(response, 'step', { kind: 'in' });
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
		this.resume(response, 'step', { kind: 'out' });
	}

	private resume(response: DebugProtocol.Response, cmd: string, args?: unknown): void {
		if (!this.stopped || !this.transport?.connected) {
			return this.sendResponse(response);
		}
		this.stopped = false;
		this.transport.setFastPolling(false);
		this.transport.request(cmd, args, STOPPED_TIMEOUT_MS).then(
			() => this.sendResponse(response),
			(e: Error) => this.fail(response, e.message),
		);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse): void {
		if (this.transport?.connected && !this.stopped) {
			this.transport.notify('pause');
		}
		this.sendResponse(response);
	}

	// ---- inspection -----------------------------------------------------------

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		if (!this.stopped || !this.transport?.connected) {
			response.body = { threads: [new Thread(1, 'main')] };
			return this.sendResponse(response);
		}
		this.ask<LuaThread[]>(response, 'threads', undefined, (threads) => {
			const list = asArray<LuaThread>(threads).map((t) => new Thread(t.id, t.name));
			response.body = { threads: list.length ? list : [new Thread(1, 'main')] };
		});
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		if (!this.stopped) {
			response.body = { stackFrames: [], totalFrames: 0 };
			return this.sendResponse(response);
		}
		const req = { thread: args.threadId, start: args.startFrame ?? 0, levels: args.levels ?? 0 };
		this.ask<{ frames: LuaFrame[]; total: number }>(response, 'stack', req, (body) => {
			const frames = asArray<LuaFrame>(body?.frames).map((f) => {
				const sf: DebugProtocol.StackFrame = new StackFrame(f.id, f.name, undefined, f.line, 1);
				if (f.chunk && f.what !== 'C') {
					sf.source = this.toSource(f.chunk);
				} else {
					sf.presentationHint = 'subtle';
				}
				return sf;
			});
			response.body = { stackFrames: frames, totalFrames: body?.total ?? frames.length };
		});
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		this.ask<LuaScope[]>(response, 'scopes', { frame: args.frameId }, (scopes) => {
			response.body = {
				scopes: asArray<LuaScope>(scopes).map((s) => {
					const scope: DebugProtocol.Scope = new Scope(s.name, s.ref, !!s.expensive);
					if (s.name === 'Locals') {
						scope.presentationHint = 'locals';
					}
					return scope;
				}),
			};
		});
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		if (this.db && isDbRef(args.variablesReference)) {
			return this.answer(response, this.db.variables(args), (variables) => (response.body = { variables }));
		}
		const req = { ref: args.variablesReference, start: args.start ?? 0, count: args.count ?? 0, filter: args.filter };
		this.ask<LuaVariable[]>(response, 'vars', req, (vars) => {
			response.body = { variables: asArray<LuaVariable>(vars).map(toDapVariable) };
		});
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		if (isDbRef(args.variablesReference)) {
			return this.fail(response, 'DB tables are read-only here: change them in your mod\'s pack.');
		}
		const req = { ref: args.variablesReference, name: args.name, value: args.value };
		this.ask<EvalResult>(response, 'setVar', req, (r) => {
			response.body = { value: r.value, type: r.type, variablesReference: r.ref ?? 0 };
		});
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		if (isDbCommand(args.expression) && args.context !== 'hover') {
			// Answered from the packs: works whether or not the game is connected.
			if (!this.db) {
				return this.fail(response, 'DB tables are not available.');
			}
			return this.answer(response, this.db.evaluate(args.expression), (body) => (response.body = body));
		}
		if (!this.transport?.connected) {
			return this.fail(response, 'The game is not connected.');
		}
		if (args.context === 'hover' && (!this.stopped || /[()]/.test(args.expression))) {
			// Only evaluate side effect free expressions on hover.
			return this.fail(response, '');
		}
		const req = {
			expr: args.expression,
			frame: this.stopped ? args.frameId : undefined,
			context: args.context ?? 'repl',
		};
		this.ask<EvalResult>(response, 'eval', req, (r) => {
			response.body = {
				result: r.value, type: r.type, variablesReference: r.ref ?? 0,
				indexedVariables: r.indexed, namedVariables: r.named,
			};
		});
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
		const text = args.text.slice(0, Math.max(0, args.column - 1));
		if (isDbCommand(text)) {
			const targets = this.db ? this.db.complete(text).catch(() => []) : Promise.resolve([]);
			return this.answer(response, targets, (t) => (response.body = { targets: t }));
		}
		if (!this.transport?.connected) {
			response.body = { targets: [] };
			return this.sendResponse(response);
		}
		const req = { text, frame: this.stopped ? args.frameId : undefined };
		this.ask<LuaCompletion[]>(response, 'complete', req, (items) => {
			response.body = {
				targets: asArray<LuaCompletion>(items).map((c) => ({
					label: c.label,
					type: c.type as DebugProtocol.CompletionItemType,
				})),
			};
		});
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse): void {
		const e = this.lastException;
		if (!e) {
			return this.fail(response, 'Not stopped on an exception.');
		}
		response.body = {
			exceptionId: e.text.startsWith('script_error') ? 'script_error' : 'error',
			description: e.text,
			breakMode: 'always',
			details: { message: e.text, stackTrace: e.details?.replace(/^\s*stack traceback:\s*/, '') },
		};
		this.sendResponse(response);
	}

	protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse): void {
		if (!this.transport?.connected) {
			response.body = { sources: [] };
			return this.sendResponse(response);
		}
		this.ask<string[]>(response, 'sources', undefined, (paths) => {
			response.body = { sources: asArray<string>(paths).map((p) => this.toSource(p)) };
		});
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): void {
		const key = this.sourceRefs.get(args.sourceReference ?? args.source?.sourceReference ?? 0);
		const content = key ? this.mapper?.readVirtual(key) : undefined;
		if (content === undefined) {
			return this.fail(response, 'Source not available. Open the "Virtual TW Source Files" folder or set "sourceFilesPath".');
		}
		response.body = { content, mimeType: 'text/x-lua' };
		this.sendResponse(response);
	}

	// ---- helpers --------------------------------------------------------------

	private toSource(chunk: string): DebugProtocol.Source {
		const mapped = this.mapper!.chunkToSource(chunk);
		if (mapped.path) {
			return new Source(mapped.name, mapped.path);
		}
		const src: DebugProtocol.Source = new Source(mapped.name, undefined, this.sourceRefs.create(mapped.key));
		src.origin = 'game';
		return src;
	}

	/** Sends a TWDP request and completes the DAP response with its result. */
	private ask<T>(response: DebugProtocol.Response, cmd: string, args: unknown, fill: (body: T) => void): void {
		if (!this.transport?.connected) {
			return this.fail(response, 'The game is not connected.');
		}
		const timeout = this.stopped ? STOPPED_TIMEOUT_MS : RUNNING_TIMEOUT_MS;
		this.transport.request<T>(cmd, args, timeout).then(
			(body) => {
				try {
					fill(body);
					this.sendResponse(response);
				} catch (e) {
					this.fail(response, (e as Error).message);
				}
			},
			(e: Error) => this.fail(response, e.message),
		);
	}

	/** Completes a DAP response from a promise answered by the adapter itself. */
	private answer<T>(response: DebugProtocol.Response, result: Promise<T>, fill: (body: T) => void): void {
		result.then(
			(body) => {
				fill(body);
				this.sendResponse(response);
			},
			(e: Error) => this.fail(response, e.message),
		);
	}

	private fail(response: DebugProtocol.Response, message: string): void {
		response.success = false;
		response.message = message;
		this.sendResponse(response);
	}

	private output(text: string, category: string): void {
		this.sendEvent(new OutputEvent(text, category));
	}

	private trace(direction: 'in' | 'out', msg: Message): void {
		this.output(`${direction === 'out' ? '-> game' : '<- game'} ${JSON.stringify(msg)}\n`, 'console');
	}
}

function isDbCommand(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith(DB_COMMAND) && /^\s*$|^\s/.test(trimmed.slice(DB_COMMAND.length));
}

function toDapVariable(v: LuaVariable): DebugProtocol.Variable {
	return {
		name: v.name,
		value: v.value,
		type: v.type,
		variablesReference: v.ref ?? 0,
		indexedVariables: v.indexed,
		namedVariables: v.named,
		presentationHint: v.type === 'function' ? { kind: 'method' } : undefined,
	};
}

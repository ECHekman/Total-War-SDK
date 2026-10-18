// TWDP: the small protocol spoken between the debug adapter and the Lua debuggee
// running inside the game. Messages are exchanged through two append-only files
// and framed as `#<byte length>\n<json>`.

export const PROTOCOL_VERSION = 2;

/** Folder (inside the game executable folder) used for communication. */
export const COMM_DIR_NAME = 'tw_lua_debugger';
export const SESSION_FILE = 'session.json';
export const TO_GAME_FILE = 'to_game';
export const FROM_GAME_FILE = 'from_game';
/** Counter rewritten every HEARTBEAT_MS while VS Code is attached; the game treats a stale one as "debugger gone". */
export const ALIVE_FILE = 'alive';
export const HEARTBEAT_MS = 250;

export interface SessionInfo {
	protocol: number;
	nonce: string;
	/** Ask the debuggee to write a diagnostic log to tw_lua_debugger/debuggee.log. */
	log?: boolean;
}

export interface Request {
	type: 'req';
	seq: number;
	cmd: string;
	args?: unknown;
}

export interface Response {
	type: 'res';
	seq: number;
	req: number;
	ok: boolean;
	body?: unknown;
	err?: string;
}

export interface Event {
	type: 'evt';
	seq: number;
	evt: string;
	body?: unknown;
}

export type Message = Request | Response | Event;

// ---- payloads ---------------------------------------------------------------

export interface HelloBody {
	protocol: number;
	nonce: string;
	/** Game environment that connected: frontend, campaign, battle or unknown. */
	env: string;
	/** Unique id of this Lua state, changes on every environment switch. */
	id: string;
	lua?: string;
	mod?: string;
}

export interface BreakpointSpec {
	line: number;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
}

export interface WelcomeArgs {
	breakpoints: { [key: string]: BreakpointSpec[] };
	exceptionFilters: string[];
	captureOutput: boolean;
}

export interface StoppedBody {
	reason: 'breakpoint' | 'step' | 'pause' | 'exception' | 'entry';
	thread: number;
	text?: string;
	/** Lua traceback, for exceptions. */
	details?: string;
}

export interface OutputBody {
	category?: string;
	output: string;
	chunk?: string;
	line?: number;
}

export interface LuaThread {
	id: number;
	name: string;
}

export interface LuaFrame {
	id: number;
	name: string;
	/** Raw chunk name as reported by debug.getinfo (without the leading '@'). */
	chunk?: string;
	line: number;
	/** 'Lua', 'C', 'main' or 'tail' */
	what: string;
}

export interface LuaScope {
	name: string;
	ref: number;
	expensive?: boolean;
}

export interface LuaVariable {
	name: string;
	value: string;
	type: string;
	ref?: number;
	/** For large tables: size of the array part and number of other keys (shown in pages). */
	indexed?: number;
	named?: number;
}

export interface LuaCompletion {
	label: string;
	type: string;
}

export interface EvalResult {
	value: string;
	type: string;
	ref?: number;
	indexed?: number;
	named?: number;
}

// ---- framing ----------------------------------------------------------------

export function encodeFrame(msg: Message): Buffer {
	const body = Buffer.from(JSON.stringify(msg), 'utf8');
	return Buffer.concat([Buffer.from(`#${body.length}\n`, 'ascii'), body]);
}

/** Incrementally decodes `#<len>\n<json>` frames from a byte stream. */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Message[] {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		const out: Message[] = [];
		for (;;) {
			const nl = this.buffer.indexOf(0x0a);
			if (nl < 0) {
				break;
			}
			const header = this.buffer.subarray(0, nl).toString('ascii').trim();
			if (!header.startsWith('#')) {
				throw new Error(`Broken TWDP header: ${JSON.stringify(header.slice(0, 40))}`);
			}
			const size = Number(header.slice(1));
			if (!Number.isInteger(size) || size < 0) {
				throw new Error(`Broken TWDP header: ${JSON.stringify(header.slice(0, 40))}`);
			}
			if (this.buffer.length < nl + 1 + size) {
				break;
			}
			const body = this.buffer.subarray(nl + 1, nl + 1 + size).toString('utf8');
			this.buffer = this.buffer.subarray(nl + 1 + size);
			out.push(JSON.parse(body) as Message);
		}
		return out;
	}

	get pending(): number {
		return this.buffer.length;
	}

	reset(): void {
		this.buffer = Buffer.alloc(0);
	}
}

/** Lua's json encoder turns empty tables into `[]` (or `{}`); normalise to an array. */
export function asArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) {
		return value as T[];
	}
	if (value && typeof value === 'object') {
		return Object.values(value) as T[];
	}
	return [];
}

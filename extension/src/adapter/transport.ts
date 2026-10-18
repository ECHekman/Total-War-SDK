import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
	ALIVE_FILE, COMM_DIR_NAME, HEARTBEAT_MS, Event, FROM_GAME_FILE, FrameDecoder, HelloBody, Message, PROTOCOL_VERSION,
	Request, Response, SESSION_FILE, SessionInfo, TO_GAME_FILE, encodeFrame,
} from './protocol';

export interface TransportListener {
	/** A Lua state connected. `first` is false for reconnects after an environment switch. */
	onHello(hello: HelloBody, first: boolean): void;
	onEvent(evt: Event): void;
	/** A debuggee using the old (v1) file protocol was detected. */
	onLegacyDebuggee?(): void;
	onError?(err: Error): void;
	onTrace?(direction: 'in' | 'out', msg: Message): void;
}

export interface TransportOptions {
	/** Poll interval while the game is running (ms). */
	slowPollMs?: number;
	/** Poll interval while the game is stopped and waiting for us (ms). */
	fastPollMs?: number;
	/** Ask the debuggee to write tw_lua_debugger/debuggee.log. */
	debuggeeLog?: boolean;
}

interface Pending {
	resolve(body: unknown): void;
	reject(err: Error): void;
	timer?: NodeJS.Timeout;
}

/**
 * File based transport to the Lua debuggee. The game's Lua has no sockets, so
 * we exchange framed JSON through two append-only files in
 * `<exeDir>/tw_lua_debugger/`. `session.json` tells the game a debugger is
 * listening and identifies this session.
 */
export class FileTransport {
	readonly dir: string;
	private readonly toGame: string;
	private readonly fromGame: string;
	private readonly sessionFile: string;
	private readonly aliveFile: string;
	private heartbeat: NodeJS.Timeout | undefined;
	private beats = 0;
	private readonly nonce = randomBytes(8).toString('hex');

	private readonly decoder = new FrameDecoder();
	private readOffset = 0;
	private seq = 1;
	private pending = new Map<number, Pending>();
	private timer: NodeJS.Timeout | undefined;
	private polling = false;
	private fast = false;
	private disposed = false;
	private connectionId: string | undefined;
	private connections = 0;
	private startedAt = 0;
	private lastLegacyCheck = 0;
	private legacyReported = false;

	constructor(
		readonly exeDir: string,
		private readonly listener: TransportListener,
		private readonly options: TransportOptions = {},
	) {
		this.dir = path.join(exeDir, COMM_DIR_NAME);
		this.toGame = path.join(this.dir, TO_GAME_FILE);
		this.fromGame = path.join(this.dir, FROM_GAME_FILE);
		this.sessionFile = path.join(this.dir, SESSION_FILE);
		this.aliveFile = path.join(this.dir, ALIVE_FILE);
	}

	get connected(): boolean {
		return this.connectionId !== undefined;
	}

	get sessionNonce(): string {
		return this.nonce;
	}

	/** Creates fresh communication files and announces the session to the game. */
	start(): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(this.toGame, '');
		fs.writeFileSync(this.fromGame, '');
		this.beat();
		this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
		const info: SessionInfo = { protocol: PROTOCOL_VERSION, nonce: this.nonce };
		if (this.options.debuggeeLog) {
			info.log = true;
		}
		// Write-then-rename so the game never reads a half written session file.
		const tmp = this.sessionFile + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(info));
		fs.renameSync(tmp, this.sessionFile);
		this.startedAt = Date.now();
		this.schedule();
	}

	/** Use a short poll interval while the game is blocked in the debug loop. */
	setFastPolling(fast: boolean): void {
		this.fast = fast;
	}

	request<T = unknown>(cmd: string, args?: unknown, timeoutMs = 0): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Error('Debug session has ended.'));
		}
		if (!this.connected) {
			return Promise.reject(new Error('The game is not connected.'));
		}
		const seq = this.seq++;
		return new Promise<T>((resolve, reject) => {
			const p: Pending = { resolve: resolve as (b: unknown) => void, reject };
			if (timeoutMs > 0) {
				p.timer = setTimeout(() => {
					this.pending.delete(seq);
					reject(new Error(`The game did not answer '${cmd}' in time. It runs no scripts during loading screens; try again once it has loaded.`));
				}, timeoutMs);
			}
			this.pending.set(seq, p);
			try {
				this.write({ type: 'req', seq, cmd, args });
			} catch (e) {
				this.pending.delete(seq);
				if (p.timer) {
					clearTimeout(p.timer);
				}
				reject(e as Error);
			}
		});
	}

	/** Sends a request without waiting for (or caring about) the response. */
	notify(cmd: string, args?: unknown): void {
		if (this.disposed || !this.connected) {
			return;
		}
		this.write({ type: 'req', seq: this.seq++, cmd, args });
	}

	/** Reads whatever the game wrote but we have not processed yet (e.g. right before it exited). */
	drain(): void {
		if (this.disposed) {
			return;
		}
		try {
			this.readAvailable();
		} catch (e) {
			this.listener.onError?.(e as Error);
		}
	}

	/** Tells the game to detach and removes the session file. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		try {
			this.notify('disconnect');
		} catch {
			// game may be gone already
		}
		this.abandon();
		this.failPending(new Error('Debug session has ended.'));
		for (const file of [this.sessionFile, this.aliveFile]) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Stops all activity without telling the game or cleaning up, as if VS Code
	 * had crashed. dispose() uses it; tests use it to simulate a crash.
	 */
	abandon(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
		}
	}

	/** Proves to the game that we are still here. */
	private beat(): void {
		try {
			fs.writeFileSync(this.aliveFile, String(++this.beats));
		} catch {
			// the game may be reading it; next beat
		}
	}

	// ---- internals ------------------------------------------------------------

	private write(msg: Request): void {
		this.listener.onTrace?.('out', msg);
		fs.appendFileSync(this.toGame, encodeFrame(msg));
	}

	private schedule(): void {
		if (this.disposed) {
			return;
		}
		const ms = this.fast ? (this.options.fastPollMs ?? 10) : (this.options.slowPollMs ?? 40);
		this.timer = setTimeout(() => this.poll(), ms);
	}

	private poll(): void {
		if (this.disposed || this.polling) {
			return;
		}
		this.polling = true;
		try {
			this.readAvailable();
			this.checkLegacy();
		} catch (e) {
			this.listener.onError?.(e as Error);
		} finally {
			this.polling = false;
			this.schedule();
		}
	}

	private readAvailable(): void {
		let fd: number;
		try {
			fd = fs.openSync(this.fromGame, 'r');
		} catch {
			return;
		}
		try {
			const size = fs.fstatSync(fd).size;
			if (size < this.readOffset) {
				// File was truncated underneath us; start over.
				this.readOffset = 0;
				this.decoder.reset();
			}
			if (size === this.readOffset) {
				return;
			}
			const buf = Buffer.alloc(size - this.readOffset);
			let read = 0;
			while (read < buf.length) {
				const n = fs.readSync(fd, buf, read, buf.length - read, this.readOffset + read);
				if (n <= 0) {
					break;
				}
				read += n;
			}
			this.readOffset += read;
			for (const msg of this.decoder.push(buf.subarray(0, read))) {
				this.dispatch(msg);
			}
		} finally {
			fs.closeSync(fd);
		}
	}

	private dispatch(msg: Message): void {
		this.listener.onTrace?.('in', msg);
		if (msg.type === 'res') {
			this.handleResponse(msg);
		} else if (msg.type === 'evt') {
			if (msg.evt === 'hello') {
				this.handleHello(msg.body as HelloBody);
			} else if (this.connected) {
				this.listener.onEvent(msg);
			}
		}
	}

	private handleHello(hello: HelloBody): void {
		if (!hello || hello.nonce !== this.nonce) {
			return; // left over from another session
		}
		if (hello.id === this.connectionId) {
			return;
		}
		// A new Lua state replaces the previous one; it will never answer the
		// requests we sent to its predecessor.
		this.failPending(new Error('The game reloaded its scripts.'));
		this.connectionId = hello.id;
		this.connections++;
		this.listener.onHello(hello, this.connections === 1);
	}

	private handleResponse(res: Response): void {
		const p = this.pending.get(res.req);
		if (!p) {
			return;
		}
		this.pending.delete(res.req);
		if (p.timer) {
			clearTimeout(p.timer);
		}
		if (res.ok) {
			p.resolve(res.body);
		} else {
			p.reject(new Error(res.err ?? 'Unknown error in the game.'));
		}
	}

	private failPending(err: Error): void {
		for (const p of this.pending.values()) {
			if (p.timer) {
				clearTimeout(p.timer);
			}
			p.reject(err);
		}
		this.pending.clear();
	}

	/** The v1 debuggee wrote to `<exeDir>/debug_write`; detect it to show a helpful error. */
	private checkLegacy(): void {
		if (this.legacyReported || this.connections > 0 || !this.listener.onLegacyDebuggee) {
			return;
		}
		const now = Date.now();
		if (now - this.lastLegacyCheck < 1000) {
			return;
		}
		this.lastLegacyCheck = now;
		try {
			const st = fs.statSync(path.join(this.exeDir, 'debug_write'));
			if (st.mtimeMs > this.startedAt) {
				this.legacyReported = true;
				this.listener.onLegacyDebuggee();
			}
		} catch {
			// not present: fine
		}
	}
}

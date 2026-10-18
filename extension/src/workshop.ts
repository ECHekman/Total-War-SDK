import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What Steam knows about a Workshop item. */
export interface WorkshopItem {
	id: string;
	title: string;
	/** Items this one lists as required ("required items" on its Workshop page). */
	children: string[];
}

/** Talks to Steam about Workshop items; the real one runs steam-helper.exe. */
export interface WorkshopClient {
	/** Details of the items; ids Steam does not know are left out. */
	info(ids: string[]): Promise<WorkshopItem[]>;
	/** Subscribes to the items and waits until Steam has downloaded them. */
	subscribe(ids: string[], onProgress: (id: string, done: number, total: number) => void): Promise<SubscribeResult[]>;
}

export interface SubscribeResult {
	id: string;
	/** The folder the item was installed to, or an error. */
	folder?: string;
	error?: string;
}

/**
 * The Workshop items `roots` need, in the order to list them: the roots first,
 * then the items they require (breadth first, each once). `unknown` are ids
 * Steam does not know (deleted, private or mistyped).
 */
export async function workshopClosure(roots: string[], client: Pick<WorkshopClient, 'info'>): Promise<{ items: WorkshopItem[]; unknown: string[] }> {
	const items = new Map<string, WorkshopItem>();
	const unknown: string[] = [];
	const order: string[] = [];
	let wave = [...new Set(roots)];
	const queued = new Set(wave);
	while (wave.length) {
		const found = new Map((await client.info(wave)).map((i) => [i.id, i]));
		const next: string[] = [];
		for (const id of wave) {
			const item = found.get(id);
			if (!item) {
				unknown.push(id);
				continue;
			}
			items.set(id, item);
			order.push(id);
			for (const child of item.children) {
				if (!queued.has(child)) {
					queued.add(child);
					next.push(child);
				}
			}
		}
		wave = next;
	}
	return { items: order.map((id) => items.get(id)!), unknown };
}

/** Path of steam-helper.exe in the extension, if it was built and shipped. */
export function steamHelperPath(extensionPath: string): string | undefined {
	const exe = path.join(extensionPath, 'native', 'steam-helper.exe');
	return fs.existsSync(exe) ? exe : undefined;
}

interface HelperEvent {
	event: 'item' | 'missing' | 'progress' | 'installed' | 'error' | 'fatal' | 'done';
	id?: string;
	title?: string;
	children?: string[];
	folder?: string | null;
	done?: number;
	total?: number;
	message?: string;
}

/** Runs steam-helper.exe; resolves with its events, rejects on a fatal error. */
function runHelper(exe: string, appId: number, command: string, ids: string[], onEvent?: (e: HelperEvent) => void, signal?: AbortSignal): Promise<HelperEvent[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, [String(appId), command, ...ids], { cwd: path.dirname(exe), windowsHide: true, signal });
		const events: HelperEvent[] = [];
		let buffer = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				// The Steam API prints its own lines too.
				if (!line.startsWith('{')) {
					continue;
				}
				try {
					const e = JSON.parse(line) as HelperEvent;
					events.push(e);
					onEvent?.(e);
				} catch {
					// not ours
				}
			}
		});
		child.stderr.on('data', (d) => { stderr += String(d); });
		child.on('error', (e) => reject(e.name === 'AbortError' ? new Error('Cancelled.') : e));
		child.on('close', (code) => {
			const fatal = events.find((e) => e.event === 'fatal');
			if (fatal) {
				reject(new Error(fatal.message));
			} else if (code !== 0 || !events.some((e) => e.event === 'done')) {
				reject(new Error(`steam-helper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
			} else {
				resolve(events);
			}
		});
	});
}

/** A WorkshopClient running steam-helper.exe as the game `appId`. */
export function steamWorkshopClient(exe: string, appId: number, signal?: AbortSignal): WorkshopClient {
	return {
		async info(ids) {
			const events = await runHelper(exe, appId, 'info', ids, undefined, signal);
			return events.filter((e) => e.event === 'item' && e.id).map((e) => ({ id: e.id!, title: e.title ?? '', children: e.children ?? [] }));
		},
		async subscribe(ids, onProgress) {
			const results = new Map<string, SubscribeResult>();
			await runHelper(exe, appId, 'subscribe', ids, (e) => {
				if (e.event === 'progress' && e.id) {
					onProgress(e.id, e.done ?? 0, e.total ?? 0);
				} else if (e.event === 'installed' && e.id) {
					results.set(e.id, { id: e.id, folder: e.folder ?? undefined });
				} else if (e.event === 'error' && e.id) {
					results.set(e.id, { id: e.id, error: e.message });
				}
			}, signal);
			return ids.map((id) => results.get(id) ?? { id, error: 'Steam did not report the download.' });
		},
	};
}

/** Remembers what Steam said about items, so a launch doesn't ask Steam every time. */
export interface WorkshopCache {
	get(id: string): (WorkshopItem & { at: number }) | undefined;
	set(item: WorkshopItem): void;
}

/** One day: required items rarely change. */
export const WORKSHOP_CACHE_TTL = 24 * 60 * 60 * 1000;

/** `client` answering `info` from `cache` for items it knows (fresh enough), asking Steam for the rest. */
export function cachedWorkshopClient(client: WorkshopClient, cache: WorkshopCache, now = Date.now()): WorkshopClient {
	return {
		async info(ids) {
			const cached = ids.map((id) => cache.get(id)).filter((i): i is WorkshopItem & { at: number } => !!i && now - i.at < WORKSHOP_CACHE_TTL);
			const known = new Set(cached.map((i) => i.id));
			const ask = ids.filter((id) => !known.has(id));
			const fetched = ask.length ? await client.info(ask) : [];
			for (const item of fetched) {
				cache.set(item);
			}
			return [...cached.map(({ id, title, children }) => ({ id, title, children })), ...fetched];
		},
		subscribe: (ids, onProgress) => client.subscribe(ids, onProgress),
	};
}

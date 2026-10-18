import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { normalizeKey, VIRTUAL_SCHEME, VirtualSources } from './adapter/pathMapper';
import { gameByKey } from './games';
import { byPriority, parseModList, resolveModPacks } from './modList';
import { DirTree, PackHolder, rpfm } from './rpfm';
import { findGameExecutable } from './steam';

export interface SourceConfig {
	exeDir: string;
	modListFile: string;
	game: string;
}

const STATE_KEY = 'twdev.sourceConfig';
/** Top-level folder with the game's own Lua files. */
export const BASEGAME_FOLDER = '@basegame';
/** Top-level folder with one sub folder per mod pack, holding only that mod's files. */
export const MODS_FOLDER = '@mods';

/** The files of one pack (a mod) or of the merged game packs. */
interface PackSource {
	/** Virtual folder: '@basegame' or '@mods/<pack>' */
	folder: string;
	holder: PackHolder;
	/** Lua files, for the debugger: lower-case path inside the pack -> path as stored */
	files: Map<string, string>;
	/** Its folders as listed (`twdev.virtualFiles.exclude` applied). */
	tree: DirTree;
}

/** Glob patterns of pack files to leave out of the listing (setting `twdev.virtualFiles.exclude`). */
export function virtualFilesExclude(): string[] {
	return vscode.workspace.getConfiguration('twdev').get<string[]>('virtualFiles.exclude', []);
}
export const VIRTUAL_ROOT = vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: '/' });

class Entry implements vscode.FileStat {
	ctime = 0;
	mtime = 0;
	size = 0;
	readonly permissions = vscode.FilePermission.Readonly;
	constructor(readonly type: vscode.FileType) {}
}

/**
 * Read-only `twsource:` file system with every file of the game's packs and
 * of the mods in the mod list (DB tables open in the DB table editor; other
 * files in whatever editor handles their type), each in its own folder:
 * - `@basegame/` the game's own packs;
 * - `@mods/<pack>/` each mod's own files.
 * A file that a mod overrides appears in both. The debugger opens the copy the
 * game actually runs: the first mod in the mod list that has it, else the game's.
 */
export class LiveSourceFS implements vscode.FileSystemProvider, VirtualSources, vscode.Disposable {
	/** Highest priority first: mods in load order, then the base game. */
	private sources: PackSource[] = [];
	private loaded = false;
	private loading: Promise<void> | undefined;
	/** Mod list file contents the current packs were loaded from. */
	private loadedModList: string | undefined;
	private config: SourceConfig | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;

	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	private readonly reloaded = new vscode.EventEmitter<void>();
	/** Fired when the packs were (re)loaded: a new install, mod list or packs. Not for a new filter. */
	readonly onDidReload = this.reloaded.event;

	constructor(private readonly state: vscode.Memento, private readonly log: vscode.OutputChannel) {
		this.config = state.get<SourceConfig>(STATE_KEY);
	}

	/** Points the file system at a game install and mod list; reloads if it changed. */
	configure(config: SourceConfig): Promise<void> {
		const same = this.config && this.config.exeDir === config.exeDir
			&& this.config.modListFile === config.modListFile && this.config.game === config.game;
		this.config = config;
		void this.state.update(STATE_KEY, config);
		if (same && (this.loaded || this.loading)) {
			return this.loading ?? Promise.resolve();
		}
		return this.reload();
	}

	get configured(): boolean {
		return this.config !== undefined;
	}

	reload(): Promise<void> {
		const config = this.config;
		if (!config) {
			return Promise.resolve();
		}
		this.watchModList(config);
		this.loading = this.load(config).finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private readModList(config: SourceConfig): string | undefined {
		if (!config.modListFile) {
			return undefined;
		}
		try {
			return fs.readFileSync(path.join(config.exeDir, config.modListFile), 'utf8');
		} catch {
			return undefined;
		}
	}

	/**
	 * Reloads when the mod list changed since it was loaded. Called when a debug
	 * session starts: its pre-launch pack task may have just rewritten the list,
	 * after the configuration (and so these sources) was resolved.
	 */
	reloadIfModListChanged(): Promise<void> {
		if (!this.config || this.loading || !this.loaded) {
			return this.loading ?? Promise.resolve();
		}
		if (this.readModList(this.config) === this.loadedModList) {
			return Promise.resolve();
		}
		this.log.appendLine('Virtual sources: the mod list changed; reloading.');
		return this.reload();
	}

	private async load(config: SourceConfig): Promise<void> {
		const lib = rpfm();
		let caPacks: string[];
		try {
			caPacks = lib.caPackPaths(config.exeDir, config.game);
		} catch (e) {
			this.log.appendLine(`Could not list the game's packs: ${(e as Error).message}`);
			const dataPack = path.join(config.exeDir, 'data', 'data.pack');
			caPacks = fs.existsSync(dataPack) ? [dataPack] : [];
		}
		const modListPath = path.join(config.exeDir, config.modListFile);
		let modPacks: string[] = [];
		this.loadedModList = this.readModList(config);
		if (!config.modListFile) {
			// launched without a mod list: game files only
		} else if (this.loadedModList !== undefined) {
			modPacks = resolveModPacks(parseModList(this.loadedModList), config.exeDir);
		} else {
			this.log.appendLine(`Mod list ${modListPath} not found; showing the game's own files only.`);
		}
		if (caPacks.length + modPacks.length === 0) {
			throw new Error(`No pack files found for ${config.exeDir}`);
		}
		const started = Date.now();
		const baseName = (p: string) => path.basename(p);
		const filesOf = (holder: PackHolder) => new Map(holder.luaPaths().map((p) => [p.toLowerCase(), p]));
		const exclude = virtualFilesExclude();

		// The game's own packs merged; within them the first by name wins, as RPFM models it.
		const byName = (a: string, b: string) => baseName(a).toLowerCase().localeCompare(baseName(b).toLowerCase());
		const base: PackSource[] = [];
		if (caPacks.length) {
			const holder = await lib.openPacksAsync([...caPacks].sort(byName), config.game, true);
			base.push({ folder: BASEGAME_FOLDER, holder, files: filesOf(holder), tree: await holder.dirTreeAsync(exclude) });
		}
		// Each mod on its own, in the game's priority (mod list order, see modList.ts),
		// in front of the base game: a mod's file wins over the game's.
		const mods: PackSource[] = [];
		for (const modPack of byPriority(modPacks, baseName)) {
			try {
				const holder = await lib.openPacksAsync([modPack], config.game);
				mods.push({ folder: `${MODS_FOLDER}/${baseName(modPack)}`, holder, files: filesOf(holder), tree: await holder.dirTreeAsync(exclude) });
			} catch (e) {
				this.log.appendLine(`Could not open ${modPack}: ${(e as Error).message}`);
			}
		}
		this.sources = [...mods, ...base];
		this.loaded = true;
		const count = (list: PackSource[]) => list.reduce((n, src) => n + src.files.size, 0);
		this.log.appendLine(`Virtual sources: ${caPacks.length} game packs (${count(base)} Lua files), `
			+ `${mods.length} mods (${count(mods)} Lua files), in ${Date.now() - started} ms.`);
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: VIRTUAL_ROOT }]);
		this.reloaded.fire();
	}

	/**
	 * Lists the files again with the current `twdev.virtualFiles.exclude`
	 * (the packs stay open). Folders left without files disappear.
	 */
	async refilter(): Promise<void> {
		if (this.loading) {
			await this.loading.catch(() => undefined);
		}
		const sources = this.sources;
		const exclude = virtualFilesExclude();
		const trees = await Promise.all(sources.map((s) => s.holder.dirTreeAsync(exclude)));
		if (this.sources !== sources) {
			return; // reloaded meanwhile, with the new filter
		}
		sources.forEach((s, i) => (s.tree = trees[i]));
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: VIRTUAL_ROOT }]);
	}

	/**
	 * Where a virtual path (lower case, no leading /) points: the root, the
	 * `@mods` folder, or a path inside one of the packs ('' for its root).
	 * The packs index their own folders (rpfm-interface `dirTreeAsync`): the
	 * game alone has over 700,000 files. A filtered-out file still opens
	 * (stack frames, links); it is only left out of the listing.
	 */
	private resolve(key: string): { kind: 'root' } | { kind: 'mods' } | { kind: 'pack'; source: PackSource; inner: string } | undefined {
		if (key === '') {
			return { kind: 'root' };
		}
		if (key === MODS_FOLDER.toLowerCase()) {
			return this.sources.some((s) => s.folder !== BASEGAME_FOLDER) ? { kind: 'mods' } : undefined;
		}
		for (const source of this.sources) {
			const folder = source.folder.toLowerCase();
			if (key === folder || key.startsWith(`${folder}/`)) {
				return { kind: 'pack', source, inner: key.slice(folder.length + 1) };
			}
		}
		return undefined;
	}

	/** The pack that provides the copy of a file the game runs. */
	private winner(key: string): { source: PackSource; inner: string } | undefined {
		const k = normalizeKey(key);
		for (const source of this.sources) {
			const inner = source.files.get(k);
			if (inner) {
				return { source, inner };
			}
		}
		return undefined;
	}

	private watchModList(config: SourceConfig): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		if (!config.modListFile) {
			return;
		}
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(config.exeDir), config.modListFile));
		const reload = () => void this.reload().catch((e) => this.log.appendLine(String(e)));
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
	}

	private async ready(): Promise<void> {
		try {
			if (this.loading) {
				await this.loading;
				return;
			}
			if (!this.config) {
				// Never debugged in this workspace: use the game found through Steam
				// until a debug session tells us which install and mod list to use.
				this.config = await this.detectedConfig();
			}
			if (!this.loaded && this.config) {
				await this.reload();
			}
		} catch (e) {
			this.log.appendLine(`Virtual sources: ${(e as Error).message}`);
		}
	}

	private async detectedConfig(): Promise<SourceConfig | undefined> {
		const game = gameByKey(vscode.workspace.getConfiguration('twdev').get<string>('game'));
		const exe = await findGameExecutable(game);
		if (!exe) {
			return undefined;
		}
		this.log.appendLine(`Virtual sources: using ${exe} (found through Steam) until a debug session is started.`);
		return { exeDir: path.dirname(exe), modListFile: 'used_mods.txt', game: game.key };
	}

	private static key(uri: vscode.Uri): string {
		return uri.path.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
	}

	/** Folder of the game executable of the current configuration. */
	get exeDir(): string | undefined {
		return this.config?.exeDir;
	}

	/** Game key of the current configuration. */
	get game(): string | undefined {
		return this.config?.game;
	}

	/**
	 * The opened packs, highest priority first: each mod in load order, then the
	 * merged game packs. Loads them if needed. Also used for the DB tables.
	 */
	async packSources(): Promise<{ label: string; holder: PackHolder }[]> {
		await this.ready();
		return this.sources.map((s) => ({ label: s.folder.replace(`${MODS_FOLDER}/`, ''), holder: s.holder }));
	}

	// ---- VirtualSources (used by the debug adapter) ---------------------------

	uriFor(key: string): string | undefined {
		const w = this.winner(key);
		return w ? vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${w.source.folder}/${w.inner}` }).toString() : undefined;
	}

	read(key: string): string | undefined {
		const w = this.winner(key);
		return w ? w.source.holder.readText(w.inner) ?? undefined : undefined;
	}

	// ---- FileSystemProvider ---------------------------------------------------

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		await this.ready();
		const at = this.resolve(LiveSourceFS.key(uri));
		if (at?.kind === 'root' || at?.kind === 'mods' || (at?.kind === 'pack' && at.source.tree.listDir(at.inner))) {
			return new Entry(vscode.FileType.Directory);
		}
		if (at?.kind === 'pack' && at.source.holder.hasFile(at.inner)) {
			return new Entry(vscode.FileType.File);
		}
		if (LiveSourceFS.key(uri) === '') {
			return new Entry(vscode.FileType.Directory);
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		await this.ready();
		const at = this.resolve(LiveSourceFS.key(uri));
		const name = (folder: string) => folder.slice(folder.lastIndexOf('/') + 1);
		switch (at?.kind) {
			case 'root': {
				// Empty when the game was not found or the packs did not load (see the "TW Lua Debugger" output).
				const top = new Set(this.sources.map((s) => s.folder.split('/')[0]));
				return [...top].sort().map((f) => [f, vscode.FileType.Directory]);
			}
			case 'mods':
				return this.sources.filter((s) => s.folder !== BASEGAME_FOLDER).map((s) => [name(s.folder), vscode.FileType.Directory]);
			case 'pack': {
				const entries = at.source.tree.listDir(at.inner);
				if (entries) {
					return entries.map((e) => [e.name, e.isDir ? vscode.FileType.Directory : vscode.FileType.File]);
				}
			}
		}
		if (LiveSourceFS.key(uri) === '') {
			return [];
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		await this.ready();
		const at = this.resolve(LiveSourceFS.key(uri));
		if (at?.kind === 'pack' && at.inner) {
			if (/\.lua$/i.test(at.inner)) {
				const text = at.source.holder.readText(at.inner);
				if (text !== null) {
					return new TextEncoder().encode(text);
				}
			} else {
				// As stored: DB tables go to the DB table editor, other types to whatever handles them.
				const bytes = at.source.holder.readBytes(at.inner);
				if (bytes) {
					return bytes;
				}
			}
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	writeFile(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	dispose(): void {
		this.watcher?.dispose();
		this.emitter.dispose();
		this.reloaded.dispose();
	}
}

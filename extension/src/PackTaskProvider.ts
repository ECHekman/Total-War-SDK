import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DependencySpec, resolveDependencies, steamappsFolder, workshopPack } from './dependencies';
import { DEFAULT_GAME, GameDefinition, gameByKey, gameForExecutable } from './games';
import { DEBUGGER_PACK_NAME } from './installMod';
import { addModToList, writeModList } from './modList';
import { DbSchema, rpfm } from './rpfm';
import { WorkshopCache, WorkshopItem, cachedWorkshopClient, steamHelperPath, steamWorkshopClient, workshopClosure } from './workshop';

export const PACK_TASK_TYPE = 'pack';

interface PackTaskDefinition extends vscode.TaskDefinition {
	packfilesDirectory: string;
	modName: string;
	executable: string;
	game?: string;
	addToUsedMods?: boolean;
	modListFile?: string;
	/** Also (re)install the debugger mod from this extension and list it in the mod list. */
	includeDebuggerMod?: boolean;
	/** Mods this mod needs; when set, the task writes the whole mod list file. */
	dependencies?: DependencySpec[];
}

/** `pack` tasks: build a .pack from a workspace folder and install it into the game. */
export class PackTaskProvider implements vscode.TaskProvider {
	constructor(private readonly extensionPath: string, private readonly state?: vscode.Memento,
		private readonly schema?: () => Promise<DbSchema>) {}

	provideTasks(): vscode.Task[] {
		return [];
	}

	resolveTask(task: vscode.Task): vscode.Task | undefined {
		const def = task.definition as PackTaskDefinition;
		if (!def.packfilesDirectory || !def.modName || !def.executable) {
			return undefined;
		}
		const folder = task.scope && typeof task.scope === 'object' ? task.scope : vscode.workspace.workspaceFolders?.[0];
		return new vscode.Task(def, task.scope ?? vscode.TaskScope.Workspace, task.name || `pack ${def.modName}`, PACK_TASK_TYPE,
			new vscode.CustomExecution(async () => new PackTaskTerminal(def, folder?.uri.fsPath, this.extensionPath, this.state, this.schema)));
	}
}

class PackTaskTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(
		private readonly def: PackTaskDefinition,
		private readonly workspaceDir: string | undefined,
		private readonly extensionPath: string,
		private readonly state: vscode.Memento | undefined,
		private readonly schema: (() => Promise<DbSchema>) | undefined,
	) {}

	open(): void {
		this.run().then(
			() => this.closeEmitter.fire(0),
			(e: Error) => {
				this.line(`\x1b[31mError: ${e.message}\x1b[0m`);
				this.closeEmitter.fire(1);
			});
	}

	close(): void {
		// nothing to cancel
	}

	private line(text: string): void {
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n') + '\r\n');
	}

	private async run(): Promise<void> {
		const def = this.def;
		if (!this.workspaceDir) {
			throw new Error('Open a workspace folder to use the pack task.');
		}
		let modName = def.modName.trim();
		if (!modName) {
			throw new Error('No modName given.');
		}
		if (!modName.toLowerCase().endsWith('.pack')) {
			modName += '.pack';
		}
		const game = def.game
			?? vscode.workspace.getConfiguration('twdev').get<string>('game')
			?? gameForExecutable(def.executable)?.key
			?? DEFAULT_GAME;

		const sourceDir = path.resolve(this.workspaceDir, def.packfilesDirectory);
		const outDir = path.join(this.workspaceDir, 'out');
		const outPack = path.join(outDir, modName);
		const gameDir = path.dirname(def.executable);
		const installDir = path.join(gameDir, 'data');

		this.line(`Packing ${sourceDir}`);
		this.line(`     -> ${outPack} (${game})`);
		if (!fs.existsSync(sourceDir)) {
			throw new Error(`Folder to pack does not exist: ${sourceDir}`);
		}
		if (!fs.existsSync(installDir)) {
			throw new Error(`Game data folder not found: ${installDir}. Check "executable".`);
		}
		fs.mkdirSync(outDir, { recursive: true });

		// Resolve dependencies before doing anything, so a missing one stops the launch early.
		const declared = def.dependencies ?? [];
		const required = await this.prepareWorkshopItems(declared, gameByKey(game), modName);
		const dependencies = resolveDependencies([...declared, ...required], {
			workspaceDir: this.workspaceDir,
			executable: def.executable,
			game: gameByKey(game),
		});
		for (const dep of dependencies) {
			this.line(`Dependency: ${dep.description}`);
		}

		const count = await rpfm().createPackFromFolderAsync(sourceDir, outPack, game, await this.schemaFor(sourceDir));
		this.line(`Packed ${count} files.`);

		const installed = path.join(installDir, modName);
		fs.copyFileSync(outPack, installed);
		this.line(`Installed to ${installed}`);

		for (const dep of dependencies.filter((d) => d.packFrom)) {
			const target = path.join(installDir, dep.pack);
			const n = await rpfm().createPackFromFolderAsync(dep.packFrom!, target, game, await this.schemaFor(dep.packFrom!));
			this.line(`Packed dependency ${dep.pack} (${n} files) to ${target}`);
		}

		const modList = path.join(gameDir, def.modListFile ?? 'used_mods.txt');
		if (def.includeDebuggerMod) {
			const debuggerPack = path.join(installDir, DEBUGGER_PACK_NAME);
			try {
				await rpfm().createPackFromFolderAsync(path.join(this.extensionPath, 'debuggee'), debuggerPack, game);
				this.line(`Installed the debugger mod to ${debuggerPack}`);
			} catch (e) {
				// e.g. the game is running and holds the file open; the installed copy stays in use
				this.line(`\x1b[33mCould not update the debugger mod (${(e as Error).message}); using the installed one.\x1b[0m`);
			}
		}

		if (declared.length) {
			// The project owns this mod list: write it completely. Highest priority
			// first: this mod (it may override its dependencies), the debugger, then
			// the dependencies in the order they are declared.
			const mods = [modName, ...(def.includeDebuggerMod ? [DEBUGGER_PACK_NAME] : []), ...dependencies.map((d) => d.pack)];
			const dirs = dependencies.map((d) => d.workingDirectory).filter((d): d is string => !!d);
			writeModList(modList, dirs, mods);
			this.line(`Wrote ${modList}: ${mods.length} mods`);
			return;
		}

		if (def.includeDebuggerMod && addModToList(modList, DEBUGGER_PACK_NAME)) {
			this.line(`Added ${DEBUGGER_PACK_NAME} to ${modList}`);
		}

		if (def.addToUsedMods !== false) {
			if (addModToList(modList, modName)) {
				this.line(`Added ${modName} to ${modList}`);
			} else {
				this.line(`${modName} is already in ${modList}`);
			}
		}
	}

	/** The DB schema when `folder` has TSV files (they are packed as binary tables). */
	private async schemaFor(folder: string): Promise<DbSchema | undefined> {
		if (!this.schema || !hasTsv(folder)) {
			return undefined;
		}
		try {
			const schema = await this.schema();
			this.line('Converting .tsv files to binary.');
			return schema;
		} catch (e) {
			this.line(`\x1b[33mNo DB schema (${(e as Error).message}): .tsv DB tables cannot be converted.\x1b[0m`);
			return undefined;
		}
	}

	/**
	 * Makes sure the Workshop items among `declared`, and the items they require,
	 * are downloaded: subscribes to missing ones through Steam (after asking, by
	 * default). Returns the required items that are not declared, to list too.
	 * Without Steam, items that are already there are used as they are.
	 */
	private async prepareWorkshopItems(declared: DependencySpec[], game: GameDefinition, modName: string): Promise<string[]> {
		const ids = declared.filter((s): s is string => typeof s === 'string' && /^\d+$/.test(s.trim())).map((s) => s.trim());
		const config = vscode.workspace.getConfiguration('twdev');
		const mode = config.get<'ask' | 'always' | 'never'>('autoSubscribeDependencies', 'ask');
		const helper = steamHelperPath(this.extensionPath);
		const steamapps = steamappsFolder(this.def.executable);
		if (!ids.length || mode === 'never' || !helper || !steamapps) {
			return [];
		}
		const installed = (id: string) => !!workshopPack(steamapps, game.steamAppId, id);
		const link = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

		const abort = new AbortController();
		const steam = steamWorkshopClient(helper, game.steamAppId, abort.signal);
		const client = this.state ? cachedWorkshopClient(steam, mementoCache(this.state)) : steam;

		let closure: { items: WorkshopItem[]; unknown: string[] };
		try {
			closure = await workshopClosure(ids, client);
		} catch (e) {
			const missing = ids.filter((id) => !installed(id));
			if (!missing.length) {
				this.line(`\x1b[33mCould not ask Steam for the items the Workshop dependencies require (${(e as Error).message}).\x1b[0m`);
				return [];
			}
			throw new Error(`Workshop item ${missing.join(', ')} is not downloaded, and Steam could not download it: ${(e as Error).message}\n`
				+ `Subscribe to it: ${missing.map(link).join(' ')}`, { cause: e });
		}
		for (const id of closure.unknown) {
			this.line(`\x1b[33mSteam does not know Workshop item ${id} (removed, private, or a typo?).\x1b[0m`);
		}

		const declaredSet = new Set(ids);
		const requiredBy = new Map<string, string>();
		for (const item of closure.items) {
			for (const child of item.children) {
				if (!requiredBy.has(child)) {
					requiredBy.set(child, item.title || item.id);
				}
			}
		}
		const extra = closure.items.filter((i) => !declaredSet.has(i.id));
		for (const item of extra) {
			this.line(`Also listing Workshop item ${item.title || item.id} (${item.id}): required by ${requiredBy.get(item.id)}`);
		}

		const toGet = closure.items.filter((i) => !installed(i.id));
		if (!toGet.length) {
			return extra.map((i) => i.id);
		}
		const names = toGet.map((i) => `• ${i.title || i.id}${declaredSet.has(i.id) ? '' : ` (required by ${requiredBy.get(i.id)})`}`).join('\n');
		if (mode === 'ask') {
			const subscribe = 'Subscribe';
			const always = 'Always Subscribe';
			const answer = await vscode.window.showInformationMessage(
				`${modName} needs ${toGet.length} Workshop item${toGet.length > 1 ? 's' : ''} you are not subscribed to. Subscribe and download now?`,
				{ modal: true, detail: `${names}\n\nSteam downloads them like any subscription; unsubscribe on their Workshop pages.` },
				subscribe, always);
			if (!answer) {
				throw new Error(`Not subscribed to: ${toGet.map((i) => `${i.title || i.id} ${link(i.id)}`).join(', ')}`);
			}
			if (answer === always) {
				await config.update('autoSubscribeDependencies', 'always', vscode.ConfigurationTarget.Global);
			}
		}

		this.line(`Subscribing to ${toGet.length} Workshop item(s):\n${names}`);
		const titles = new Map(toGet.map((i) => [i.id, i.title || i.id]));
		const results = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Downloading Workshop items',
			cancellable: true,
		}, (progress, token) => {
			token.onCancellationRequested(() => abort.abort());
			let last = 0;
			return steam.subscribe(toGet.map((i) => i.id), (id, done, total) => {
				const mb = (n: number) => (n / 1048576).toFixed(1);
				progress.report({ message: `${titles.get(id)}: ${mb(done)} / ${mb(total)} MB` });
				if (Date.now() - last > 2000) {
					last = Date.now();
					this.line(`  ${titles.get(id)}: ${mb(done)} / ${mb(total)} MB`);
				}
			});
		});
		const failed = results.filter((r) => r.error || !installed(r.id));
		for (const r of results.filter((x) => !failed.includes(x))) {
			this.line(`Downloaded ${titles.get(r.id)} to ${r.folder}`);
		}
		if (failed.length) {
			throw new Error(failed.map((r) => `${titles.get(r.id)}: ${r.error ?? 'no .pack file after the download'} (${link(r.id)})`).join('\n'));
		}
		return extra.map((i) => i.id);
	}
}

const WORKSHOP_CACHE_KEY = 'twdev.workshopItems';

function mementoCache(state: vscode.Memento): WorkshopCache {
	type Entry = WorkshopItem & { at: number };
	return {
		get: (id) => state.get<Record<string, Entry>>(WORKSHOP_CACHE_KEY, {})[id],
		set: (item) => {
			const all = { ...state.get<Record<string, Entry>>(WORKSHOP_CACHE_KEY, {}), [item.id]: { ...item, at: Date.now() } };
			void state.update(WORKSHOP_CACHE_KEY, all);
		},
	};
}

function hasTsv(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	return entries.some((e) => (e.isDirectory() ? hasTsv(path.join(dir, e.name)) : /\.tsv$/i.test(e.name)));
}

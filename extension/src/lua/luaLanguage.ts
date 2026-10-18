import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { rpfm } from '../rpfm';
import { BASEGAME_FOLDER, LiveSourceFS } from '../SourceFileSystemProvider';
import { generateStubs, parseEventNames } from './apiStubs';

/** Bump when the generator output changes, to regenerate existing stubs. */
const GENERATOR_VERSION = 1;
const LUALS_ID = 'sumneko.lua';

/**
 * Generates LuaLS stubs for the game's script library into the extension's
 * storage (`lua-api/<game>`), regenerating them after a game update, and
 * points the Lua language server at them.
 */
export class LuaApiService implements vscode.Disposable {
	private generating: Promise<string | undefined> | undefined;
	private eventNames: string[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly storageDir: string,
		private readonly sources: LiveSourceFS,
		private readonly log: vscode.OutputChannel,
	) {
		this.disposables.push(sources.onDidReload(() => {
			if (this.managedWorkspace()) {
				void this.refresh(false);
			}
		}));
	}

	/** Script event names of the game (for completion), once stubs were generated. */
	get events(): readonly string[] {
		return this.eventNames;
	}

	/** Folder with the current game's stubs; generates them when missing or out of date. */
	refresh(force: boolean): Promise<string | undefined> {
		this.generating ??= this.generate(force).finally(() => {
			this.generating = undefined;
		});
		return this.generating;
	}

	private async generate(force: boolean): Promise<string | undefined> {
		const exeDir = this.sources.exeDir;
		const game = this.sources.game;
		if (!exeDir || !game) {
			return undefined;
		}
		const dir = path.join(this.storageDir, 'lua-api', game);
		const signature = gameSignature(exeDir, game);
		const signatureFile = path.join(dir, '.signature');
		const eventsFile = path.join(dir, '.events.json');
		if (!force && readText(signatureFile) === signature) {
			if (!this.eventNames.length) {
				try {
					this.eventNames = JSON.parse(readText(eventsFile) ?? '[]') as string[];
				} catch {
					// regenerated next time
				}
			}
			return dir;
		}

		const base = (await this.sources.packSources()).find((s) => s.label === BASEGAME_FOLDER);
		if (!base) {
			return undefined;
		}
		const started = Date.now();
		const sources = base.holder.luaPaths()
			.filter((p) => p.toLowerCase().startsWith('script/'))
			.map((p) => ({ path: p, text: base.holder.readText(p) ?? '' }));
		const stubs = generateStubs(sources);
		const events = sources.find((s) => s.path.toLowerCase() === 'script/events.lua');
		this.eventNames = events ? parseEventNames(events.text) : [];

		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		for (const [name, text] of stubs.files) {
			fs.writeFileSync(path.join(dir, name), text);
		}
		fs.writeFileSync(eventsFile, JSON.stringify(this.eventNames));
		fs.writeFileSync(signatureFile, signature);
		this.log.appendLine(`Lua API: ${stubs.functionCount} functions from ${sources.length} game scripts in ${Date.now() - started} ms -> ${dir}`);
		await this.updateLibrarySetting(dir);
		return dir;
	}

	/** Whether this workspace's Lua settings were set up by `configure` (they name a lua-api folder). */
	private managedWorkspace(): boolean {
		const library = vscode.workspace.getConfiguration('Lua').get<string[]>('workspace.library') ?? [];
		return library.some((l) => isOurLibrary(l, this.storageDir));
	}

	/** Keeps an existing setting pointing at the current game's folder (another game, or another machine). */
	private async updateLibrarySetting(dir: string): Promise<void> {
		if (!vscode.extensions.getExtension(LUALS_ID)) {
			return;
		}
		const config = vscode.workspace.getConfiguration('Lua');
		const library = config.inspect<string[]>('workspace.library')?.workspaceValue;
		if (!library?.some((l) => isOurLibrary(l, this.storageDir))) {
			return;
		}
		const updated = [...library.filter((l) => !isOurLibrary(l, this.storageDir)), dir];
		if (JSON.stringify(updated) !== JSON.stringify(library)) {
			await config.update('workspace.library', updated, vscode.ConfigurationTarget.Workspace);
		}
	}

	/** Command: generate the stubs and set up the Lua language server for this workspace. */
	async configure(): Promise<void> {
		if (!vscode.workspace.workspaceFolders?.length) {
			void vscode.window.showErrorMessage('Open your mod\'s folder first.');
			return;
		}
		if (!vscode.extensions.getExtension(LUALS_ID)) {
			const install = 'Install Lua Extension';
			const answer = await vscode.window.showInformationMessage(
				'Completion, signatures and documentation for the game\'s script functions come from the Lua extension (sumneko.lua, the Lua language server). Install it?',
				{ modal: true }, install);
			if (answer !== install) {
				return;
			}
			await vscode.commands.executeCommand('workbench.extensions.installExtension', LUALS_ID);
			if (!vscode.extensions.getExtension(LUALS_ID)) {
				void vscode.window.showInformationMessage('Run "TotalWar: Set Up Lua IntelliSense" again once the Lua extension is installed.');
				return;
			}
		}
		const dir = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Reading the game\'s script library…' },
			() => this.refresh(true));
		if (!dir) {
			void vscode.window.showErrorMessage('The game was not found. Set "twdev.game", or start a debug session once so the extension knows the install.');
			return;
		}
		await applyLuaSettings(dir, this.storageDir);
		void vscode.window.showInformationMessage('Lua IntelliSense is set up for the game\'s scripts (workspace settings "Lua.*").');
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}

/** Whether the open workspace is a Total War mod project (it sets twdev.game, or has a pack task). */
export function isModWorkspace(): boolean {
	if (vscode.workspace.getConfiguration('twdev').inspect('game')?.workspaceValue !== undefined) {
		return true;
	}
	return (vscode.workspace.workspaceFolders ?? []).some((f) => {
		if (f.uri.scheme !== 'file') {
			return false;
		}
		const tasks = readText(path.join(f.uri.fsPath, '.vscode', 'tasks.json')) ?? '';
		const launch = readText(path.join(f.uri.fsPath, '.vscode', 'launch.json')) ?? '';
		return /"type"\s*:\s*"pack"/.test(tasks) || /"type"\s*:\s*"tw-lua"/.test(launch);
	});
}

const OFFERED_KEY = 'twdev.luaSetupOffered';

/** In a mod project without Lua IntelliSense, offers to set it up (once per workspace). */
export async function offerLuaSetup(state: vscode.Memento, service: LuaApiService): Promise<void> {
	if (state.get<boolean>(OFFERED_KEY) || !isModWorkspace()) {
		return;
	}
	const library = vscode.workspace.getConfiguration('Lua').get<string[]>('workspace.library') ?? [];
	if (library.some((l) => /[\\/]lua-api[\\/]/.test(l))) {
		void service.refresh(false);
		return;
	}
	await state.update(OFFERED_KEY, true);
	const setUp = 'Set Up';
	const answer = await vscode.window.showInformationMessage(
		'Get completion and documentation for the game\'s script functions (cm, core, events, ...) in this mod project?', setUp, 'Not Now');
	if (answer === setUp) {
		await service.configure();
	}
}

function isOurLibrary(entry: string, storageDir: string): boolean {
	const norm = (p: string) => path.normalize(p).toLowerCase();
	return norm(entry).startsWith(norm(path.join(storageDir, 'lua-api')));
}

/** Lua language server settings for Total War scripts, in the workspace settings. */
export async function applyLuaSettings(stubsDir: string, storageDir: string): Promise<void> {
	const config = vscode.workspace.getConfiguration('Lua');
	const target = vscode.ConfigurationTarget.Workspace;
	const library = (config.inspect<string[]>('workspace.library')?.workspaceValue ?? []).filter((l) => !isOurLibrary(l, storageDir));
	const disabled = new Set(config.inspect<string[]>('diagnostics.disable')?.workspaceValue ?? []);
	// Mod scripts share globals between files by design.
	disabled.add('lowercase-global');
	await config.update('runtime.version', 'Lua 5.1', target);
	await config.update('workspace.library', [...library, stubsDir], target);
	await config.update('workspace.checkThirdParty', false, target);
	await config.update('diagnostics.disable', [...disabled], target);
}

/** Changes when the game is updated: its executable and packs. */
export function gameSignature(exeDir: string, game: string): string {
	const hash = createHash('sha1');
	hash.update(`${GENERATOR_VERSION}\n${game}\n`);
	let packs: string[] = [];
	try {
		packs = rpfm().caPackPaths(exeDir, game);
	} catch {
		// no native module: fall back to the data folder listing
		try {
			packs = fs.readdirSync(path.join(exeDir, 'data')).filter((n) => n.endsWith('.pack')).map((n) => path.join(exeDir, 'data', n));
		} catch {
			// nothing
		}
	}
	for (const p of packs.sort()) {
		try {
			const st = fs.statSync(p);
			hash.update(`${p}|${st.size}|${st.mtimeMs}\n`);
		} catch {
			hash.update(`${p}|missing\n`);
		}
	}
	return hash.digest('hex');
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

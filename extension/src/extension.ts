import * as path from 'node:path';
import * as vscode from 'vscode';

import { registerAssetProviders } from './assets/assetProviders';
import { registerDbRefProviders } from './assets/dbRefProviders';
import { CONNECTED_EVENT, TwLuaDebugSession, WAITING_EVENT } from './adapter/session';
import { DecodedEditorProvider, openDecoded } from './decoded/DecodedEditorProvider';
import { DECODED_SCHEME, DecodedFileSystemProvider } from './decoded/DecodedFileSystemProvider';
import { DbEditorProvider, migrateModTable, newDbTable, newLocFile } from './db/DbEditorProvider';
import { DbGridPanel } from './db/DbGridPanel';
import { DbHoverProvider } from './db/dbHover';
import { DbService } from './db/DbService';
import { modConflictReport, ModDiagnostics } from './db/modDiagnostics';
import { cloneEntityCommand, writePlan } from './db/cloneCommand';
import type { ClonePlan } from './db/cloneEntity';
import { DbTreeProvider, tableOf } from './db/DbTreeProvider';
import { DEBUG_TYPE, gameKeyFor, TwDebugConfigurationProvider } from './debugConfig';
import { installDebuggerMod, prepareDebuggerMod } from './installMod';
import { copyToMod } from './modProject';
import { isModWorkspace, LuaApiService, offerLuaSetup } from './lua/luaLanguage';
import { DbKeyLinkProvider, TwLuaCompletionProvider } from './lua/luaProviders';
import { GameTools } from './runtime/gameTools';
import { PACK_TASK_TYPE, PackTaskProvider } from './PackTaskProvider';
import { createProjectFromPack, importPack } from './packCommands';
import { createModProject, pickSaveGame } from './projectCommands';
import { LiveSourceFS, VIRTUAL_ROOT } from './SourceFileSystemProvider';
import { VIRTUAL_SCHEME } from './adapter/pathMapper';
import { filterVirtualFiles } from './virtualFilesFilter';

const VIRTUAL_FOLDER_NAME = 'Virtual TW Source Files';

/** Returned from activate(); used by the extension tests. */
export interface TwLuaDebuggerApi {
	sources: LiveSourceFS;
	db: DbService;
	dbTree: DbTreeProvider;
	dbEditor: DbEditorProvider;
	luaApi: LuaApiService;
	modDiagnostics: ModDiagnostics;
	/** Writes a clone plan into a pack folder (the clone command without its pickers). */
	writeClone(pack: string, modName: string, plan: ClonePlan): Promise<vscode.Uri[]>;
}

export function activate(context: vscode.ExtensionContext): TwLuaDebuggerApi {
	const log = vscode.window.createOutputChannel('Total War Modding Tools');
	const sources = new LiveSourceFS(context.workspaceState, log);
	const db = new DbService(sources, () => ({
		setting: vscode.workspace.getConfiguration('totalwar').get<string>('dbSchemaPath') || undefined,
		downloadDir: path.join(context.globalStorageUri.fsPath, 'schemas'),
		bundledDir: path.join(context.extensionPath, 'schemas'),
	}), log);
	const dbTree = new DbTreeProvider(db, log);
	const luaApi = new LuaApiService(context.globalStorageUri.fsPath, sources, log);
	const modDiagnostics = new ModDiagnostics(db, log, isModWorkspace);
	const assets = registerAssetProviders(sources, context.globalStorageUri.fsPath);
	const dbRefs = registerDbRefProviders(db);
	const decoded = new DecodedFileSystemProvider(sources);
	const dbEditor = new DbEditorProvider(db, context.extensionUri, log);
	const configProvider = new TwDebugConfigurationProvider((config) => {
		sources.configure({
			exeDir: path.dirname(config.executable),
			modListFile: config.modListFile ?? 'used_mods.txt',
			game: gameKeyFor(config),
		}).catch((e: Error) => log.appendLine(`Virtual sources: ${e.message}`));
	});

	context.subscriptions.push(
		log,
		sources,
		vscode.workspace.registerFileSystemProvider(VIRTUAL_SCHEME, sources, { isReadonly: true, isCaseSensitive: false }),
		vscode.tasks.registerTaskProvider(PACK_TASK_TYPE, new PackTaskProvider(context.extensionPath, context.globalState, () => db.schema().then((s) => s.schema))),

		vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider),
		// Offers the detected game in the Run and Debug dropdown without a launch.json.
		vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
			provideDebugConfigurations: () => configProvider.provideDebugConfigurations(),
		}, vscode.DebugConfigurationProviderTriggerKind.Dynamic),

		vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
			// Called after the preLaunchTask, so the mod list it may have written is final.
			createDebugAdapterDescriptor: async (session) => {
				await prepareDebuggerMod(context.extensionPath, session.configuration, log);
				return new vscode.DebugAdapterInlineImplementation(new TwLuaDebugSession({
					workspaceFolders: () => (vscode.workspace.workspaceFolders ?? [])
						.filter((f) => f.uri.scheme === 'file')
						.map((f) => f.uri.fsPath),
					virtualSources: sources,
					database: db,
					modVersion: String(context.extension.packageJSON.version),
				}));
			},
		}),

		vscode.debug.onDidStartDebugSession((session) => {
			if (session.type === DEBUG_TYPE) {
				// The pre-launch pack task may have rewritten the mod list (dependencies).
				sources.reloadIfModListChanged().catch((e: Error) => log.appendLine(`Virtual sources: ${e.message}`));
			}
			// Only in multi-root workspaces: turning a single folder into a workspace
			// restarts the extension host, which would end the debug session.
			if (session.type === DEBUG_TYPE && vscode.workspace.workspaceFile
				&& vscode.workspace.getConfiguration('totalwar').get<boolean>('addVirtualFolderOnDebug', true)) {
				addVirtualFolder(false);
			}
		}),

		registerWaitingNotification(),

		vscode.commands.registerCommand('totalwar.sourceFiles', () => {
			if (!sources.configured) {
				void vscode.window.showInformationMessage('Start a Total War debug session first, so the extension knows where the game is.');
				return;
			}
			addVirtualFolder(true);
		}),
		vscode.commands.registerCommand('totalwar.filterVirtualFiles', () => filterVirtualFiles()),
		...assets.disposables,
		...dbRefs.disposables,
		vscode.workspace.registerFileSystemProvider(DECODED_SCHEME, decoded, { isCaseSensitive: false }),
		vscode.window.registerCustomEditorProvider(DecodedEditorProvider.viewType, new DecodedEditorProvider(decoded)),
		vscode.commands.registerCommand('totalwar.openDecoded', (target?: vscode.Uri) => {
			const uri = target ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			const source = uri instanceof vscode.Uri ? uri : uri instanceof vscode.TabInputCustom || uri instanceof vscode.TabInputText ? uri.uri : undefined;
			return source && openDecoded(decoded, source).then(undefined, (e: Error) => vscode.window.showErrorMessage(e.message));
		}),
		vscode.commands.registerCommand('totalwar.copyToMod', (target?: vscode.Uri) => copyToMod(sources, db, target).catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('totalwar.virtualFiles.exclude')) {
				sources.refilter().then(
					// Expanded folders whose contents changed are only re-read on a refresh.
					() => vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'),
					(e: Error) => log.appendLine(`Virtual sources: ${e.message}`));
			}
		}),
		vscode.commands.registerCommand('totalwar.reloadSourceFiles', () => sources.reload().then(
			() => vscode.window.showInformationMessage('Virtual TW source files reloaded.'),
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		db,
		dbTree,
		...registerDbCommands(db, dbTree, log, context.extensionUri),
		vscode.window.registerCustomEditorProvider(DbEditorProvider.viewType, dbEditor, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: false,
		}),
		vscode.commands.registerCommand('totalwar.newLocFile', (target?: vscode.Uri) => newLocFile(db, target).catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.commands.registerCommand('totalwar.newDbTable', (target?: vscode.Uri) => newDbTable(db, target).catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		luaApi,
		modDiagnostics,
		new GameTools(db, context.extensionUri),
		vscode.commands.registerCommand('totalwar.checkMod', () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Checking the mod\'s DB tables, loc files and asset paths…' },
			async () => await modDiagnostics.run() + await assets.diagnostics.checkWorkspace() + await dbRefs.diagnostics.checkWorkspace()).then(
			(n) => {
				void vscode.commands.executeCommand('workbench.actions.view.problems');
				void vscode.window.showInformationMessage(n ? `${n} problem(s) in the mod's DB tables, loc files and asset paths.` : 'No problems found in the mod\'s DB tables, loc files and asset paths.');
			},
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.commands.registerCommand('totalwar.showModConflicts', () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Comparing the mods in the mod list' },
			(progress) => modConflictReport(sources, db, (message) => progress.report({ message }))).then(
			async (markdown) => {
				const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
				await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
			},
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.commands.registerCommand('totalwar.cloneEntity', (table?: unknown, key?: unknown) => cloneEntityCommand(db,
			typeof table === 'string' ? table : tableOf(table), typeof key === 'string' ? key : undefined).catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.commands.registerCommand('totalwar.migrateDbTable', async (target?: vscode.Uri) => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			const uri = target ?? (tab instanceof vscode.TabInputCustom ? tab.uri : vscode.window.activeTextEditor?.document.uri);
			if (!uri) {
				void vscode.window.showErrorMessage('Open or right-click the DB table file to migrate.');
				return;
			}
			try {
				void vscode.window.showInformationMessage(await migrateModTable(db, uri));
			} catch (e) {
				void vscode.window.showErrorMessage((e as Error).message);
			}
		}),
		vscode.commands.registerCommand('totalwar.configureLuaLanguageServer', () => luaApi.configure().catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.languages.registerCompletionItemProvider({ language: 'lua' }, new TwLuaCompletionProvider(db, () => luaApi.events), '"', "'"),
		vscode.languages.registerDocumentLinkProvider({ language: 'lua', scheme: 'file' }, new DbKeyLinkProvider(db)),
		vscode.commands.registerCommand('totalwar.installDebuggerMod', () => installDebuggerMod(context)),
		vscode.commands.registerCommand('totalwar.createModProject', () => createModProject(context)),
		vscode.commands.registerCommand('totalwar.createProjectFromPack', (target?: vscode.Uri) => createProjectFromPack(context, db, target)),
		vscode.commands.registerCommand('totalwar.importPack', (target?: vscode.Uri) => importPack(db, target).catch(
			(e: Error) => vscode.window.showErrorMessage(e.message))),
		vscode.commands.registerCommand('totalwar.pickSaveGame', () => pickSaveGame()),
	);

	void offerLuaSetup(context.workspaceState, luaApi);
	if (isModWorkspace()) {
		modDiagnostics.schedule(5000);
	}
	return { sources, db, dbTree, dbEditor, luaApi, modDiagnostics, writeClone: (pack, modName, plan) => writePlan(db, pack, modName, plan) };
}

/** The "Game Database" view, grid and hover. */
function registerDbCommands(db: DbService, tree: DbTreeProvider, log: vscode.OutputChannel, extensionUri: vscode.Uri): vscode.Disposable[] {
	const view = vscode.window.createTreeView('totalwar.dbView', { treeDataProvider: tree });
	// Status line above the tree: what is loaded, or why nothing is.
	const showStatus = () => {
		view.message = 'Loading the DB tables…';
		db.describe().then(
			(d) => (view.message = d),
			(e: Error) => {
				view.message = e.message;
				log.appendLine(`DB: ${e.message}`);
			});
	};
	showStatus();
	const showError = (e: Error) => void vscode.window.showErrorMessage(e.message);
	const pickTable = async (): Promise<string | undefined> => {
		try {
			return await vscode.window.showQuickPick(db.tables(), { placeHolder: 'DB table to open' });
		} catch (e) {
			showError(e as Error);
			return undefined;
		}
	};
	return [
		view,
		db.onDidChange(showStatus),
		vscode.languages.registerHoverProvider({ language: 'lua' }, new DbHoverProvider(db)),
		vscode.commands.registerCommand('totalwar.openDbTable', async (arg?: unknown, key?: string) => {
			const table = typeof arg === 'string' ? arg : tableOf(arg) ?? await pickTable();
			if (table) {
				await DbGridPanel.show(db, extensionUri, table, key).catch(showError);
			}
		}),
		vscode.commands.registerCommand('totalwar.filterDbTables', async () => {
			const filter = await vscode.window.showInputBox({ prompt: 'Show tables whose name contains (empty for all)', value: tree.filter });
			if (filter !== undefined) {
				tree.setTableFilter(filter);
				view.description = filter.trim() ? `filter: ${filter.trim()}` : undefined;
			}
		}),
		vscode.commands.registerCommand('totalwar.reloadDb', () => db.invalidate()),
		vscode.commands.registerCommand('totalwar.updateDbSchema', () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Downloading the DB schema…' },
			() => db.updateSchema().then(
				(file) => vscode.window.showInformationMessage(`DB schema updated: ${path.basename(file)}.`),
				showError))),
	];
}

export function deactivate(): void {
	// everything is disposed through context.subscriptions
}

/** Adds the totalwar:/ folder to the workspace (never as the first folder, which would restart extensions). */
function addVirtualFolder(reveal: boolean): void {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.some((f) => f.uri.scheme === VIRTUAL_SCHEME)) {
		if (reveal) {
			void vscode.commands.executeCommand('workbench.view.explorer');
		}
		return;
	}
	if (folders.length === 0) {
		if (reveal) {
			void vscode.window.showInformationMessage('Open a folder first; the virtual source files are added next to it.');
		}
		return;
	}
	if (!vscode.workspace.workspaceFile && vscode.debug.activeDebugSession) {
		void vscode.window.showInformationMessage('Adding a folder turns this window into a multi-root workspace, which restarts extensions and would stop debugging. Stop the debug session first.');
		return;
	}
	vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: VIRTUAL_ROOT, name: VIRTUAL_FOLDER_NAME });
}

/** Shows a cancellable "waiting for the game" notification while a session waits for the game to connect. */
function registerWaitingNotification(): vscode.Disposable {
	const waiting = new Map<string, () => void>();
	const finish = (id: string) => {
		waiting.get(id)?.();
		waiting.delete(id);
	};
	return vscode.Disposable.from(
		vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
			if (e.session.type !== DEBUG_TYPE) {
				return;
			}
			if (e.event === WAITING_EVENT && !waiting.has(e.session.id)) {
				const title = e.body?.mode === 'attach'
					? 'Waiting for Total War to connect (start the game with the debugger mod enabled)...'
					: 'Starting Total War and waiting for the debugger mod to connect...';
				void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
					(_progress, token) => new Promise<void>((resolve) => {
						waiting.set(e.session.id, resolve);
						token.onCancellationRequested(() => {
							finish(e.session.id);
							void vscode.debug.stopDebugging(e.session);
						});
					}));
			} else if (e.event === CONNECTED_EVENT) {
				finish(e.session.id);
			}
		}),
		vscode.debug.onDidTerminateDebugSession((s) => finish(s.id)),
	);
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DEFAULT_GAME, gameByKey, gameForExecutable } from './games';
import { addModToList, parseModList } from './modList';
import { rpfm } from './rpfm';
import { findGameExecutable } from './steam';

export const DEBUGGER_PACK_NAME = 'tw_lua_debugger.pack';

function configuredGame(): string {
	return vscode.workspace.getConfiguration('totalwar').get<string>('game') ?? DEFAULT_GAME;
}

/**
 * Builds the Lua debuggee shipped with the extension into
 * `<game>/data/tw_lua_debugger.pack`. When the pack cannot be written (the
 * running game holds it open) but a copy is installed, that copy stays in use
 * and the reason is returned; otherwise the error is thrown.
 */
export async function buildDebuggerMod(extensionPath: string, executable: string): Promise<string | undefined> {
	const dataDir = path.join(path.dirname(executable), 'data');
	if (!fs.existsSync(dataDir)) {
		throw new Error(`${dataDir} does not exist. Check the game executable.`);
	}
	const game = gameForExecutable(executable)?.key ?? configuredGame();
	const target = path.join(dataDir, DEBUGGER_PACK_NAME);
	try {
		await rpfm().createPackFromFolderAsync(path.join(extensionPath, 'debuggee'), target, game);
		return undefined;
	} catch (e) {
		if (fs.existsSync(target)) {
			return `Could not update ${target} (${(e as Error).message}); using the installed copy.`;
		}
		throw new Error(`Could not build the debugger mod: ${(e as Error).message}`, { cause: e });
	}
}

/**
 * Before a debug session: installs the debugger mod from the extension and, when
 * the extension starts the game, lists it in the session's mod list file. Runs
 * after the preLaunchTask, which may rewrite that file.
 */
export async function prepareDebuggerMod(extensionPath: string, config: vscode.DebugConfiguration, log: vscode.OutputChannel): Promise<void> {
	if (config.installDebuggerMod === false) {
		return;
	}
	const exe = String(config.executable);
	const warning = await buildDebuggerMod(extensionPath, exe);
	if (warning) {
		log.appendLine(warning);
	}
	if (!config.modListFile) {
		return; // the game runs without a mod list
	}
	const modList = path.join(path.dirname(exe), config.modListFile);
	if (config.request === 'launch') {
		if (addModToList(modList, DEBUGGER_PACK_NAME)) {
			log.appendLine(`Added ${DEBUGGER_PACK_NAME} to ${modList}`);
		}
		return;
	}
	const listed = fs.existsSync(modList)
		&& parseModList(fs.readFileSync(modList, 'utf8')).mods.some((m) => m.toLowerCase() === DEBUGGER_PACK_NAME);
	if (!listed) {
		void vscode.window.showWarningMessage(`${DEBUGGER_PACK_NAME} is not in ${path.basename(modList)}. `
			+ 'Enable "tw_lua_debugger" in the game\'s launcher (or run "TotalWar: Install Debugger Mod into Game") and restart the game.');
	}
}

async function pickExecutable(): Promise<string | undefined> {
	const game = gameByKey(configuredGame());
	const detected = await findGameExecutable(game);
	const browse = 'Browse...';
	const items = detected ? [detected, browse] : [browse];
	const choice = items.length === 1 ? browse : await vscode.window.showQuickPick(items, { placeHolder: `Game to install the debugger mod into (${game.title})` });
	if (choice !== browse) {
		return choice;
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Select game executable',
		filters: { 'Game executable': ['exe'] },
	});
	return picked?.[0]?.fsPath;
}

/**
 * The "Install Debugger Mod into Game" command, for games started from their
 * own launcher: installs the pack and adds it to used_mods.txt. Debug sessions
 * started from VS Code do this themselves.
 */
export async function installDebuggerMod(context: vscode.ExtensionContext): Promise<void> {
	const exe = await pickExecutable();
	if (!exe) {
		return;
	}
	let warning: string | undefined;
	try {
		warning = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing the debugger mod...' },
			() => buildDebuggerMod(context.extensionPath, exe));
	} catch (e) {
		void vscode.window.showErrorMessage((e as Error).message);
		return;
	}
	if (warning) {
		void vscode.window.showWarningMessage(`${warning} Close the game and try again.`);
		return;
	}
	addModToList(path.join(path.dirname(exe), 'used_mods.txt'), DEBUGGER_PACK_NAME);
	void vscode.window.showInformationMessage(
		`Installed ${DEBUGGER_PACK_NAME} into the game and added it to used_mods.txt. `
		+ 'When you start the game from its own launcher, enable it there as well.');
}

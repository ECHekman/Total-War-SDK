import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DEFAULT_GAME, gameByKey, gameForExecutable } from './games';
import { addModToList } from './modList';
import { rpfm } from './rpfm';
import { findGameExecutable } from './steam';

export const DEBUGGER_PACK_NAME = 'tw_lua_debugger.pack';

async function pickExecutable(): Promise<string | undefined> {
	const game = gameByKey(vscode.workspace.getConfiguration('twdev').get<string>('game') ?? DEFAULT_GAME);
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
 * Builds the Lua debuggee shipped with the extension into a pack, copies it to
 * the game's data folder and adds it to used_mods.txt.
 */
export async function installDebuggerMod(context: vscode.ExtensionContext): Promise<void> {
	const exe = await pickExecutable();
	if (!exe) {
		return;
	}
	const gameDir = path.dirname(exe);
	const dataDir = path.join(gameDir, 'data');
	if (!fs.existsSync(dataDir)) {
		void vscode.window.showErrorMessage(`${dataDir} does not exist. Select the game's executable.`);
		return;
	}
	const game = gameForExecutable(exe)?.key ?? vscode.workspace.getConfiguration('twdev').get<string>('game') ?? DEFAULT_GAME;
	const sources = path.join(context.extensionPath, 'debuggee');
	const target = path.join(dataDir, DEBUGGER_PACK_NAME);
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing the debugger mod...' },
			() => rpfm().createPackFromFolderAsync(sources, target, game));
	} catch (e) {
		void vscode.window.showErrorMessage(`Could not build the debugger mod: ${(e as Error).message}`);
		return;
	}
	const modList = path.join(gameDir, 'used_mods.txt');
	addModToList(modList, DEBUGGER_PACK_NAME);
	void vscode.window.showInformationMessage(
		`Installed ${DEBUGGER_PACK_NAME} into ${dataDir} and added it to used_mods.txt. `
		+ 'When you start the game from its own launcher, enable it there as well.');
}

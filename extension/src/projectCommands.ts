import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { createProjectFiles, isValidModName } from './createProject';
import { DEFAULT_GAME, gameByKey } from './games';
import { listSaveGames, saveGamesFolder } from './saves';
import { findGameExecutable } from './steam';

export function configuredGame() {
	return gameByKey(vscode.workspace.getConfiguration('totalwar').get<string>('game') ?? DEFAULT_GAME);
}

/**
 * Lets the user pick a campaign save, newest first. Used from launch.json as
 * `${input:...}` with `"type": "command", "command": "totalwar.pickSaveGame"`.
 * Returns undefined (which cancels the launch) when nothing is picked.
 */
export async function pickSaveGame(): Promise<string | undefined> {
	const game = configuredGame();
	const folder = saveGamesFolder(game);
	const saves = listSaveGames(folder);
	if (!saves.length) {
		void vscode.window.showErrorMessage(`No saves found in ${folder}.`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		saves.map((s) => ({ label: s.name.replace(/\.save$/i, ''), description: s.modified.toLocaleString(), save: s.name })),
		{ placeHolder: `${game.title}: campaign save to load`, matchOnDescription: true });
	return picked?.save;
}

/** Copies the example mod project to a new folder, adapted to the user's game install, and opens it. */
export async function createModProject(context: vscode.ExtensionContext): Promise<void> {
	const modName = await vscode.window.showInputBox({
		title: 'Create Mod Project',
		prompt: 'Name of the mod (also the pack name)',
		value: 'my_mod',
		validateInput: (v) => (isValidModName(v) ? undefined : 'Use letters, digits and underscores only.'),
	});
	if (!modName) {
		return;
	}
	const parent = await vscode.window.showOpenDialog({
		title: `Folder to create "${modName}" in`,
		canSelectFolders: true,
		canSelectFiles: false,
		openLabel: 'Create Here',
	});
	if (!parent?.[0]) {
		return;
	}
	const exe = await gameExecutable();
	if (!exe) {
		return;
	}
	const target = path.join(parent[0].fsPath, modName);
	let workspaceFile: string;
	try {
		workspaceFile = createProjectFiles(path.join(context.extensionPath, 'example'), target, modName, exe);
	} catch (e) {
		void vscode.window.showErrorMessage((e as Error).message);
		return;
	}
	await offerToOpen(target, workspaceFile);
}

/** The configured game's executable: found through Steam, else picked by the user. */
export async function gameExecutable(): Promise<string | undefined> {
	const game = configuredGame();
	const exe = await findGameExecutable(game);
	if (exe) {
		return exe;
	}
	const picked = await vscode.window.showOpenDialog({
		title: `${game.title} executable (${game.exe})`,
		canSelectMany: false,
		filters: { 'Game executable': ['exe'] },
	});
	return picked?.[0]?.fsPath;
}

/** Offers to open a project just created. */
export async function offerToOpen(target: string, workspaceFile: string, detail = ''): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		`Created ${target}.${detail} Open it?`, 'Open', 'Open in New Window');
	if (choice && fs.existsSync(workspaceFile)) {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFile),
			{ forceNewWindow: choice === 'Open in New Window' });
	}
}

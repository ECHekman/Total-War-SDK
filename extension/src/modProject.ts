import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { VIRTUAL_SCHEME } from './adapter/pathMapper';
import { cloneEntityCommand } from './db/cloneCommand';
import { DECODED_SCHEME, DecodedFileSystemProvider } from './decoded/DecodedFileSystemProvider';
import { DbService } from './db/DbService';
import { isDbTablePath } from './fileTypes';
import { LiveSourceFS } from './SourceFileSystemProvider';

/** The workspace's pack folder (the one the pack task packs). */
export function modPackFolder(): string | undefined {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((f) => f.uri.scheme === 'file')
		.map((f) => path.join(f.uri.fsPath, 'pack'))
		.find((p) => fs.existsSync(p));
}

/**
 * "TotalWar: Copy to Mod": copies a file of the game's or another mod's packs
 * (a `totalwar:` virtual file) into the mod's pack folder at the same path, as
 * stored in the pack, and opens the copy. The mod's copy then overrides it.
 */
export async function copyToMod(sources: LiveSourceFS, db: DbService, target?: vscode.Uri): Promise<void> {
	let uri = target ?? vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
	if (uri?.scheme === DECODED_SCHEME) {
		uri = DecodedFileSystemProvider.sourceOf(uri); // the JSON view of a game file: copy the file itself
	}
	if (!uri || uri.scheme !== VIRTUAL_SCHEME) {
		void vscode.window.showErrorMessage('Pick a file in the Virtual TW Source Files to copy into the mod.');
		return;
	}
	const pack = modPackFolder();
	if (!pack) {
		void vscode.window.showErrorMessage('Open a mod project (a folder with a "pack" folder) first.');
		return;
	}
	const file = await sources.packFile(uri);
	if (!file) {
		void vscode.window.showErrorMessage(`${uri.path} is not a file in the packs.`);
		return;
	}
	if (isDbTablePath(file.path)) {
		const table = file.path.split('/')[1];
		const choice = await vscode.window.showWarningMessage(
			`Your mod would replace all of ${file.path}, so later game updates to that table would not reach players. Copy one entity of ${table} into the mod's own table instead?`,
			{ modal: true }, 'Copy an Entity…', 'Copy the Whole Table');
		if (choice === 'Copy an Entity…') {
			return cloneEntityCommand(db, table);
		}
		if (choice !== 'Copy the Whole Table') {
			return;
		}
	}
	const dest = path.join(pack, ...file.path.split('/'));
	if (fs.existsSync(dest)) {
		const choice = await vscode.window.showWarningMessage(`The mod already has ${file.path}. Replace it with the copy from ${file.pack}?`,
			{ modal: true }, 'Replace');
		if (choice !== 'Replace') {
			return;
		}
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, file.bytes);
	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(dest));
}

/** The URI of the active editor tab, also for custom editors (DB tables). */
function activeTabUri(): vscode.Uri | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

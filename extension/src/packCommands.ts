import * as path from 'node:path';
import * as vscode from 'vscode';

import { createProjectFiles, isValidModName, modNameForPack } from './createProject';
import { DbService } from './db/DbService';
import { modPackFolder } from './modProject';
import { configuredGame, gameExecutable, offerToOpen } from './projectCommands';
import { rpfm } from './rpfm';
import { findGameExecutable } from './steam';
import { existingFiles, UnpackOptions, UnpackResult, unpackPack } from './unpack';

/** The pack to unpack: the Explorer item, else picked in the game's data folder. */
async function pickPack(target: vscode.Uri | undefined, title: string): Promise<string | undefined> {
	if (target?.scheme === 'file' && /\.pack$/i.test(target.fsPath)) {
		return target.fsPath;
	}
	const exe = await findGameExecutable(configuredGame());
	const picked = await vscode.window.showOpenDialog({
		title,
		canSelectMany: false,
		filters: { 'Pack files': ['pack'] },
		defaultUri: exe ? vscode.Uri.file(path.join(path.dirname(exe), 'data')) : undefined,
	});
	return picked?.[0]?.fsPath;
}

/** How DB tables and loc files are written: the `totalwar.newTableFormat` setting (TSV needs the schema). */
async function unpackOptions(db: DbService, conflict: UnpackOptions['conflict']): Promise<UnpackOptions> {
	const tableFormat = vscode.workspace.getConfiguration('totalwar').get<'binary' | 'tsv'>('newTableFormat', 'binary');
	const schema = tableFormat === 'tsv' ? await db.schema().then((s) => s.schema, () => undefined) : undefined;
	return { game: configuredGame().key, conflict, tableFormat, schema };
}

function summary(r: UnpackResult): string {
	const parts = [`${r.written} file(s) unpacked`];
	if (r.skipped) {
		parts.push(`${r.skipped} kept as they were`);
	}
	if (r.keptBinary.length) {
		parts.push(`${r.keptBinary.length} DB table(s) kept binary (the schema cannot read them as TSV)`);
	}
	return `${parts.join(', ')}.`;
}

/** "TotalWar: Create Project from Pack…": a new mod project whose pack folder holds the pack's files. */
export async function createProjectFromPack(context: vscode.ExtensionContext, db: DbService, target?: vscode.Uri): Promise<void> {
	const packFile = await pickPack(target, 'Pack to make a project from');
	if (!packFile) {
		return;
	}
	const modName = await vscode.window.showInputBox({
		title: 'Create Project from Pack',
		prompt: 'Name of the mod (also the pack name)',
		value: modNameForPack(packFile),
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
	const projectDir = path.join(parent[0].fsPath, modName);
	const options = await unpackOptions(db, 'overwrite');
	const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Unpacking ${path.basename(packFile)}…` }, async () => {
		const workspaceFile = createProjectFiles(path.join(context.extensionPath, 'example'), projectDir, modName, exe, { packContents: false });
		return { workspaceFile, result: unpackPack(rpfm(), packFile, path.join(projectDir, 'pack'), options) };
	}).then(undefined, (e: Error) => {
		void vscode.window.showErrorMessage(e.message);
		return undefined;
	});
	if (done) {
		await offerToOpen(projectDir, done.workspaceFile, ` ${summary(done.result)}`);
	}
}

/** "TotalWar: Import Pack into Project…": unpacks a pack into this project's pack folder. */
export async function importPack(db: DbService, target?: vscode.Uri): Promise<void> {
	const folder = modPackFolder();
	if (!folder) {
		void vscode.window.showErrorMessage('Open a mod project (a folder with a "pack" folder) first.');
		return;
	}
	const packFile = await pickPack(target, 'Pack to import into this project');
	if (!packFile) {
		return;
	}
	const game = configuredGame().key;
	let conflict: UnpackOptions['conflict'] = 'overwrite';
	const existing = existingFiles(rpfm(), packFile, folder, game);
	if (existing.length) {
		const shown = existing.slice(0, 5).join('\n') + (existing.length > 5 ? `\n… and ${existing.length - 5} more` : '');
		const choice = await vscode.window.showWarningMessage(
			`The project already has ${existing.length} of the files in ${path.basename(packFile)}.`,
			{ modal: true, detail: shown }, 'Overwrite', 'Keep Mine');
		if (!choice) {
			return;
		}
		conflict = choice === 'Overwrite' ? 'overwrite' : 'skip';
	}
	const options = await unpackOptions(db, conflict);
	const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(packFile)}…` },
		async () => unpackPack(rpfm(), packFile, folder, options));
	void vscode.window.showInformationMessage(`${path.basename(packFile)}: ${summary(result)}`);
}

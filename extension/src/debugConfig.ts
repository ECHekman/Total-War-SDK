import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DEFAULT_GAME, gameByKey, gameForExecutable } from './games';
import { findGameExecutable } from './steam';

export const DEBUG_TYPE = 'tw-lua';
const LEGACY_TYPE = 'lua';

function configuredGame(): string {
	return vscode.workspace.getConfiguration('twdev').get<string>('game') ?? DEFAULT_GAME;
}

export function gameKeyFor(config: vscode.DebugConfiguration): string {
	return gameForExecutable(String(config.executable ?? ''))?.key ?? configuredGame();
}

/** Fills in and validates `tw-lua` launch/attach configurations. */
export class TwDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	constructor(private readonly onResolved: (config: vscode.DebugConfiguration) => void) {}

	async provideDebugConfigurations(): Promise<vscode.DebugConfiguration[]> {
		const game = gameByKey(configuredGame());
		const exe = (await findGameExecutable(game))?.replace(/\\/g, '/')
			?? `C:/Program Files (x86)/Steam/steamapps/common/${game.steamFolder}/${game.exe}`;
		return [
			{ name: `Launch ${game.title}`, type: DEBUG_TYPE, request: 'launch', executable: exe, modListFile: 'used_mods.txt' },
			{ name: `Attach to ${game.title}`, type: DEBUG_TYPE, request: 'attach', executable: exe },
		];
	}

	async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
		// F5 without a launch.json
		if (!config.type && !config.request && !config.name) {
			const game = gameByKey(configuredGame());
			const exe = await findGameExecutable(game);
			if (!exe) {
				void vscode.window.showErrorMessage(`Could not find ${game.title}. Create a launch.json with the "executable" of the game.`);
				return undefined;
			}
			return { name: `Launch ${game.title}`, type: DEBUG_TYPE, request: 'launch', executable: exe, modListFile: 'used_mods.txt' };
		}
		return config;
	}

	resolveDebugConfigurationWithSubstitutedVariables(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration | null | undefined {
		const exe = String(config.executable ?? '').trim();
		if (!exe) {
			void vscode.window.showErrorMessage('The Total War launch configuration needs an "executable".');
			return null; // opens launch.json
		}
		if (!fs.existsSync(exe)) {
			void vscode.window.showErrorMessage(`The game executable "${exe}" does not exist. Fix "executable" in launch.json.`);
			return null;
		}
		config.executable = exe;
		config.modListFile = config.modListFile ?? 'used_mods.txt';
		if (config.sourceFilesPath && !fs.existsSync(config.sourceFilesPath)) {
			void vscode.window.showWarningMessage(`"sourceFilesPath" ${config.sourceFilesPath} does not exist; it will be ignored.`);
			delete config.sourceFilesPath;
		}
		const looseScripts = path.join(path.dirname(exe), 'script');
		if (fs.existsSync(looseScripts)) {
			void vscode.window.showWarningMessage(`There is a "script" folder next to the game executable (${looseScripts}). The game loads those files instead of the ones in packs.`);
		}
		this.onResolved(config);
		return config;
	}
}

// ---- migration from 1.x ("type": "lua") -------------------------------------

interface LegacyLaunch {
	folder: vscode.WorkspaceFolder;
	configurations: vscode.DebugConfiguration[];
}

function isLegacy(c: vscode.DebugConfiguration): boolean {
	return c?.type === LEGACY_TYPE && typeof c.executable === 'string' && 'modListFile' in c;
}

export function findLegacyConfigurations(): LegacyLaunch[] {
	const result: LegacyLaunch[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const configurations = vscode.workspace.getConfiguration('launch', folder.uri).get<vscode.DebugConfiguration[]>('configurations') ?? [];
		if (configurations.some(isLegacy)) {
			result.push({ folder, configurations });
		}
	}
	return result;
}

export function migrateConfiguration(c: vscode.DebugConfiguration): vscode.DebugConfiguration {
	if (!isLegacy(c)) {
		return c;
	}
	const migrated: vscode.DebugConfiguration = { ...c, type: DEBUG_TYPE };
	delete migrated.encoding; // the new protocol is always UTF-8
	return migrated;
}

export async function migrateLaunchConfigurations(): Promise<number> {
	let count = 0;
	for (const { folder, configurations } of findLegacyConfigurations()) {
		const updated = configurations.map((c) => {
			if (isLegacy(c)) {
				count++;
			}
			return migrateConfiguration(c);
		});
		await vscode.workspace.getConfiguration('launch', folder.uri).update('configurations', updated, vscode.ConfigurationTarget.WorkspaceFolder);
	}
	return count;
}

export async function offerMigration(state: vscode.Memento): Promise<void> {
	const legacy = findLegacyConfigurations();
	if (!legacy.length || state.get('twdev.migrationDismissed')) {
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		'This workspace has launch configurations for TW Lua Debugger 1.x ("type": "lua"). Version 2 uses "type": "tw-lua". Update them?',
		'Update', 'Not now', 'Don\'t ask again');
	if (choice === 'Update') {
		const n = await migrateLaunchConfigurations();
		void vscode.window.showInformationMessage(`Updated ${n} launch configuration(s).`);
	} else if (choice === 'Don\'t ask again') {
		await state.update('twdev.migrationDismissed', true);
	}
}

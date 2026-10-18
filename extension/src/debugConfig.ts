import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DEFAULT_GAME, gameByKey, gameForExecutable } from './games';
import { findGameExecutable } from './steam';

export const DEBUG_TYPE = 'tw-lua';

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

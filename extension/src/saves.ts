import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GameDefinition } from './games';

export interface SaveGame {
	name: string;
	modified: Date;
}

/** Folder with the game's campaign saves (%APPDATA%/The Creative Assembly/<game>/save_games). */
export function saveGamesFolder(game: GameDefinition): string {
	const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
	return path.join(appData, 'The Creative Assembly', game.appDataFolder, 'save_games');
}

/** Save files in a folder, newest first. */
export function listSaveGames(folder: string): SaveGame[] {
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.toLowerCase().endsWith('.save'))
		.map((name) => ({ name, modified: fs.statSync(path.join(folder, name)).mtime }))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

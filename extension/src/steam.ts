import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GameDefinition } from './games';

function steamRoot(): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (process.platform !== 'win32') {
			return resolve(undefined);
		}
		execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, stdout) => {
			if (err) {
				return resolve(undefined);
			}
			const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout);
			resolve(m ? path.normalize(m[1].trim()) : undefined);
		});
	});
}

/** Library folders listed in steamapps/libraryfolders.vdf (plus the Steam folder itself). */
export function parseLibraryFolders(vdf: string): string[] {
	const out: string[] = [];
	const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(vdf))) {
		out.push(m[1].replace(/\\\\/g, '\\'));
	}
	return out;
}

/** Finds the game's executable in the Steam libraries, if installed. */
export async function findGameExecutable(game: GameDefinition): Promise<string | undefined> {
	const root = await steamRoot();
	if (!root) {
		return undefined;
	}
	const libraries = new Set<string>([root]);
	try {
		const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
		parseLibraryFolders(vdf).forEach((p) => libraries.add(path.normalize(p)));
	} catch {
		// no library file: only the default library
	}
	for (const lib of libraries) {
		const exe = path.join(lib, 'steamapps', 'common', game.steamFolder, game.exe);
		if (fs.existsSync(exe)) {
			return exe;
		}
	}
	return undefined;
}

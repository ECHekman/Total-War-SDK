import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ModList {
	/** Folders given with add_working_directory, in file order. */
	workingDirectories: string[];
	/** Pack file names given with mod, in load order. */
	mods: string[];
}

function argument(line: string, keyword: string): string {
	return line.slice(keyword.length).replace(/;\s*$/, '').trim().replace(/^"(.*)"$/, '$1');
}

/** Parses a Total War mod list file (used_mods.txt). */
export function parseModList(text: string): ModList {
	const list: ModList = { workingDirectories: [], mods: [] };
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (/^add_working_directory\b/.test(line)) {
			list.workingDirectories.push(argument(line, 'add_working_directory'));
		} else if (/^mod\b/.test(line)) {
			list.mods.push(argument(line, 'mod'));
		}
	}
	return list;
}

/** Full paths of the mod packs that exist, in load order. */
export function resolveModPacks(list: ModList, exeDir: string): string[] {
	const dirs = [...list.workingDirectories, path.join(exeDir, 'data')];
	const out: string[] = [];
	for (const mod of list.mods) {
		const found = dirs.map((d) => path.join(d, mod)).find((p) => fs.existsSync(p));
		if (found) {
			out.push(found);
		}
	}
	return out;
}

/** Adds `mod "<name>";` to a mod list file unless it is already listed. Returns true if added. */
export function addModToList(modListPath: string, packName: string): boolean {
	const text = fs.existsSync(modListPath) ? fs.readFileSync(modListPath, 'utf8') : '';
	if (parseModList(text).mods.some((m) => m.toLowerCase() === packName.toLowerCase())) {
		return false;
	}
	const sep = text.length === 0 || text.endsWith('\n') ? '' : '\r\n';
	fs.appendFileSync(modListPath, `${sep}mod "${packName}";\r\n`, 'utf8');
	return true;
}

/**
 * How the game decides which mod wins when two mods contain the same file.
 * Confirmed in Total War: WARHAMMER III (see "Total War Lua quirks" in the
 * repository README).
 * - 'alphabetical': by pack file name, first name wins (the mod list order does not matter)
 * - 'first-line': the mod listed first wins
 * - 'last-line': the mod listed last wins
 */
export const MOD_PRIORITY: 'alphabetical' | 'first-line' | 'last-line' = 'first-line';

/** Mod packs (full paths or names) sorted highest priority first, given them in mod list order. */
export function byPriority<T>(inListOrder: T[], name: (item: T) => string): T[] {
	switch (MOD_PRIORITY) {
		case 'first-line':
			return [...inListOrder];
		case 'last-line':
			return [...inListOrder].reverse();
		default:
			return [...inListOrder].sort((a, b) => {
				const x = name(a).toLowerCase();
				const y = name(b).toLowerCase();
				return x < y ? -1 : x > y ? 1 : 0;
			});
	}
}

/** Mod list order for packs given highest priority first. */
export function inListOrder(byPriorityHighFirst: string[]): string[] {
	return MOD_PRIORITY === 'last-line' ? [...byPriorityHighFirst].reverse() : [...byPriorityHighFirst];
}

/**
 * Writes a mod list file owned by a project: working directories, then the
 * mods. `mods` is given highest priority first. Refuses to overwrite the
 * launcher's used_mods.txt.
 */
export function writeModList(modListPath: string, workingDirectories: string[], modsHighPriorityFirst: string[]): void {
	if (path.basename(modListPath).toLowerCase() === 'used_mods.txt') {
		throw new Error('Refusing to rewrite used_mods.txt (the launcher\'s mod list). '
			+ 'Set "modListFile" in the pack task and launch configuration to a project mod list, e.g. "my_mod_mods.txt".');
	}
	const dirs = [...new Set(workingDirectories.map((d) => d.replace(/\\/g, '/')))];
	const mods = [...new Set(inListOrder(modsHighPriorityFirst))];
	const lines = [
		...dirs.map((d) => `add_working_directory "${d}";`),
		...mods.map((m) => `mod "${m}";`),
	];
	fs.writeFileSync(modListPath, lines.join('\r\n') + '\r\n', 'utf8');
}

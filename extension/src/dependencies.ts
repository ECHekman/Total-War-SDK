import * as fs from 'node:fs';
import * as path from 'node:path';

import { GameDefinition } from './games';

/**
 * A dependency as written in tasks.json (`"dependencies"` of a pack task):
 * - `"2789857593"`: a Steam Workshop item id (must be subscribed);
 * - `"some_mod.pack"`: a pack in the game's data folder;
 * - `"D:/mods/other_mod.pack"`: any pack file;
 * - `{ "folder": "../other_mod/pack", "modName": "other_mod.pack" }`: a mod you
 *   develop yourself, packed from that folder before every launch.
 */
export type DependencySpec = string | { folder: string; modName: string };

export interface ResolvedDependency {
	/** Pack file name as listed in the mod list (`mod "<pack>";`). */
	pack: string;
	/** Folder to list with add_working_directory, unless the pack is in the game's data folder. */
	workingDirectory?: string;
	/** Set for folder dependencies: build `pack` from this folder into the data folder. */
	packFrom?: string;
	/** For messages: where it came from. */
	description: string;
}

export interface ResolveContext {
	/** Folder relative paths are resolved against (the workspace folder). */
	workspaceDir: string;
	/** Game executable; its folder holds `data`, and Workshop content sits next to its steamapps folder. */
	executable: string;
	game: GameDefinition;
}

/** `<steamapps>` for an executable installed at `<steamapps>/common/<game>/<exe>`, if it is. */
export function steamappsFolder(executable: string): string | undefined {
	const gameDir = path.dirname(path.resolve(executable));
	const common = path.dirname(gameDir);
	if (path.basename(common).toLowerCase() !== 'common') {
		return undefined;
	}
	return path.dirname(common);
}

/** The pack of a downloaded Workshop item, or undefined when it is not there. */
export function workshopPack(steamapps: string, appId: number, itemId: string): string | undefined {
	const folder = path.join(steamapps, 'workshop', 'content', String(appId), itemId);
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return undefined;
	}
	const pack = names.find((n) => n.toLowerCase().endsWith('.pack'));
	return pack ? path.join(folder, pack) : undefined;
}

function resolveOne(spec: DependencySpec, ctx: ResolveContext): ResolvedDependency {
	const dataDir = path.join(path.dirname(path.resolve(ctx.executable)), 'data');

	if (typeof spec === 'object' && spec) {
		if (!spec.folder || !spec.modName) {
			throw new Error('A folder dependency needs "folder" and "modName".');
		}
		const folder = path.resolve(ctx.workspaceDir, spec.folder);
		if (!fs.existsSync(folder)) {
			throw new Error(`Dependency folder ${folder} does not exist.`);
		}
		const pack = spec.modName.toLowerCase().endsWith('.pack') ? spec.modName : `${spec.modName}.pack`;
		return { pack, packFrom: folder, description: `${pack} (packed from ${folder})` };
	}

	const value = String(spec).trim();
	if (/^\d+$/.test(value)) {
		const steamapps = steamappsFolder(ctx.executable);
		if (!steamapps) {
			throw new Error(`Workshop item ${value}: the game is not installed in a Steam library folder, so the Workshop content cannot be found.`);
		}
		const pack = workshopPack(steamapps, ctx.game.steamAppId, value);
		if (!pack) {
			throw new Error(`Workshop item ${value} is not downloaded. Subscribe to it: https://steamcommunity.com/sharedfiles/filedetails/?id=${value}`);
		}
		return {
			pack: path.basename(pack),
			workingDirectory: path.dirname(pack),
			description: `${path.basename(pack)} (Workshop item ${value})`,
		};
	}

	if (value.toLowerCase().endsWith('.pack')) {
		if (!/[\\/]/.test(value)) {
			const inData = path.join(dataDir, value);
			if (!fs.existsSync(inData)) {
				throw new Error(`Dependency ${value} is not in ${dataDir}.`);
			}
			return { pack: value, description: `${value} (game data folder)` };
		}
		const file = path.resolve(ctx.workspaceDir, value);
		if (!fs.existsSync(file)) {
			throw new Error(`Dependency ${file} does not exist.`);
		}
		return { pack: path.basename(file), workingDirectory: path.dirname(file), description: file };
	}

	throw new Error(`Cannot understand dependency "${value}": use a Workshop item id, a .pack name or path, or { "folder", "modName" }.`);
}

/** Resolves all dependencies, or throws with a message for the first that cannot be found. */
export function resolveDependencies(specs: DependencySpec[], ctx: ResolveContext): ResolvedDependency[] {
	return specs.map((s) => resolveOne(s, ctx));
}

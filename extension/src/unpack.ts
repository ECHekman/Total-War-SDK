import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DbSchema, RpfmModule } from './rpfm';
import { isDbTablePath } from './fileTypes';

export interface UnpackOptions {
	game: string;
	/** For files the folder already has: replace them, or keep the folder's. */
	conflict: 'overwrite' | 'skip';
	/** DB tables and loc files as the game's binary files, or as RPFM's TSV text (needs `schema` for DB tables). */
	tableFormat: 'binary' | 'tsv';
	schema?: DbSchema;
}

export interface UnpackResult {
	written: number;
	/** Files the folder already had and kept (conflict `skip`). */
	skipped: number;
	/** DB tables that stayed binary although TSV was asked for (the schema cannot decode them). */
	keptBinary: string[];
}

/** A pack path that stays inside the folder it is unpacked into. */
export function isSafePackPath(packPath: string): boolean {
	const parts = packPath.replace(/\\/g, '/').split('/');
	return parts.length > 0 && parts.every((p) => p !== '' && p !== '.' && p !== '..' && !p.includes(':'));
}

function isLoc(packPath: string): boolean {
	return /\.loc$/i.test(packPath);
}

/**
 * The files on disk that a file of a pack would be in a project's pack folder:
 * its own path, and for DB tables and loc files also the TSV form (both pack to
 * the same file).
 */
export function diskForms(packFolder: string, packPath: string): string[] {
	const file = path.join(packFolder, ...packPath.split('/'));
	return isDbTablePath(packPath) || isLoc(packPath) ? [file, `${file}.tsv`] : [file];
}

/** Paths of the pack's files that the folder already has (in either form). */
export function existingFiles(lib: RpfmModule, packFile: string, packFolder: string, game: string): string[] {
	const holder = lib.openPacks([packFile], game);
	return holder.paths().filter((p) => isSafePackPath(p) && diskForms(packFolder, p).some((f) => fs.existsSync(f)));
}

/**
 * Unpacks every file of a pack into a project's pack folder at its path in the
 * pack, so packing the folder gives the mod back. Paths that would leave the
 * folder are refused.
 */
export function unpackPack(lib: RpfmModule, packFile: string, packFolder: string, options: UnpackOptions): UnpackResult {
	const holder = lib.openPacks([packFile], options.game);
	const paths = holder.paths();
	const unsafe = paths.filter((p) => !isSafePackPath(p));
	if (unsafe.length) {
		throw new Error(`${path.basename(packFile)} has paths outside the pack: ${unsafe.slice(0, 3).join(', ')}`);
	}
	const result: UnpackResult = { written: 0, skipped: 0, keptBinary: [] };
	for (const packPath of paths) {
		const forms = diskForms(packFolder, packPath);
		if (forms.some((f) => fs.existsSync(f))) {
			if (options.conflict === 'skip') {
				result.skipped++;
				continue;
			}
			forms.forEach((f) => fs.rmSync(f, { force: true }));
		}
		const bytes = holder.readBytes(packPath);
		if (!bytes) {
			continue;
		}
		const file = forms[0];
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const table = isDbTablePath(packPath) || isLoc(packPath);
		if (table && options.tableFormat === 'tsv') {
			try {
				if (!options.schema) {
					throw new Error('no schema');
				}
				lib.binaryToTsv(bytes, packPath, options.schema, `${file}.tsv`);
				result.written++;
				continue;
			} catch {
				fs.rmSync(`${file}.tsv`, { force: true });
				result.keptBinary.push(packPath);
			}
		}
		fs.writeFileSync(file, bytes);
		result.written++;
	}
	return result;
}

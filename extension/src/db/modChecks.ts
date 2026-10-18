/**
 * Checks of a mod's own DB tables and loc files against the game: the problems
 * that otherwise show up as a crash at startup or as missing text in game.
 *
 * No VS Code dependency (unit tested).
 */
import type { Cell } from './dbTableModel';
import type { DbField } from './effective';

/** A DB table fragment of the mod, decoded. */
export interface ModTable {
	table: string;
	fileName: string;
	version: number;
	fields: DbField[];
	rows: Cell[][];
}

export interface CheckContext {
	/** Keys of a table as the game has them (plus the mod's other files); undefined when the game lacks the table. */
	keys(table: string): Set<string> | undefined;
	/** Version of the game's own fragment of a table. */
	gameVersion(table: string): number | undefined;
	/** Whether the game (without this file) already has a row with this key: then it is no new row. */
	inGame(table: string, key: string): boolean;
	/** Columns of a table whose values the game shows from loc (`<table>_<column>_<key>`). */
	localisedColumns(table: string): string[];
	/** Whether a loc key exists in the game, the mod list or the mod's own loc files. */
	hasLoc(key: string): boolean;
}

export interface Problem {
	severity: 'error' | 'warning' | 'info';
	code: 'outdated-version' | 'duplicate-key' | 'broken-reference' | 'missing-loc' | 'unknown-table';
	message: string;
	/** Row index in the file, when the problem is about a row. */
	row?: number;
}

/** Most problems listed per kind and file; the rest are summarised. */
const MAX_PER_KIND = 50;

/** Usual names of localised columns, which are often not in the table's binary layout. */
export const LOC_COLUMN_NAMES = ['onscreen_name', 'name', 'description', 'short_description', 'tooltip', 'title', 'localised_name', 'localised_description'];

/** Loc key prefix of a table: `land_units_tables` -> `land_units`. */
export function locPrefix(table: string): string {
	return table.replace(/_tables$/, '');
}

export function rowKey(fields: DbField[], row: Cell[]): string | undefined {
	const keys = fields.map((f, i) => (f.isKey ? row[i] : undefined)).filter((v) => v !== undefined);
	return keys.length ? keys.map(String).join(' | ') : undefined;
}

export function checkModTable(file: ModTable, ctx: CheckContext): Problem[] {
	const problems: Problem[] = [];
	const counts = new Map<string, number>();
	const add = (p: Problem) => {
		const n = (counts.get(p.code) ?? 0) + 1;
		counts.set(p.code, n);
		if (n <= MAX_PER_KIND) {
			problems.push(p);
		}
	};

	const gameVersion = ctx.gameVersion(file.table);
	if (ctx.keys(file.table) === undefined && gameVersion === undefined) {
		add({ severity: 'warning', code: 'unknown-table', message: `The game has no table ${file.table}: check the folder name.` });
	}
	if (gameVersion !== undefined && file.version !== gameVersion) {
		add({
			severity: 'error',
			code: 'outdated-version',
			message: `${file.table} is version ${file.version}, the game uses version ${gameVersion}: the game will crash or ignore it. `
				+ 'Run "TotalWar: Migrate DB Table to the Game\'s Version".',
		});
	}

	const keyColumns = file.fields.filter((f) => f.isKey).length;
	const seen = new Map<string, number>();
	file.rows.forEach((row, r) => {
		const key = keyColumns ? rowKey(file.fields, row) : undefined;
		if (key !== undefined) {
			const first = seen.get(key);
			if (first !== undefined) {
				add({ severity: 'warning', code: 'duplicate-key', row: r, message: `Row ${r + 1}: key "${key}" repeats row ${first + 1}; the game uses only the first.` });
			} else {
				seen.set(key, r);
			}
		}

		file.fields.forEach((field, c) => {
			const value = row[c];
			if (!field.refTable || typeof value !== 'string' || value === '') {
				return;
			}
			const keys = ctx.keys(field.refTable);
			if (keys && !keys.has(value)) {
				add({
					severity: 'error',
					code: 'broken-reference',
					row: r,
					message: `Row ${r + 1}${key ? ` (${key})` : ''}: ${field.name} "${value}" is not a key of ${field.refTable}.`,
				});
			}
		});

		// New rows need their texts (an existing row keeps the game's).
		if (keyColumns === 1 && key !== undefined && !ctx.inGame(file.table, key)) {
			for (const column of ctx.localisedColumns(file.table)) {
				const locKey = `${locPrefix(file.table)}_${column}_${key}`;
				if (!ctx.hasLoc(locKey)) {
					add({ severity: 'warning', code: 'missing-loc', row: r, message: `Row ${r + 1} (${key}): no loc text "${locKey}"; the game shows an empty ${column}.` });
				}
			}
		}
	});

	for (const [code, n] of counts) {
		if (n > MAX_PER_KIND) {
			problems.push({ severity: 'info', code: code as Problem['code'], message: `${n - MAX_PER_KIND} more ${code.replace('-', ' ')} problems in this file.` });
		}
	}
	return problems;
}

/** Duplicate keys in a mod's loc file. */
export function checkLocRows(rows: Cell[][]): Problem[] {
	const problems: Problem[] = [];
	const seen = new Map<string, number>();
	rows.forEach((row, r) => {
		const key = String(row[0] ?? '');
		const first = seen.get(key);
		if (first !== undefined) {
			if (problems.length < MAX_PER_KIND) {
				problems.push({ severity: 'warning', code: 'duplicate-key', row: r, message: `Row ${r + 1}: loc key "${key}" repeats row ${first + 1}; the game uses only the first.` });
			}
		} else {
			seen.set(key, r);
		}
	});
	return problems;
}

/**
 * Columns of a table that are localised: those for which the game has loc
 * entries `<table>_<column>_<key>` for (most of) the sampled keys.
 */
export function guessLocalisedColumns(table: string, fields: DbField[], sampleKeys: string[], hasLoc: (key: string) => boolean): string[] {
	if (!sampleKeys.length) {
		return [];
	}
	const prefix = locPrefix(table);
	const candidates = new Set(fields.filter((f) => !f.isKey).map((f) => f.name));
	// Localised columns are often not in the schema's binary layout at all
	// (the text lives only in loc): try the usual names too.
	for (const name of LOC_COLUMN_NAMES) {
		candidates.add(name);
	}
	const found: string[] = [];
	for (const column of candidates) {
		const hits = sampleKeys.filter((k) => hasLoc(`${prefix}_${column}_${k}`)).length;
		if (hits * 2 > sampleKeys.length) {
			found.push(column);
		}
	}
	return found.sort();
}

/** One mod's rows that another mod's rows also have, and who wins. */
export interface KeyConflict {
	table: string;
	key: string;
	/** Pack whose row the game uses. */
	winner: string;
	/** Other mod packs with the key (not the game). */
	losers: string[];
}

export interface FileConflict {
	path: string;
	winner: string;
	losers: string[];
}

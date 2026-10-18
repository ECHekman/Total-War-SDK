/**
 * Effective DB tables: the rows the game actually uses after merging the
 * table fragments of the game and of the mods in the mod list.
 *
 * No VS Code dependency: also used by the debug adapter and the unit tests.
 */
import type { DbField, DbFile, DbTable, DbValue } from '../../../rpfm-interface/rpfm-interface';

export type { DbField, DbValue };

/** Where a table fragment came from. */
export interface FragmentSource {
	/** Pack file name (e.g. `db.pack`, `my_mod.pack`). */
	pack: string;
	/** Path in the pack: `db/<table>/<file>`. */
	path: string;
}

export interface Fragment extends FragmentSource {
	data: DbTable;
}

/** A row as the game sees it, plus the rows with the same key it replaced. */
export interface EffectiveRow {
	/** Key column values joined with ` | ` (`#<n>` for tables without a key). */
	key: string;
	/** Values in the order of `EffectiveTable.columns`; undefined for columns its fragment lacks. */
	values: (DbValue | undefined)[];
	source: FragmentSource;
	/** Rows with the same key from fragments that load later, so lose. */
	overridden: { source: FragmentSource; values: (DbValue | undefined)[] }[];
}

export interface EffectiveTable {
	name: string;
	columns: DbField[];
	rows: EffectiveRow[];
	byKey: Map<string, EffectiveRow>;
	/** Fragments in load order (the first one wins a key). */
	fragments: FragmentSource[];
	/** Fragments that could not be decoded. */
	errors: string[];
}

/** Packs of one source (a mod, or the merged game packs) and their DB fragments. */
export interface PackFiles<T = unknown> {
	/** Name shown for fragments without a pack name. */
	label: string;
	files: DbFile[];
	/** Passed through to the selected fragments (e.g. the pack holder to decode them with). */
	owner?: T;
}

export const KEY_SEPARATOR = ' | ';

/** File name part of `db/<table>/<file>`. */
export function fragmentName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Load order of the fragments of one table: by file name, case-insensitive
 * ordinal (`!` < digits < `_` < letters). The first fragment with a key wins,
 * which is why mods name their fragments `!!!my_mod` to beat the game's `data__`.
 */
export function compareFragments(a: FragmentSource, b: FragmentSource): number {
	const x = fragmentName(a.path).toLowerCase();
	const y = fragmentName(b.path).toLowerCase();
	return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The fragments of a table that the game loads. `sources` is highest priority
 * first; a fragment path found in several of them is taken from the first
 * (a mod's `db/x/data__` replaces the game's).
 */
export function selectFragments<T>(sources: PackFiles<T>[], table: string): (FragmentSource & { owner?: T })[] {
	const seen = new Map<string, FragmentSource & { owner?: T }>();
	for (const source of sources) {
		for (const f of source.files) {
			const lower = f.path.toLowerCase();
			if (f.table === table && !seen.has(lower)) {
				seen.set(lower, { pack: f.pack ?? source.label, path: f.path, owner: source.owner });
			}
		}
	}
	return [...seen.values()].sort(compareFragments);
}

/** All table names in the sources, sorted. */
export function tableNames(sources: PackFiles[]): string[] {
	const names = new Set<string>();
	for (const source of sources) {
		for (const f of source.files) {
			names.add(f.table);
		}
	}
	return [...names].sort();
}

/**
 * Merges decoded fragments (in load order) into the effective table.
 * Columns follow the fragment with the newest definition; other fragments are
 * mapped onto them by column name.
 */
export function mergeFragments(name: string, fragments: Fragment[], errors: string[] = []): EffectiveTable {
	const newest = fragments.reduce<Fragment | undefined>((best, f) =>
		f.data.fields.length && (!best || f.data.version > best.data.version) ? f : best, undefined);
	const columns = [...(newest?.data.fields ?? [])];
	const position = new Map(columns.map((c, i) => [c.name, i]));
	for (const f of fragments) {
		for (const field of f.data.fields) {
			if (!position.has(field.name)) {
				position.set(field.name, columns.length);
				columns.push(field);
			}
		}
	}
	const keyColumns = columns.map((c, i) => (c.isKey ? i : -1)).filter((i) => i >= 0);

	const rows: EffectiveRow[] = [];
	const byKey = new Map<string, EffectiveRow>();
	for (const f of fragments) {
		const map = f.data.fields.map((field) => position.get(field.name)!);
		const source: FragmentSource = { pack: f.pack, path: f.path };
		for (const raw of f.data.rows) {
			const values: (DbValue | undefined)[] = new Array(columns.length).fill(undefined);
			raw.forEach((v, i) => (values[map[i]] = v));
			const key = keyColumns.length
				? keyColumns.map((i) => String(values[i] ?? '')).join(KEY_SEPARATOR)
				: `#${rows.length}`;
			const winner = byKey.get(key);
			if (winner) {
				winner.overridden.push({ source, values });
				continue;
			}
			const row: EffectiveRow = { key, values, source, overridden: [] };
			rows.push(row);
			byKey.set(key, row);
		}
	}
	return { name, columns, rows, byKey, fragments: fragments.map(({ pack, path }) => ({ pack, path })), errors };
}

/** A value as shown in the UI. */
export function formatValue(value: DbValue | undefined, field?: DbField): string {
	if (value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' && field && /^F(32|64)$/.test(field.fieldType)) {
		return String(Math.round(value * 10000) / 10000);
	}
	return String(value);
}

/** Read access to the effective tables; implemented by DbService. */
export interface GameDatabase {
	/** Table names, sorted. Rejects when no schema or packs are available. */
	tables(): Promise<string[]>;
	table(name: string): Promise<EffectiveTable>;
	/** Tables with a single-column key that contain `key`, from a background index. */
	findKey(key: string): Promise<{ table: string; row: EffectiveRow }[]>;
}

/** What a row of a fragment does in the game, given the table without that fragment. */
export interface RowEffect {
	kind: 'new' | 'wins' | 'loses' | 'duplicate';
	/** The row it replaces (wins) or that replaces it (loses). */
	other?: FragmentSource;
	/** Column index (in the fragment's fields) -> the value it replaces, for cells that differ. */
	changed?: Record<number, string>;
}

/**
 * The effect of each row of `file` (columns `fields`): a new key, replacing the
 * current winner (its file sorts first), losing to it, or repeating a key
 * earlier in the same file (the earlier row wins). `others` is the effective
 * table without this fragment.
 */
export function fragmentEffect(file: FragmentSource, fields: DbField[], rows: (DbValue | undefined)[][], others: EffectiveTable): RowEffect[] {
	const keyColumns = fields.map((f, i) => (f.isKey ? i : -1)).filter((i) => i >= 0);
	const otherColumn = new Map(others.columns.map((c, i) => [c.name, i]));
	const seen = new Set<string>();
	return rows.map((values) => {
		if (!keyColumns.length) {
			return { kind: 'new' };
		}
		const key = keyColumns.map((i) => String(values[i] ?? '')).join(KEY_SEPARATOR);
		if (seen.has(key)) {
			return { kind: 'duplicate' };
		}
		seen.add(key);
		const winner = others.byKey.get(key);
		if (!winner) {
			return { kind: 'new' };
		}
		if (compareFragments(file, winner.source) >= 0) {
			return { kind: 'loses', other: winner.source };
		}
		const changed: Record<number, string> = {};
		fields.forEach((f, i) => {
			const j = otherColumn.get(f.name);
			const old = j === undefined ? undefined : winner.values[j];
			if (j !== undefined && old !== values[i] && !(typeof old === 'number' && typeof values[i] === 'number' && Math.abs(old - (values[i] as number)) < 1e-4)) {
				changed[i] = formatValue(old, f);
			}
		});
		return { kind: 'wins', other: winner.source, changed };
	});
}

/** Whether a fragment with this file name loses every shared key to the game's `data__`. */
export function sortsAfterGame(path: string): boolean {
	return compareFragments({ pack: '', path }, { pack: '', path: 'db/x/data__' }) > 0;
}

/** Copies effective rows into a fragment's column layout (by column name). */
export function mapRows(from: EffectiveTable, rows: EffectiveRow[], fields: DbField[]): (DbValue | undefined)[][] {
	const column = new Map(from.columns.map((c, i) => [c.name, i]));
	return rows.map((r) => fields.map((f) => {
		const i = column.get(f.name);
		return i === undefined ? undefined : r.values[i];
	}));
}

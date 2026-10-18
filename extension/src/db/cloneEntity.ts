/**
 * Plans the copy of a game entity (a unit, building, effect bundle, ...) under
 * a new key: the row itself, the rows that belong to it, and its loc texts.
 *
 * - Rows "belong" to the entity when their key contains the entity's key
 *   (`wh_main_emp_inf_swordsmen` in main_units, land_units, unit_variants...):
 *   found through the references of cloned rows and through rows of other
 *   tables that reference a cloned row. They are copied with the key renamed.
 * - Link rows of tables keyed by several columns (e.g. a unit and a building)
 *   that reference a cloned row are copied with the reference renamed.
 * - Everything else a cloned row references (factions, categories, ...) is
 *   shared: the copies reference the same rows.
 *
 * No VS Code dependency (unit tested).
 */
import { EffectiveRow, EffectiveTable, KEY_SEPARATOR } from './effective';
import { LOC_COLUMN_NAMES, locPrefix } from './modChecks';

export interface CloneData {
	/** The effective table, or undefined when the game has none. */
	table(name: string): Promise<EffectiveTable | undefined>;
	/** Columns of other tables that reference `name`'s key. */
	referencing(name: string): Promise<{ table: string; column: string }[]>;
	/** A loc text, if the key exists. */
	loc(key: string): { text: string; tooltip: boolean } | undefined;
}

export interface PlannedRow {
	table: string;
	oldKey: string;
	newKey: string;
	/** Values in the order of the effective table's columns, references renamed. */
	values: (string | number | boolean | undefined)[];
	/** Why it is copied, for the preview. */
	reason: string;
}

export interface PlannedLoc {
	oldKey: string;
	newKey: string;
	text: string;
	tooltip: boolean;
}

export interface ClonePlan {
	rows: PlannedRow[];
	loc: PlannedLoc[];
	/** Tables with rows referencing a copied row that are not copied (single key not containing the entity's key). */
	skipped: { table: string; count: number }[];
}

/** Rows visited at most; an entity rarely has more than a few dozen. */
const MAX_ROWS = 500;

export async function planClone(rootTable: string, rootKey: string, newRootKey: string, data: CloneData): Promise<ClonePlan> {
	if (!rootKey || !newRootKey || rootKey === newRootKey) {
		throw new Error('The new key must differ from the old one.');
	}
	const rename = (key: string) => key.split(rootKey).join(newRootKey);
	const belongs = (key: string) => key.includes(rootKey);

	const tables = new Map<string, EffectiveTable | undefined>();
	const tableOf = async (name: string) => {
		if (!tables.has(name)) {
			tables.set(name, await data.table(name));
		}
		return tables.get(name);
	};

	const root = (await tableOf(rootTable))?.byKey.get(rootKey);
	if (!root) {
		throw new Error(`${rootTable} has no row "${rootKey}".`);
	}

	/** table -> old key -> planned row */
	const planned = new Map<string, Map<string, PlannedRow>>();
	const queue: { table: string; row: EffectiveRow; newKey: string; reason: string }[] = [{ table: rootTable, row: root, newKey: newRootKey, reason: 'the entity' }];
	const skipped = new Map<string, number>();
	/** Next free id of tables keyed by a number. */
	const nextIds = new Map<string, number>();
	const add = (table: string, row: EffectiveRow, newKey: string, reason: string) => {
		if (planned.get(table)?.has(row.key) || queue.some((q) => q.table === table && q.row.key === row.key)) {
			return;
		}
		queue.push({ table, row, newKey, reason });
	};

	let count = 0;
	while (queue.length && count < MAX_ROWS) {
		const { table, row, newKey, reason } = queue.shift()!;
		const t = (await tableOf(table))!;
		const map = planned.get(table) ?? new Map<string, PlannedRow>();
		planned.set(table, map);
		map.set(row.key, { table, oldKey: row.key, newKey, values: [...row.values], reason });
		count++;

		// Rows it references that belong to the entity.
		for (let c = 0; c < t.columns.length; c++) {
			const col = t.columns[c];
			const value = row.values[c];
			if (!col.refTable || col.isKey || typeof value !== 'string' || !belongs(value)) {
				continue;
			}
			const target = (await tableOf(col.refTable))?.byKey.get(value);
			if (target) {
				add(col.refTable, target, rename(value), `${table}.${col.name} of ${row.key}`);
			}
		}

		// Rows of other tables that reference it (only single-key rows can be referenced).
		if (row.key.includes(KEY_SEPARATOR)) {
			continue;
		}
		for (const ref of await data.referencing(table)) {
			const other = await tableOf(ref.table);
			if (!other) {
				continue;
			}
			const c = other.columns.findIndex((x) => x.name === ref.column);
			if (c < 0) {
				continue;
			}
			const keyColumns = other.columns.filter((x) => x.isKey).length;
			for (const r of other.rows) {
				if (r.values[c] !== row.key) {
					continue;
				}
				if (keyColumns === 1 && belongs(r.key)) {
					add(ref.table, r, rename(r.key), `references ${row.key}`);
				} else if (keyColumns > 1 && other.columns[c].isKey) {
					// A link row: its key changes with the renamed reference.
					const newLink = other.columns
						.map((x, i) => (x.isKey ? (i === c ? newKey : String(r.values[i] ?? '')) : undefined))
						.filter((v) => v !== undefined)
						.join(KEY_SEPARATOR);
					add(ref.table, r, newLink, `links ${row.key}`);
				} else if (keyColumns === 1) {
					// Its own key (an id, or a name not derived from the entity's): a new one.
					const keyCol = other.columns.findIndex((x) => x.isKey);
					const numeric = /^(Optional)?I(16|32|64)$/.test(other.columns[keyCol].fieldType);
					let generated: string;
					if (numeric) {
						const used = nextIds.get(ref.table) ?? Math.max(0, ...other.rows.map((x) => Number(x.key)).filter(Number.isFinite)) + 1000;
						nextIds.set(ref.table, used + 1);
						generated = String(used);
					} else {
						generated = `${r.key}_${newRootKey}`;
					}
					add(ref.table, r, generated, `references ${row.key} (new key)`);
				} else {
					skipped.set(ref.table, (skipped.get(ref.table) ?? 0) + 1);
				}
			}
		}
	}

	// Rename references between copied rows.
	const renamedKey = (table: string | undefined, key: string) => (table ? planned.get(table)?.get(key)?.newKey : undefined);
	const rows: PlannedRow[] = [];
	for (const [table, map] of planned) {
		const t = tables.get(table)!;
		for (const p of map.values()) {
			p.values = p.values.map((v, i) => {
				const col = t.columns[i];
				if (col.isKey && !p.oldKey.includes(KEY_SEPARATOR)) {
					return typeof v === 'number' ? Number(p.newKey) : p.newKey;
				}
				if (typeof v !== 'string') {
					return v;
				}
				return renamedKey(col.refTable, v) ?? (col.isKey && belongs(v) ? rename(v) : v);
			});
			rows.push(p);
		}
	}

	// Their texts.
	const loc: PlannedLoc[] = [];
	for (const p of rows) {
		if (p.oldKey.includes(KEY_SEPARATOR)) {
			continue;
		}
		const t = tables.get(p.table)!;
		const prefix = locPrefix(p.table);
		for (const column of new Set([...LOC_COLUMN_NAMES, ...t.columns.map((c) => c.name)])) {
			const entry = data.loc(`${prefix}_${column}_${p.oldKey}`);
			if (entry) {
				loc.push({ oldKey: `${prefix}_${column}_${p.oldKey}`, newKey: `${prefix}_${column}_${p.newKey}`, text: entry.text, tooltip: entry.tooltip });
			}
		}
	}

	// Belonging rows whose own references point outside: skipped counts only for tables not copied.
	for (const table of planned.keys()) {
		skipped.delete(table);
	}
	return { rows, loc, skipped: [...skipped].map(([table, n]) => ({ table, count: n })) };
}

/**
 * The effective DB tables as debugger variables: the results of `:db` in the
 * Debug Console.
 *
 * Variable references from here start at DB_REF_BASE so they never collide with
 * the ones the game's debuggee hands out (small numbers, reset on every stop).
 * They are never reset, so results already in the console stay expandable.
 */
import { Handles } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import { EffectiveRow, EffectiveTable, formatValue, GameDatabase } from '../db/effective';

export const DB_REF_BASE = 0x40000000;
export const DB_COMMAND = ':db';
/** Rows listed for a `:db` query; narrow the filter to see others. */
const MAX_QUERY_ROWS = 500;

type DbRef =
	| { kind: 'tables' }
	| { kind: 'table'; table: string }
	| { kind: 'rows'; table: string; rows: EffectiveRow[] }
	| { kind: 'row'; table: string; row: EffectiveRow }
	| { kind: 'values'; table: string; values: EffectiveRow['values'] }
	| { kind: 'overridden'; table: string; row: EffectiveRow }
	| { kind: 'ref'; table: string; key: string }
	| { kind: 'found'; found: { table: string; row: EffectiveRow }[] };

export function isDbRef(ref: number): boolean {
	return ref >= DB_REF_BASE;
}

export class DbVariables {
	private readonly handles = new Handles<DbRef>(DB_REF_BASE);

	constructor(private readonly db: GameDatabase) {}

	async variables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
		const ref = this.handles.get(args.variablesReference);
		if (!ref) {
			throw new Error('This value is no longer available.');
		}
		const page = <T>(items: T[]) => (args.count ? items.slice(args.start ?? 0, (args.start ?? 0) + args.count) : items);
		switch (ref.kind) {
			case 'tables':
				return (await this.db.tables()).map((table) => ({
					name: table,
					value: '',
					variablesReference: this.handles.create({ kind: 'table', table }),
				}));
			case 'table': {
				const t = await this.db.table(ref.table);
				return page(t.rows).map((row) => this.rowVariable(t, row));
			}
			case 'rows': {
				const t = await this.db.table(ref.table);
				return page(ref.rows).map((row) => this.rowVariable(t, row));
			}
			case 'row':
				return this.rowFields(await this.db.table(ref.table), ref.row);
			case 'values':
				return this.fields(await this.db.table(ref.table), ref.values);
			case 'overridden': {
				const t = await this.db.table(ref.table);
				return ref.row.overridden.map((o) => ({
					name: `${o.source.pack}/${o.source.path}`,
					value: preview(t, o.values),
					variablesReference: this.handles.create({ kind: 'values', table: ref.table, values: o.values }),
				}));
			}
			case 'ref': {
				const t = await this.db.table(ref.table);
				const row = t.byKey.get(ref.key);
				return row ? this.rowFields(t, row) : [{ name: '(missing)', value: `No row "${ref.key}" in ${ref.table}`, variablesReference: 0 }];
			}
			case 'found':
				return ref.found.map(({ table, row }) => ({
					name: table,
					value: `from ${row.source.pack}`,
					variablesReference: this.handles.create({ kind: 'row', table, row }),
				}));
		}
	}

	private rowVariable(t: EffectiveTable, row: EffectiveRow): DebugProtocol.Variable {
		return {
			name: row.key,
			value: preview(t, row.values),
			variablesReference: this.handles.create({ kind: 'row', table: t.name, row }),
		};
	}

	private rowFields(t: EffectiveTable, row: EffectiveRow): DebugProtocol.Variable[] {
		const vars = this.fields(t, row.values);
		vars.push({
			name: '(source)',
			value: `${row.source.pack}/${row.source.path}`,
			variablesReference: 0,
			presentationHint: { kind: 'virtual', attributes: ['readOnly'] },
		});
		if (row.overridden.length) {
			vars.push({
				name: '(overrides)',
				value: row.overridden.map((o) => o.source.pack).join(', '),
				variablesReference: this.handles.create({ kind: 'overridden', table: t.name, row }),
				presentationHint: { kind: 'virtual', attributes: ['readOnly'] },
			});
		}
		return vars;
	}

	private fields(t: EffectiveTable, values: EffectiveRow['values']): DebugProtocol.Variable[] {
		return t.columns.map((c, i) => {
			const value = values[i];
			const refTo = c.refTable && typeof value === 'string' && value !== '' ? c.refTable : undefined;
			return {
				name: c.name,
				value: formatValue(value, c),
				type: c.refTable ? `${c.fieldType} → ${c.refTable}` : c.fieldType,
				variablesReference: refTo ? this.handles.create({ kind: 'ref', table: refTo, key: value as string }) : 0,
				presentationHint: { attributes: ['readOnly'] },
			};
		});
	}

	/**
	 * `:db` in the Debug Console:
	 * - `:db`: all tables;
	 * - `:db <table> [filter]`: rows of a table whose key contains the filter;
	 * - `:db <key>`: the rows with that key in any table.
	 */
	async evaluate(expression: string): Promise<DebugProtocol.EvaluateResponse['body']> {
		const [table, ...rest] = expression.trim().slice(DB_COMMAND.length).trim().split(/\s+/).filter(Boolean);
		if (!table) {
			const tables = await this.db.tables();
			return { result: `${tables.length} tables`, variablesReference: this.handles.create({ kind: 'tables' }), namedVariables: tables.length };
		}
		const tables = await this.db.tables();
		if (!tables.includes(table)) {
			const found = await this.db.findKey(table);
			if (!found.length) {
				throw new Error(`"${table}" is neither a table nor a key in a table with a single key column.`);
			}
			return {
				result: `"${table}" in ${found.map((f) => f.table).join(', ')}`,
				variablesReference: this.handles.create({ kind: 'found', found }),
			};
		}
		const t = await this.db.table(table);
		const filter = rest.join(' ').toLowerCase();
		const matching = filter ? t.rows.filter((r) => r.key.toLowerCase().includes(filter)) : t.rows;
		const rows = matching.slice(0, MAX_QUERY_ROWS);
		const errors = t.errors.length ? `, ${t.errors.length} fragment(s) not decoded` : '';
		const more = matching.length > rows.length ? ` (first ${rows.length})` : '';
		if (rows.length === 1) {
			const row = rows[0];
			return { result: `${table} ${row.key} (from ${row.source.pack})`, variablesReference: this.handles.create({ kind: 'row', table, row }) };
		}
		return {
			result: `${table}: ${matching.length} of ${t.rows.length} rows${more}${errors}`,
			variablesReference: this.handles.create({ kind: 'rows', table, rows }),
			indexedVariables: rows.length,
		};
	}

	/** Completions for `:db <table> <key>` (text up to the cursor). */
	async complete(text: string): Promise<DebugProtocol.CompletionItem[]> {
		const m = /^\s*:db\s+(\S*)(\s+(\S*))?$/.exec(text);
		if (!m) {
			return [];
		}
		const tables = await this.db.tables();
		if (m[2] === undefined) {
			return tables.filter((t) => t.startsWith(m[1])).map((t) => ({ label: t, type: 'module' as const, length: m[1].length }));
		}
		if (!tables.includes(m[1])) {
			return [];
		}
		const prefix = m[3] ?? '';
		return (await this.db.table(m[1])).rows
			.filter((r) => r.key.startsWith(prefix))
			.slice(0, 200)
			.map((r) => ({ label: r.key, type: 'value' as const, length: prefix.length }));
	}
}

/** First few values of a row, for the collapsed view. */
function preview(t: EffectiveTable, values: EffectiveRow['values']): string {
	const parts: string[] = [];
	for (let i = 0; i < t.columns.length && parts.length < 4; i++) {
		if (!t.columns[i].isKey && values[i] !== undefined && values[i] !== '') {
			parts.push(`${t.columns[i].name}=${formatValue(values[i], t.columns[i])}`);
		}
	}
	return `{${parts.join(', ')}${t.columns.length > 4 ? ', …' : ''}}`;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DbDocument, DbEditorProvider, encodeModFile, LOC_FIELDS, readModFile } from './DbEditorProvider';
import { DbService } from './DbService';
import { Cell, DbTableModel } from './dbTableModel';
import { ClonePlan, planClone } from './cloneEntity';
import { modPackFolder } from '../modProject';

/** Tables offered first: the usual starting points of a new entity. */
const COMMON_TABLES = [
	'main_units_tables', 'land_units_tables', 'agent_subtypes_tables', 'building_levels_tables', 'building_chains_tables',
	'effect_bundles_tables', 'effects_tables', 'ancillaries_tables', 'character_skills_tables', 'factions_tables', 'unit_abilities_tables',
];

/**
 * Command: copies a game entity (a row and everything that belongs to it, see
 * cloneEntity.ts) into the mod's own tables under a new key.
 */
export async function cloneEntityCommand(db: DbService, table?: string, key?: string): Promise<void> {
	const pack = modPackFolder();
	if (!pack) {
		void vscode.window.showErrorMessage('Open a mod project (a folder with a "pack" folder) first.');
		return;
	}
	const tables = await db.tables();
	table ??= await vscode.window.showQuickPick(
		[...COMMON_TABLES.filter((t) => tables.includes(t)), ...tables.filter((t) => !COMMON_TABLES.includes(t))],
		{ placeHolder: 'Table of the entity to copy (e.g. main_units_tables for a unit)' });
	if (!table) {
		return;
	}
	const effective = await db.table(table);
	if (effective.columns.filter((c) => c.isKey).length !== 1) {
		void vscode.window.showErrorMessage(`${table} has no single key column: pick the table of the entity itself.`);
		return;
	}
	key ??= (await vscode.window.showQuickPick(effective.rows.map((r) => ({ label: r.key, description: r.source.pack })),
		{ placeHolder: `Row of ${table} to copy`, matchOnDescription: true }))?.label;
	if (!key) {
		return;
	}
	const modName = path.basename(path.dirname(pack));
	const newKey = await vscode.window.showInputBox({
		title: `Copy ${key}`,
		prompt: 'Key of the copy. Rows whose key contains the old key get it replaced by this one.',
		value: key.replace(/^[a-z0-9]+_[a-z0-9]+_/, `${modName}_`),
		validateInput: (v) => (!v.trim() ? 'Enter a key' : v.trim() === key ? 'Must differ from the original' : effective.byKey.has(v.trim()) ? `${table} already has ${v.trim()}` : undefined),
	});
	if (!newKey) {
		return;
	}

	const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Finding the rows of ${key}…` },
		async () => {
			const [{ schema }, loc, gameTables] = await Promise.all([db.schema(), db.loc().catch(() => new Map()), db.tables()]);
			const known = new Set(gameTables);
			let reverse: Map<string, { table: string; column: string }[]> | undefined;
			return planClone(table!, key!, newKey.trim(), {
				table: async (name) => (known.has(name) ? db.table(name).catch(() => undefined) : undefined),
				referencing: async (name) => {
					if (!reverse) {
						reverse = new Map();
						for (const t of schema.tableNames()) {
							for (const f of schema.emptyTable(t)?.fields ?? []) {
								if (f.refTable) {
									const list = reverse.get(f.refTable) ?? [];
									list.push({ table: t, column: f.name });
									reverse.set(f.refTable, list);
								}
							}
						}
					}
					return reverse.get(name) ?? [];
				},
				loc: (k) => loc.get(k),
			});
		});

	const picked = await pickParts(plan, key, newKey.trim());
	if (!picked) {
		return;
	}
	const written = await writePlan(db, pack, modName, picked);
	const first = written[0];
	if (first) {
		await vscode.commands.executeCommand('vscode.openWith', first, DbEditorProvider.viewType);
	}
	void vscode.window.showInformationMessage(`Copied ${key} as ${newKey.trim()}: ${picked.rows.length} rows, ${picked.loc.length} texts in ${written.length} files.`
		+ (plan.skipped.length ? ` Not copied (shared rows that reference it): ${plan.skipped.map((s) => `${s.table} (${s.count})`).join(', ')}.` : ''));
}

/** Preview: one checked item per table (and one for the texts); unchecked ones are left out. */
async function pickParts(plan: ClonePlan, key: string, newKey: string): Promise<ClonePlan | undefined> {
	type Item = vscode.QuickPickItem & { table?: string; loc?: boolean };
	const byTable = new Map<string, ClonePlan['rows']>();
	for (const row of plan.rows) {
		byTable.set(row.table, [...byTable.get(row.table) ?? [], row]);
	}
	const sample = (rows: ClonePlan['rows']) => rows.slice(0, 3).map((r) => r.newKey).join(', ') + (rows.length > 3 ? ', …' : '');
	const items: Item[] = [...byTable].map(([table, rows]) => ({
		label: table,
		description: `${rows.length} row${rows.length > 1 ? 's' : ''}`,
		detail: `${sample(rows)} — ${rows[0].reason}`,
		picked: true,
		table,
	}));
	if (plan.loc.length) {
		items.push({ label: 'loc', description: `${plan.loc.length} text${plan.loc.length > 1 ? 's' : ''}`, detail: plan.loc.map((l) => l.newKey).join(', '), picked: true, loc: true });
	}
	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: `Copy ${key} as ${newKey}`,
		placeHolder: 'Uncheck the tables not to copy into; Enter writes the rest into the mod\'s tables',
		matchOnDetail: true,
	});
	if (!picked?.length) {
		return undefined;
	}
	const tables = new Set(picked.map((p) => p.table).filter(Boolean));
	return {
		rows: plan.rows.filter((r) => tables.has(r.table)),
		loc: picked.some((p) => p.loc) ? plan.loc : [],
		skipped: plan.skipped,
	};
}

/** An existing file of the mod among `candidates`, else the first in the format of new files. */
function modFile(candidates: string[]): vscode.Uri {
	const existing = candidates.find((c) => fs.existsSync(c));
	if (existing) {
		return vscode.Uri.file(existing);
	}
	const tsv = vscode.workspace.getConfiguration('totalwar').get<string>('newTableFormat', 'binary') === 'tsv';
	return vscode.Uri.file(candidates.find((c) => c.endsWith('.tsv') === tsv) ?? candidates[0]);
}

/** Appends the planned rows to the mod's `!!!<mod>` fragments; returns the files written, the entity's first. */
export async function writePlan(db: DbService, pack: string, modName: string, plan: ClonePlan): Promise<vscode.Uri[]> {
	const byTable = new Map<string, ClonePlan['rows']>();
	for (const row of plan.rows) {
		byTable.set(row.table, [...byTable.get(row.table) ?? [], row]);
	}
	const written: vscode.Uri[] = [];
	const { schema } = await db.schema();
	for (const [table, rows] of byTable) {
		const base = path.join(pack, 'db', table, `!!!${modName}`);
		const uri = modFile([base, `${base}.tsv`]);
		const doc = new DbDocument(uri);
		let model: DbTableModel;
		if (fs.existsSync(uri.fsPath)) {
			model = await readModFile(db, doc);
		} else {
			const version = await db.gameVersion(table).catch(() => undefined);
			const empty = schema.emptyTable(table, version) ?? schema.emptyTable(table);
			if (!empty) {
				throw new Error(`The schema has no ${table}.`);
			}
			model = new DbTableModel(table, empty.version, '', empty.fields, []);
		}
		const columns = (await db.table(table)).columns.map((c) => c.name);
		const defaults = model.newRow();
		const keyIndex = model.fields.findIndex((f) => f.isKey);
		const existingKeys = new Set(model.rows.map((r) => String(r[keyIndex])));
		for (const row of rows) {
			const values: Cell[] = model.fields.map((f, i) => {
				const from = columns.indexOf(f.name);
				return from >= 0 && row.values[from] !== undefined ? row.values[from] : defaults[i];
			});
			if (!existingKeys.has(String(values[keyIndex]))) {
				model.rows.push(values);
			}
		}
		fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
		await vscode.workspace.fs.writeFile(uri, await encodeModFile(db, doc, model));
		written.push(uri);
	}
	if (plan.loc.length) {
		const base = path.join(pack, 'text', 'db', `!!!${modName}.loc`);
		const uri = modFile([base, `${base}.tsv`]);
		const doc = new DbDocument(uri);
		const model = fs.existsSync(uri.fsPath) ? await readModFile(db, doc) : new DbTableModel('loc', 1, '', LOC_FIELDS, []);
		const keys = new Set(model.rows.map((r) => String(r[0])));
		for (const l of plan.loc.filter((x) => !keys.has(x.newKey))) {
			model.rows.push([l.newKey, l.text, l.tooltip]);
		}
		fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
		await vscode.workspace.fs.writeFile(uri, await encodeModFile(db, doc, model));
		written.push(uri);
	}
	return written;
}

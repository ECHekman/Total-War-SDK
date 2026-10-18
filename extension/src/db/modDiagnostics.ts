import * as vscode from 'vscode';

import { BASEGAME_FOLDER, LiveSourceFS } from '../SourceFileSystemProvider';
import { DbDocument, readModFile } from './DbEditorProvider';
import { DbService } from './DbService';
import { DbTableModel } from './dbTableModel';
import { EffectiveTable } from './effective';
import { CheckContext, checkLocRows, checkModTable, guessLocalisedColumns, Problem, rowKey } from './modChecks';

const DB_GLOB = '**/db/*_tables/*';
const LOC_GLOB = '**/*.{loc,loc.tsv}';
const EXCLUDE = '{**/out/**,**/node_modules/**,**/.git/**}';
const SAMPLE_KEYS = 40;

interface ModFile {
	uri: vscode.Uri;
	doc: DbDocument;
	model?: DbTableModel;
	error?: string;
}

/**
 * Checks the DB tables and loc files in the workspace against the game and
 * the mod list (see modChecks.ts) and lists the problems in the Problems view.
 */
export class ModDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('Total War mod');
	private readonly disposables: vscode.Disposable[] = [this.collection];
	private timer: NodeJS.Timeout | undefined;
	private running: Promise<number> | undefined;
	private readonly localised = new Map<string, string[]>();

	constructor(private readonly db: DbService, private readonly log: vscode.OutputChannel, private readonly enabledHere: () => boolean) {
		const watcher = vscode.workspace.createFileSystemWatcher(`{${DB_GLOB},${LOC_GLOB}}`);
		const changed = () => this.schedule();
		this.disposables.push(
			watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
			db.onDidChange(() => {
				this.localised.clear();
				this.schedule();
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('twdev.modDiagnostics')) {
					this.schedule(0);
				}
			}),
		);
	}

	private get enabled(): boolean {
		return vscode.workspace.getConfiguration('twdev').get<boolean>('modDiagnostics', true) && this.enabledHere();
	}

	/** Checks again a moment after the last change. */
	schedule(delay = 1500): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (!this.enabled) {
				this.collection.clear();
				return;
			}
			this.run().catch((e: Error) => this.log.appendLine(`Mod check: ${e.message}`));
		}, delay);
	}

	/** Checks all mod files now; resolves with the number of problems. */
	run(): Promise<number> {
		this.running ??= this.check().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	private async check(): Promise<number> {
		const started = Date.now();
		const uris = [
			...await vscode.workspace.findFiles(DB_GLOB, EXCLUDE),
			...await vscode.workspace.findFiles(LOC_GLOB, EXCLUDE),
		].filter((u) => u.scheme === 'file');
		const files: ModFile[] = [];
		for (const uri of uris) {
			const doc = new DbDocument(uri);
			try {
				files.push({ uri, doc, model: await readModFile(this.db, doc) });
			} catch (e) {
				files.push({ uri, doc, error: (e as Error).message });
			}
		}

		// The mod's own keys and loc keys count as existing (they may not be packed yet).
		const modKeys = new Map<string, Set<string>>();
		const modLoc = new Set<string>();
		for (const f of files) {
			if (!f.model) {
				continue;
			}
			if (f.doc.kind === 'loc') {
				f.model.rows.forEach((r) => modLoc.add(String(r[0])));
			} else if (f.model.fields.filter((x) => x.isKey).length === 1) {
				const set = modKeys.get(f.doc.table) ?? new Set<string>();
				f.model.rows.forEach((r) => {
					const k = rowKey(f.model!.fields, r);
					if (k !== undefined) {
						set.add(k);
					}
				});
				modKeys.set(f.doc.table, set);
			}
		}

		let gameTables: Set<string>;
		let loc: Map<string, unknown>;
		try {
			gameTables = new Set(await this.db.tables());
			loc = await this.db.loc();
		} catch (e) {
			// No game: only the checks that need none.
			this.log.appendLine(`Mod check: without the game's tables (${(e as Error).message}).`);
			gameTables = new Set();
			loc = new Map();
		}
		const effective = new Map<string, EffectiveTable | undefined>();
		const tableOf = async (name: string) => {
			if (!effective.has(name)) {
				effective.set(name, gameTables.has(name) ? await this.db.table(name).catch(() => undefined) : undefined);
			}
			return effective.get(name);
		};
		const hasLoc = (key: string) => loc.has(key) || modLoc.has(key);

		const diagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];
		let total = 0;
		for (const f of files) {
			let problems: Problem[];
			if (f.error) {
				problems = [{ severity: 'error', code: 'unknown-table', message: f.error }];
			} else if (f.doc.kind === 'loc') {
				problems = checkLocRows(f.model!.rows);
			} else {
				const model = f.model!;
				const without = gameTables.has(f.doc.table)
					? await this.db.tableExcluding(f.doc.table, f.doc.fileName).catch(() => undefined) : undefined;
				const refs = new Map<string, Set<string> | undefined>();
				for (const field of model.fields) {
					if (field.refTable && !refs.has(field.refTable)) {
						const t = await tableOf(field.refTable);
						const singleKey = t && t.columns.filter((c) => c.isKey).length === 1;
						refs.set(field.refTable, singleKey ? new Set([...t.byKey.keys(), ...modKeys.get(field.refTable) ?? []]) : undefined);
					}
				}
				const own = await tableOf(f.doc.table);
				const gameVersion = own ? await this.db.gameVersion(f.doc.table).catch(() => undefined) : undefined;
				const ctx: CheckContext = {
					keys: (table) => (table === f.doc.table ? (own ? new Set(own.byKey.keys()) : undefined) : refs.get(table)),
					gameVersion: () => gameVersion,
					inGame: (_table, key) => !!without?.byKey.has(key),
					localisedColumns: (table) => this.localisedColumns(table, own, hasLoc),
					hasLoc,
				};
				problems = checkModTable({ table: f.doc.table, fileName: f.doc.fileName, version: model.version, fields: model.fields, rows: model.rows }, ctx);
			}
			total += problems.length;
			diagnostics.push([f.uri, problems.map(toDiagnostic)]);
		}
		this.collection.clear();
		this.collection.set(diagnostics);
		this.log.appendLine(`Mod check: ${files.length} files, ${total} problems, in ${Date.now() - started} ms.`);
		return total;
	}

	private localisedColumns(table: string, own: EffectiveTable | undefined, hasLoc: (key: string) => boolean): string[] {
		let columns = this.localised.get(table);
		if (!columns) {
			const sample = (own?.rows ?? []).filter((r) => !r.key.includes(' | ')).slice(0, SAMPLE_KEYS).map((r) => r.key);
			columns = guessLocalisedColumns(table, own?.columns ?? [], sample, hasLoc);
			this.localised.set(table, columns);
		}
		return columns;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.disposables.forEach((d) => d.dispose());
	}
}

function toDiagnostic(p: Problem): vscode.Diagnostic {
	const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), p.message,
		p.severity === 'error' ? vscode.DiagnosticSeverity.Error : p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
	d.source = 'Total War';
	d.code = p.code;
	return d;
}

/**
 * A Markdown report of what the mods in the mod list override of each other:
 * files several mods contain, and DB rows several mods define. The first mod
 * in the mod list wins.
 */
export async function modConflictReport(sources: LiveSourceFS, db: DbService, progress: (message: string) => void): Promise<string> {
	const packs = (await sources.packSources()).filter((p) => p.label !== BASEGAME_FOLDER);
	const lines: string[] = ['# Mod conflicts', ''];
	if (packs.length < 2) {
		lines.push(packs.length ? `Only one mod in the mod list (${packs[0].label}): nothing to conflict with.` : 'No mods in the mod list.');
		return lines.join('\n');
	}
	lines.push(`Mod list, highest priority first: ${packs.map((p) => `\`${p.label}\``).join(', ')}.`,
		'When two mods have the same file or DB key, the game uses the first mod\'s.', '');

	progress('files');
	const byPath = new Map<string, { path: string; mods: string[] }>();
	for (const { label, holder } of packs) {
		for (const p of holder.paths()) {
			const key = p.toLowerCase();
			const entry = byPath.get(key) ?? { path: p, mods: [] };
			entry.mods.push(label);
			byPath.set(key, entry);
		}
	}
	const fileConflicts = [...byPath.values()].filter((e) => e.mods.length > 1 && !/^db\//i.test(e.path));
	lines.push(`## Files (${fileConflicts.length})`, '');
	if (fileConflicts.length) {
		lines.push('| file | used from | also in |', '|---|---|---|');
		for (const c of fileConflicts.sort((a, b) => a.path.localeCompare(b.path))) {
			lines.push(`| \`${c.path}\` | ${c.mods[0]} | ${c.mods.slice(1).join(', ')} |`);
		}
	} else {
		lines.push('None.');
	}
	lines.push('');

	const modPacks = new Set(packs.map((p) => p.label.toLowerCase()));
	const rows: string[] = [];
	const tables = await db.tables();
	let done = 0;
	for (const name of tables) {
		if (++done % 50 === 0) {
			progress(`DB tables ${done}/${tables.length}`);
		}
		let t: EffectiveTable;
		try {
			t = await db.table(name);
		} catch {
			continue;
		}
		for (const row of t.rows) {
			const others = row.overridden.filter((o) => modPacks.has(o.source.pack.toLowerCase()) && o.source.pack !== row.source.pack);
			if (others.length && modPacks.has(row.source.pack.toLowerCase())) {
				rows.push(`| ${name} | \`${row.key}\` | ${row.source.pack} | ${[...new Set(others.map((o) => o.source.pack))].join(', ')} |`);
			}
		}
	}
	lines.push(`## DB rows (${rows.length})`, '');
	if (rows.length) {
		lines.push('| table | key | used from | also in |', '|---|---|---|---|', ...rows);
	} else {
		lines.push('None.');
	}
	return lines.join('\n') + '\n';
}

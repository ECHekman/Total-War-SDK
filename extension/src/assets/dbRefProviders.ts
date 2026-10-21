import * as vscode from 'vscode';

import { DbDocument, readModFile } from '../db/DbEditorProvider';
import { DbService } from '../db/DbService';
import { DECODED_SCHEME, DecodedFileSystemProvider, packPathOf } from '../decoded/DecodedFileSystemProvider';
import { formatValue } from '../db/effective';
import { configuredGame } from '../projectCommands';
import { rpfm } from '../rpfm';
import { LineIndex } from './assetProviders';
import { DbRef, DbRefRule, dbRefRulesFor, dbRefValueAt, findDbRefs } from './dbRefs';

const DOCUMENTS: vscode.DocumentSelector = [{ scheme: DECODED_SCHEME, pattern: '**/*portrait_settings*.bin.json' }];
const MOD_PORTRAITS_GLOB = '**/pack/**/*portrait_settings*.bin';
const EXCLUDE = '{**/out/**,**/node_modules/**,**/.git/**}';
const MAX_ITEMS = 200;

/** Where a value of a table column is defined: the effective table (game and mod list) or the mod's own files. */
interface Found {
	table: string;
	/** Row key, to open the table at; undefined when only the mod's unpacked files have it. */
	key?: string;
	pack: string;
	fields?: string;
}

/** Values of table columns: the game and the mod list, plus the mod's own tables (not packed yet). */
class ColumnValues implements vscode.Disposable {
	private readonly cache = new Map<string, Promise<Map<string, Found>>>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly db: DbService) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/db/*_tables/*');
		const clear = () => this.cache.clear();
		this.disposables.push(watcher, db.onDidChange(clear), watcher.onDidChange(clear), watcher.onDidCreate(clear), watcher.onDidDelete(clear));
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}

	/** The values of a column; empty when the game or the schema is not available. */
	values(rule: DbRefRule): Promise<Map<string, Found>> {
		const id = `${rule.table}.${rule.column}`;
		let values = this.cache.get(id);
		if (!values) {
			values = this.load(rule).catch(() => new Map());
			this.cache.set(id, values);
		}
		return values;
	}

	private async load(rule: DbRefRule): Promise<Map<string, Found>> {
		const out = new Map<string, Found>();
		const table = await this.db.table(rule.table);
		const col = table.columns.findIndex((c) => c.name === rule.column);
		if (col >= 0) {
			for (const row of table.rows) {
				const v = row.values[col];
				if (v !== undefined && v !== '' && !out.has(String(v))) {
					const fields = table.columns.map((c, i) => [c, row.values[i]] as const)
						.filter(([c, val]) => c.name !== rule.column && val !== undefined && val !== '')
						.slice(0, 6).map(([c, val]) => `${c.name}: ${formatValue(val, c)}`).join(' · ');
					out.set(String(v), { table: rule.table, key: row.key, pack: row.source.pack, fields });
				}
			}
		}
		for (const uri of await vscode.workspace.findFiles(`**/db/${rule.table}/*`, EXCLUDE)) {
			try {
				const model = await readModFile(this.db, new DbDocument(uri));
				const i = model.fields.findIndex((f) => f.name === rule.column);
				for (const row of i >= 0 ? model.rows : []) {
					const v = row[i];
					if (v !== undefined && v !== '' && !out.has(String(v))) {
						out.set(String(v), { table: rule.table, pack: 'this mod (not packed yet)' });
					}
				}
			} catch {
				// a broken table of the mod: the mod check reports it
			}
		}
		return out;
	}

	/** Whether the values can be trusted to be complete (the game's table was read). */
	async available(rule: DbRefRule): Promise<boolean> {
		return this.db.table(rule.table).then(() => true, () => false);
	}
}

function refAt(doc: vscode.TextDocument, pos: vscode.Position): DbRef | undefined {
	const offset = doc.offsetAt(pos);
	return findDbRefs(doc.getText(), dbRefRulesFor(doc.uri.path)).find((r) => r.start <= offset && offset <= r.end);
}

class DbRefHoverProvider implements vscode.HoverProvider {
	constructor(private readonly values: ColumnValues) {}

	async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
		const ref = refAt(doc, pos);
		if (!ref) {
			return undefined;
		}
		const range = new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end));
		const found = (await this.values.values(ref.rule)).get(ref.value);
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ['totalwar.openDbTable'] };
		if (found) {
			md.appendMarkdown(`**${ref.rule.table}** \`${ref.rule.column}\` — from \`${found.pack}\``);
			if (found.key) {
				md.appendMarkdown(` · [open](command:totalwar.openDbTable?${encodeURIComponent(JSON.stringify([ref.rule.table, found.key]))})`);
			}
			if (found.fields) {
				md.appendMarkdown(`\n\n${found.fields.replace(/[<>|]/g, (c) => `\\${c}`)}`);
			}
		} else if (await this.values.available(ref.rule)) {
			md.appendMarkdown(`No row of **${ref.rule.table}** has \`${ref.rule.column}\` \`${ref.value}\`.`);
		} else {
			return undefined;
		}
		return new vscode.Hover(md, range);
	}
}

class DbRefCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly values: ColumnValues) {}

	async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionList | undefined> {
		const at = dbRefValueAt(doc.lineAt(pos.line).text, pos.character, dbRefRulesFor(doc.uri.path));
		if (!at) {
			return undefined;
		}
		const range = new vscode.Range(pos.line, at.start, pos.line, pos.character);
		const prefix = at.prefix.toLowerCase();
		const matches = [...(await this.values.values(at.rule))].filter(([v]) => v.toLowerCase().startsWith(prefix));
		const items = matches.slice(0, MAX_ITEMS).map(([v, f]) => {
			const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
			item.range = range;
			item.detail = `${at.rule.table} (${f.pack})`;
			return item;
		});
		return new vscode.CompletionList(items, matches.length > MAX_ITEMS);
	}
}

/** Warns about values that no row of their table has, in the mod's portrait settings. */
class DbRefDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('Total War DB references');
	private readonly disposables: vscode.Disposable[] = [this.collection];
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly values: ColumnValues, db: DbService) {
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
			vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
			db.onDidChange(() => vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0))),
		);
		vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0));
	}

	private schedule(doc: vscode.TextDocument, delay = 800): void {
		if (doc.uri.scheme !== DECODED_SCHEME || DecodedFileSystemProvider.sourceOf(doc.uri).scheme !== 'file' || !vscode.languages.match(DOCUMENTS, doc)) {
			return;
		}
		const key = doc.uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			void this.check(doc.uri.path, doc.getText(), (o) => doc.positionAt(o)).then((d) => this.collection.set(doc.uri, d));
		}, delay));
	}

	private async check(path: string, text: string, position: (offset: number) => vscode.Position): Promise<vscode.Diagnostic[]> {
		const problems: vscode.Diagnostic[] = [];
		for (const ref of findDbRefs(text, dbRefRulesFor(path))) {
			if ((await this.values.values(ref.rule)).has(ref.value) || !await this.values.available(ref.rule)) {
				continue;
			}
			const d = new vscode.Diagnostic(new vscode.Range(position(ref.start), position(ref.end)),
				`No row of ${ref.rule.table} has ${ref.rule.column} "${ref.value}".`, vscode.DiagnosticSeverity.Warning);
			d.source = 'Total War';
			problems.push(d);
		}
		return problems;
	}

	/** Checks the mod's portrait settings files (the "Check Mod" command); resolves with the number of problems. */
	async checkWorkspace(): Promise<number> {
		let count = 0;
		for (const uri of await vscode.workspace.findFiles(MOD_PORTRAITS_GLOB, EXCLUDE)) {
			const decoded = DecodedFileSystemProvider.uriFor(uri);
			let json: string;
			try {
				json = rpfm().decodeToJson(Buffer.from(await vscode.workspace.fs.readFile(uri)), packPathOf(uri), configuredGame().key)?.json ?? '';
			} catch {
				continue; // not decodable: opening it says why
			}
			const lines = new LineIndex(json);
			const problems = await this.check(decoded.path, json, (o) => lines.position(o));
			this.collection.set(decoded, problems);
			count += problems.length;
		}
		return count;
	}

	dispose(): void {
		this.timers.forEach((t) => clearTimeout(t));
		this.disposables.forEach((d) => d.dispose());
	}
}

/** Registers the DB key features of the JSON views. */
export function registerDbRefProviders(db: DbService): { diagnostics: DbRefDiagnostics; disposables: vscode.Disposable[] } {
	const values = new ColumnValues(db);
	const diagnostics = new DbRefDiagnostics(values, db);
	return {
		diagnostics,
		disposables: [
			values,
			diagnostics,
			vscode.languages.registerHoverProvider(DOCUMENTS, new DbRefHoverProvider(values)),
			vscode.languages.registerCompletionItemProvider(DOCUMENTS, new DbRefCompletionProvider(values), '"'),
		],
	};
}

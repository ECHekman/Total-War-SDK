import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DbSchema, rpfm } from '../rpfm';
import { DbGridPanel } from './DbGridPanel';
import { DbService } from './DbService';
import { DbEdit, DbTableModel, parseValue } from './dbTableModel';
import { DbField, EffectiveTable, FragmentSource, fragmentEffect, mapRows, RowEffect, sortsAfterGame } from './effective';

/** The columns of a loc file, shown like a DB table. */
export const LOC_FIELDS: DbField[] = [
	{ name: 'key', fieldType: 'StringU16', isKey: true },
	{ name: 'text', fieldType: 'StringU16', isKey: false },
	{ name: 'tooltip', fieldType: 'Boolean', isKey: false, defaultValue: 'false' },
];
import { gridHtml, gridWebviewOptions } from './gridHtml';

/**
 * A DB table fragment file (`db/<table>/<file>`) or a loc file (`*.loc`) open
 * in the editor; either binary or RPFM's TSV text format (`*.tsv`).
 */
export class DbDocument implements vscode.CustomDocument {
	model: DbTableModel | undefined;
	/** Why the file cannot be edited (decode failure). */
	error: string | undefined;
	schemaProblem = false;
	/** The table without this file, for the "effect in game" column. */
	others: Promise<EffectiveTable | undefined> | undefined;

	constructor(readonly uri: vscode.Uri) {}

	/** A file the editor cannot write: a table inside a pack (the `totalwar:` virtual files). */
	get readOnly(): boolean {
		return vscode.workspace.fs.isWritableFileSystem(this.uri.scheme) === false;
	}

	/** `tsv` for RPFM's text format (packed as the binary file it describes). */
	get format(): 'binary' | 'tsv' {
		return /\.tsv$/i.test(this.uri.path) ? 'tsv' : 'binary';
	}

	get kind(): 'db' | 'loc' {
		return /\.loc(\.tsv)?$/i.test(this.uri.path) ? 'loc' : 'db';
	}

	/** Table name: the folder the file is in (`loc` for loc files). */
	get table(): string {
		return this.kind === 'loc' ? 'loc' : path.posix.basename(path.posix.dirname(this.uri.path));
	}

	/** File name as it is in the pack (without `.tsv`). */
	get fileName(): string {
		return path.posix.basename(this.uri.path).replace(/\.tsv$/i, '');
	}

	/** The file as a fragment in a pack (only its path matters for the load order). */
	get source(): FragmentSource {
		return { pack: '(this file)', path: this.packPath };
	}

	/** Path of the file in the pack. */
	get packPath(): string {
		return this.kind === 'loc' ? `text/db/${this.fileName}` : `db/${this.table}/${this.fileName}`;
	}

	dispose(): void {
		// nothing held
	}
}

interface WebviewMessage {
	type: string;
	edit?: { type: 'set'; row: number; col: number; value: unknown };
	indices?: number[];
	after?: number;
	table?: string;
	key?: string;
	lookup?: string[];
}

/**
 * Editor for DB table fragments in mod folders, in the same grid as the Game
 * Database viewer. Saves the binary table the pack task packs.
 */
export class DbEditorProvider implements vscode.CustomEditorProvider<DbDocument> {
	static readonly viewType = 'totalwar.dbEditor';

	private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DbDocument>>();
	readonly onDidChangeCustomDocument = this.changes.event;
	private readonly panels = new Map<DbDocument, vscode.WebviewPanel>();
	private readonly effectTimers = new Map<DbDocument, NodeJS.Timeout>();

	constructor(private readonly db: DbService, private readonly extensionUri: vscode.Uri, private readonly log: vscode.OutputChannel) {
		db.onDidChange(() => {
			for (const doc of this.panels.keys()) {
				doc.others = undefined;
				if (doc.error) {
					// e.g. after "Update DB Schema"
					void this.reload(doc);
				} else {
					this.scheduleEffects(doc);
				}
			}
		});
	}

	/** Open documents (for tests). */
	get documents(): DbDocument[] {
		return [...this.panels.keys()];
	}

	async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext): Promise<DbDocument> {
		const doc = new DbDocument(uri);
		await this.read(doc, context.backupId ? vscode.Uri.parse(context.backupId) : uri);
		return doc;
	}

	private async read(doc: DbDocument, from: vscode.Uri): Promise<void> {
		doc.model = undefined;
		doc.error = undefined;
		doc.schemaProblem = false;
		try {
			doc.model = await readModFile(this.db, doc, from);
		} catch (e) {
			doc.error = (e as Error).message;
			doc.schemaProblem = /definition|schema/i.test(doc.error);
			this.log.appendLine(`DB editor: ${doc.uri.fsPath}: ${doc.error}`);
		}
	}

	private async reload(doc: DbDocument): Promise<void> {
		await this.read(doc, doc.uri);
		this.sendInit(doc);
	}

	async resolveCustomEditor(doc: DbDocument, panel: vscode.WebviewPanel): Promise<void> {
		this.panels.set(doc, panel);
		panel.webview.options = gridWebviewOptions(this.extensionUri);
		panel.webview.html = gridHtml(panel.webview, this.extensionUri);
		panel.onDidDispose(() => {
			this.panels.delete(doc);
			clearTimeout(this.effectTimers.get(doc));
		});
		panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(doc, msg).catch((e: Error) => {
			void vscode.window.showErrorMessage(e.message);
		}));
	}

	private async onMessage(doc: DbDocument, msg: WebviewMessage): Promise<void> {
		const model = doc.model;
		switch (msg.type) {
			case 'ready':
				this.sendInit(doc);
				return;
			case 'open':
				if (msg.table) {
					await DbGridPanel.show(this.db, this.extensionUri, msg.table, msg.key);
				}
				return;
			case 'refKeys':
				if (msg.table) {
					void this.panels.get(doc)?.webview.postMessage({ type: 'refKeys', ...await referenceOptions(this.db, msg.table, msg.lookup) });
				}
				return;
			case 'updateSchema':
				await vscode.commands.executeCommand('totalwar.updateDbSchema');
				return;
		}
		if (!model || doc.readOnly) {
			return;
		}
		switch (msg.type) {
			case 'edit': {
				const e = msg.edit!;
				const field = model.fields[e.col];
				const value = typeof e.value === 'boolean' && field.fieldType === 'Boolean' ? e.value : parseValue(field, String(e.value));
				if (value === undefined || !model.rows[e.row]) {
					return;
				}
				this.makeEdit(doc, { type: 'set', row: e.row, col: e.col, value, old: model.rows[e.row][e.col] }, `Edit ${field.name}`);
				return;
			}
			case 'add': {
				const index = msg.after !== undefined && msg.after >= 0 ? msg.after + 1 : model.rows.length;
				this.makeEdit(doc, { type: 'insert', index, rows: [model.newRow()] }, 'Add row', [index]);
				return;
			}
			case 'duplicate': {
				const indices = [...(msg.indices ?? [])].sort((a, b) => a - b).filter((i) => model.rows[i]);
				if (indices.length) {
					const index = indices[indices.length - 1] + 1;
					this.makeEdit(doc, { type: 'insert', index, rows: indices.map((i) => [...model.rows[i]]) }, 'Duplicate rows',
						indices.map((_, n) => index + n));
				}
				return;
			}
			case 'delete': {
				const edit = model.deleteEdit(msg.indices ?? []);
				if (edit.type === 'delete' && edit.indices.length) {
					this.makeEdit(doc, edit, 'Delete rows', []);
				}
				return;
			}
			case 'import':
				await this.importFromGame(doc);
				return;
		}
	}

	/** Applies an edit and registers it with VS Code (undo/redo, dirty state). */
	makeEdit(doc: DbDocument, edit: DbEdit, label: string, select?: number[]): void {
		const model = doc.model!;
		model.apply(edit);
		this.sendRows(doc, select);
		this.changes.fire({
			document: doc,
			label,
			undo: () => {
				model.revert(edit);
				this.sendRows(doc);
			},
			redo: () => {
				model.apply(edit);
				this.sendRows(doc, select);
			},
		});
	}

	private async importFromGame(doc: DbDocument): Promise<void> {
		const model = doc.model!;
		if (doc.kind === 'loc') {
			await this.importLocFromGame(doc);
			return;
		}
		let table: EffectiveTable;
		try {
			table = await this.db.table(doc.table);
		} catch (e) {
			void vscode.window.showErrorMessage(`The game's ${doc.table} is not available: ${(e as Error).message}`);
			return;
		}
		const picks = await vscode.window.showQuickPick(
			table.rows.map((row) => ({ label: row.key, description: row.source.pack, row })),
			{ canPickMany: true, matchOnDescription: true, placeHolder: `Rows of ${doc.table} to copy into ${doc.fileName}` });
		if (!picks?.length) {
			return;
		}
		const rows = mapRows(table, picks.map((p) => p.row), model.fields);
		const defaults = model.newRow();
		const filled = rows.map((r) => r.map((v, i) => v ?? defaults[i]));
		const index = model.rows.length;
		this.makeEdit(doc, { type: 'insert', index, rows: filled }, 'Import rows', filled.map((_, n) => index + n));
	}

	private async importLocFromGame(doc: DbDocument): Promise<void> {
		const model = doc.model!;
		const loc = await this.db.loc();
		const picks = await vscode.window.showQuickPick(
			[...loc.entries()].map(([key, e]) => ({ label: key, description: e.text, detail: e.pack, key, e })),
			{ canPickMany: true, matchOnDescription: true, placeHolder: `Loc entries to copy into ${doc.fileName}` });
		if (!picks?.length) {
			return;
		}
		const rows = picks.map((p) => [p.key, p.e.text, p.e.tooltip]);
		const index = model.rows.length;
		this.makeEdit(doc, { type: 'insert', index, rows }, 'Import rows', rows.map((_, n) => index + n));
	}

	private sendInit(doc: DbDocument): void {
		const panel = this.panels.get(doc);
		if (!panel) {
			return;
		}
		const model = doc.model;
		void panel.webview.postMessage({
			type: 'init',
			mode: 'edit',
			table: doc.table,
			version: model?.version,
			readOnly: !model || doc.readOnly,
			columns: model?.fields ?? [],
			rows: model ? serializeRows(model) : [],
			errors: doc.error ? [doc.error] : [],
			schemaProblem: doc.schemaProblem,
			banner: !model ? undefined
				: doc.readOnly ? 'Read-only: this table is inside a pack. To change rows, create a table in your mod (TotalWar: New DB Table…) and use "Import from game…".'
				: doc.kind === 'db' && sortsAfterGame(doc.source.path)
					? `"${doc.fileName}" sorts after the game's "data__": every key it shares with the game keeps the game's row. Prefix the name with "!" to override.`
					: undefined,
		});
		this.scheduleEffects(doc, 0);
	}

	private sendRows(doc: DbDocument, select?: number[]): void {
		void this.panels.get(doc)?.webview.postMessage({ type: 'rows', rows: serializeRows(doc.model!), select });
		this.scheduleEffects(doc);
	}

	/** Recomputes the "effect in game" column a moment after the last change. */
	private scheduleEffects(doc: DbDocument, delay = 250): void {
		clearTimeout(this.effectTimers.get(doc));
		this.effectTimers.set(doc, setTimeout(() => void this.sendEffects(doc), delay));
	}

	private async sendEffects(doc: DbDocument): Promise<void> {
		const model = doc.model;
		if (!model || doc.kind === 'loc') {
			return;
		}
		doc.others ??= this.db.tableExcluding(doc.table, doc.fileName).catch(() => undefined);
		const others = await doc.others;
		const effects: RowEffect[] | undefined = others ? fragmentEffect(doc.source, model.fields, model.rows, others) : undefined;
		void this.panels.get(doc)?.webview.postMessage({ type: 'effects', effects });
	}

	private async encode(doc: DbDocument): Promise<Uint8Array> {
		const model = doc.model;
		if (!model) {
			throw new Error(`${doc.fileName} could not be read, so it cannot be saved.`);
		}
		return encodeModFile(this.db, doc, model);
	}

	async saveCustomDocument(doc: DbDocument): Promise<void> {
		await vscode.workspace.fs.writeFile(doc.uri, await this.encode(doc));
	}

	async saveCustomDocumentAs(doc: DbDocument, destination: vscode.Uri): Promise<void> {
		await vscode.workspace.fs.writeFile(destination, await this.encode(doc));
	}

	async revertCustomDocument(doc: DbDocument): Promise<void> {
		await this.reload(doc);
	}

	async backupCustomDocument(doc: DbDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
		await vscode.workspace.fs.writeFile(context.destination, await this.encode(doc));
		return {
			id: context.destination.toString(),
			delete: () => void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined),
		};
	}
}

/**
 * The keys a reference column can take: the referenced table's keys as the
 * game has them, each with the values of the schema's lookup columns (a name
 * or description) when that table has them.
 */
export async function referenceOptions(db: DbService, table: string, lookup?: string[]):
	Promise<{ table: string; lookup?: string[]; options?: { key: string; label: string }[]; error?: string }> {
	try {
		const t = await db.table(table);
		if (!t.fragments.length) {
			return { table, lookup, error: `${table} is not in the game's packs` };
		}
		const columns = (lookup ?? []).map((name) => t.columns.findIndex((c) => c.name === name)).filter((i) => i >= 0);
		const options = t.rows.map((r) => ({
			key: r.key,
			label: columns.map((i) => r.values[i]).filter((v) => v !== undefined && v !== '').join(' · '),
		}));
		return { table, lookup, options };
	} catch (e) {
		return { table, lookup, error: (e as Error).message };
	}
}

function serializeRows(model: DbTableModel): unknown[][] {
	return model.rows.map((r) => r.map((v) => (v === undefined ? null : v)));
}

/**
 * Creates an empty DB table fragment and opens it. `target` is a folder from the
 * Explorer: a mod's pack folder, its `db` folder or a `db/<table>` folder.
 */
export async function newDbTable(db: DbService, target?: vscode.Uri): Promise<void> {
	let dbDir: vscode.Uri | undefined;
	let preselect: string | undefined;
	if (target) {
		const name = path.posix.basename(target.path).toLowerCase();
		const parent = path.posix.basename(path.posix.dirname(target.path)).toLowerCase();
		if (name === 'db') {
			dbDir = target;
		} else if (parent === 'db') {
			dbDir = vscode.Uri.joinPath(target, '..');
			preselect = path.posix.basename(target.path);
		} else {
			dbDir = vscode.Uri.joinPath(target, 'db');
		}
	} else {
		const packs: vscode.Uri[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const pack = vscode.Uri.joinPath(folder.uri, 'pack');
			if (await vscode.workspace.fs.stat(pack).then((s) => s.type === vscode.FileType.Directory, () => false)) {
				packs.push(pack);
			}
		}
		let pack = packs.length === 1 ? packs[0] : undefined;
		if (!pack) {
			const picked = await vscode.window.showOpenDialog({
				canSelectFolders: true, canSelectFiles: false, defaultUri: packs[0] ?? vscode.workspace.workspaceFolders?.[0]?.uri,
				openLabel: 'Use this pack folder', title: 'Folder that becomes the mod pack (the one with script/, db/, ...)',
			});
			pack = picked?.[0];
		}
		if (!pack) {
			return;
		}
		dbDir = vscode.Uri.joinPath(pack, 'db');
	}

	const { schema, game } = await db.schema();
	const tables = schema.tableNames();
	const table = await vscode.window.showQuickPick(
		tables.map((t) => ({ label: t, picked: t === preselect })),
		{ placeHolder: 'Table to add a fragment of' }).then((p) => p?.label);
	if (!table) {
		return;
	}
	const modName = path.posix.basename(path.posix.dirname(dbDir.path)) === 'pack'
		? path.posix.basename(path.posix.dirname(path.posix.dirname(dbDir.path)))
		: path.posix.basename(path.posix.dirname(dbDir.path));
	const fileName = await vscode.window.showInputBox({
		title: `New ${table} fragment`,
		prompt: 'File name. Fragments load by name and the first one with a key wins: start with "!" to override the game\'s "data__".',
		value: `!!!${modName}`,
		validateInput: (v) => (!v.trim() ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'Not a valid file name' : undefined),
	});
	if (!fileName) {
		return;
	}
	const tsv = newFileFormat() === 'tsv';
	const uri = vscode.Uri.joinPath(dbDir, table, fileName.trim() + (tsv ? '.tsv' : ''));
	if (await vscode.workspace.fs.stat(uri).then(() => true, () => false)) {
		void vscode.window.showErrorMessage(`${uri.fsPath} already exists.`);
		return;
	}
	const version = await db.gameVersion(table).catch(() => undefined);
	const empty = schema.emptyTable(table, version) ?? schema.emptyTable(table);
	if (!empty) {
		void vscode.window.showErrorMessage(`The schema has no definition of ${table}.`);
		return;
	}
	const binary = rpfm().encodeDb(schema, table, empty.version, [], game);
	await vscode.workspace.fs.writeFile(uri, tsv ? toTsv(binary, `db/${table}/${fileName.trim()}`, schema) : binary);
	await vscode.commands.executeCommand('vscode.openWith', uri, DbEditorProvider.viewType);
}

function newFileFormat(): 'binary' | 'tsv' {
	return vscode.workspace.getConfiguration('totalwar').get<'binary' | 'tsv'>('newTableFormat', 'binary');
}

/**
 * Creates an empty loc file and opens it. `target` is a folder from the
 * Explorer (a pack folder gets `text/db/` added); without one, the
 * workspace's `pack/text/db`.
 */
export async function newLocFile(db: DbService, target?: vscode.Uri): Promise<void> {
	let dir = target;
	if (!dir) {
		const pack = (vscode.workspace.workspaceFolders ?? [])
			.filter((f) => f.uri.scheme === 'file')
			.map((f) => vscode.Uri.joinPath(f.uri, 'pack'))
			.find((p) => fs.existsSync(p.fsPath));
		dir = pack && vscode.Uri.joinPath(pack, 'text', 'db');
	} else if (fs.existsSync(path.join(dir.fsPath, 'script')) || fs.existsSync(path.join(dir.fsPath, 'db'))) {
		dir = vscode.Uri.joinPath(dir, 'text', 'db');
	}
	if (!dir) {
		void vscode.window.showErrorMessage('Right-click the folder to put the loc file in (usually <pack>/text/db).');
		return;
	}
	const modName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'my_mod';
	const name = await vscode.window.showInputBox({
		title: 'New loc file',
		prompt: 'File name, without .loc. The first loc file (by name) with a key wins: start with "!" to override the game\'s texts.',
		value: `!!!${modName}`,
		validateInput: (v) => (!v.trim() ? 'Enter a name' : /[\\/:*?"<>|]/.test(v) ? 'Not a valid file name' : undefined),
	});
	if (!name) {
		return;
	}
	const tsv = newFileFormat() === 'tsv';
	const uri = vscode.Uri.joinPath(dir, `${name.trim()}.loc${tsv ? '.tsv' : ''}`);
	if (fs.existsSync(uri.fsPath)) {
		void vscode.window.showErrorMessage(`${uri.fsPath} already exists.`);
		return;
	}
	const binary = rpfm().encodeLoc([]);
	await vscode.workspace.fs.writeFile(uri, tsv ? toTsv(binary, `text/db/${name.trim()}.loc`, (await db.schema()).schema) : binary);
	await vscode.commands.executeCommand('vscode.openWith', uri, DbEditorProvider.viewType);
}

/**
 * Reads a mod's DB table or loc file (binary or TSV) into a table model.
 * `from` is where to read it from (a backup), by default the file itself.
 */
export async function readModFile(db: DbService, file: DbDocument, from = file.uri): Promise<DbTableModel> {
	let bytes: Uint8Array = await vscode.workspace.fs.readFile(from);
	if (file.kind === 'loc') {
		const rows = bytes.length === 0 ? []
			: rpfm().decodeLocBytes(file.format === 'tsv' ? fromTsv(from, bytes, undefined, db.game) : Buffer.from(bytes));
		return new DbTableModel('loc', 1, '', LOC_FIELDS, rows.map((r) => [r.key, r.text, r.tooltip]));
	}
	const { schema, game } = await db.schema();
	if (file.format === 'tsv' && bytes.length) {
		bytes = fromTsv(from, bytes, schema, game);
	}
	let data;
	if (bytes.length === 0) {
		// A new, empty file: the game's version of the table, else the schema's newest.
		const version = await db.gameVersion(file.table).catch(() => undefined);
		data = schema.emptyTable(file.table, version) ?? schema.emptyTable(file.table);
		if (!data) {
			throw new Error(`The schema has no table "${file.table}". Is the file in db/<table>_tables/?`);
		}
	} else {
		data = rpfm().decodeDbBytes(Buffer.from(bytes), file.table, schema);
	}
	if (data.version < 0 && data.rows.length === 0 && data.fields.length === 0) {
		throw new Error(`The schema has no definition for this version of ${file.table}.`);
	}
	return new DbTableModel(file.table, data.version, data.guid, data.fields, data.rows);
}

/** The bytes of a mod file for a model: binary, or TSV text when the file is `.tsv`. */
export async function encodeModFile(db: DbService, file: DbDocument, model: DbTableModel): Promise<Uint8Array> {
	if (file.kind === 'loc') {
		const rows = model.completeRows().map(([key, text, tooltip]) => ({ key: String(key), text: String(text), tooltip: tooltip === true }));
		const binary = rpfm().encodeLoc(rows);
		return file.format === 'tsv' ? toTsv(binary, file.packPath, (await db.schema()).schema) : binary;
	}
	const { schema, game } = await db.schema();
	const binary = rpfm().encodeDb(schema, model.table, model.version, model.completeRows(), game, model.guid);
	return file.format === 'tsv' ? toTsv(binary, file.packPath, schema) : binary;
}

/**
 * Rewrites a mod's DB table with the version of the table the game uses:
 * columns are matched by name, new ones get the schema's defaults.
 */
export async function migrateModTable(db: DbService, uri: vscode.Uri): Promise<string> {
	const file = new DbDocument(uri);
	if (file.kind !== 'db') {
		throw new Error('Only DB tables have versions.');
	}
	const model = await readModFile(db, file);
	const version = await db.gameVersion(file.table);
	if (version === undefined) {
		throw new Error(`The game has no ${file.table}.`);
	}
	if (version === model.version) {
		return `${file.fileName} already has version ${version}.`;
	}
	const { schema } = await db.schema();
	const target = schema.emptyTable(file.table, version);
	if (!target) {
		throw new Error(`The schema has no version ${version} of ${file.table}. Run "TotalWar: Update DB Schema".`);
	}
	const column = new Map(model.fields.map((f, i) => [f.name, i]));
	const fresh = new DbTableModel(file.table, version, model.guid, target.fields, []);
	const defaults = fresh.newRow();
	fresh.rows = model.rows.map((row) => target.fields.map((f, i) => {
		const from = column.get(f.name);
		return from !== undefined && row[from] !== undefined ? row[from] : defaults[i];
	}));
	const added = target.fields.filter((f) => !column.has(f.name)).map((f) => f.name);
	const dropped = model.fields.filter((f) => !target.fields.some((t) => t.name === f.name)).map((f) => f.name);
	await vscode.workspace.fs.writeFile(uri, await encodeModFile(db, file, fresh));
	return `${file.fileName}: version ${model.version} -> ${version}`
		+ (added.length ? `; new columns (defaults): ${added.join(', ')}` : '')
		+ (dropped.length ? `; removed columns: ${dropped.join(', ')}` : '');
}

/** The binary file a TSV file describes (a file on disk, or its bytes from elsewhere). */
function fromTsv(uri: vscode.Uri, bytes: Uint8Array, schema: DbSchema | undefined, game: string): Buffer {
	let file = uri.scheme === 'file' ? uri.fsPath : undefined;
	let temp: string | undefined;
	if (!file) {
		temp = path.join(os.tmpdir(), `totalwar-${process.pid}-${Date.now()}.tsv`);
		fs.writeFileSync(temp, bytes);
		file = temp;
	}
	try {
		const imported = rpfm().tsvToBinary(file, schema, game);
		const expected = /\.loc(\.tsv)?$/i.test(uri.path) ? 'loc' : 'db';
		if (imported.kind !== expected) {
			throw new Error(`${path.basename(uri.fsPath)} holds a ${imported.kind === 'loc' ? 'loc file' : 'DB table'} (its first lines say so).`);
		}
		return imported.bytes;
	} finally {
		if (temp) {
			fs.rmSync(temp, { force: true });
		}
	}
}

/** `binary` (a DB table or loc file at `packPath`) as RPFM TSV text. */
function toTsv(binary: Buffer, packPath: string, schema: DbSchema): Uint8Array {
	const temp = path.join(os.tmpdir(), `totalwar-${process.pid}-${Date.now()}-out.tsv`);
	try {
		rpfm().binaryToTsv(binary, packPath, schema, temp);
		return fs.readFileSync(temp);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

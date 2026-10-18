import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { planClone } from '../../../src/db/cloneEntity';
import { DbTableModel } from '../../../src/db/dbTableModel';
import type { TwLuaDebuggerApi } from '../../../src/extension';

const extensionRoot = path.resolve(__dirname, '..', '..', '..', '..');
const lua = path.join(extensionRoot, '.tools', 'lua51', process.platform === 'win32' ? 'lua51.exe' : 'lua51');
const fixtures = path.join(extensionRoot, 'test', 'lua', 'fixtures');
const testScript = path.join(fixtures, 'script', 'campaign', 'mod', 'test_script.lua');
const debuggeeRoot = path.resolve(extensionRoot, '..', 'debuggee');

// Optional: a real game install for the virtual source file test (read only).
const wh3 = process.env.TW_GAME_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III';

describe('Total War Modding Tools extension', () => {
	let api: TwLuaDebuggerApi;

	before(async () => {
		const ext = vscode.extensions.getExtension<TwLuaDebuggerApi>('Fietspompje.total-war-modding-tools');
		assert.ok(ext, 'extension not found');
		api = await ext.activate();
	});

	it('registers its commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const c of ['totalwar.sourceFiles', 'totalwar.reloadSourceFiles', 'totalwar.installDebuggerMod', 'totalwar.openDbTable', 'totalwar.updateDbSchema', 'totalwar.filterVirtualFiles']) {
			assert.ok(commands.includes(c), `missing ${c}`);
		}
	});

	it('serves the Lua files of an installed game as totalwar:/', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'data.pack'))) {
			this.skip();
		}
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		const root = await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/'));
		assert.deepEqual(root, [['@basegame', vscode.FileType.Directory]]);
		const lib = await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/@basegame/script/_lib'));
		assert.ok(lib.some(([name, type]) => name === 'lib_core.lua' && type === vscode.FileType.File));
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('totalwar:/@basegame/SCRIPT/_lib/lib_core.lua'));
		assert.match(doc.getText(), /core_object/);
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse('totalwar:/@basegame/script/nope.lua'))));
		// toString() encodes '@' as %40; compare the decoded path.
		assert.equal(vscode.Uri.parse(api.sources.uriFor('script/_lib/lib_core.lua')!).path, '/@basegame/script/_lib/lib_core.lua');
	});

	it('shows the effective DB tables of an installed game', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack'))) {
			this.skip();
		}
		this.timeout(120000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		const tables = await api.db.tables();
		assert.ok(tables.includes('land_units_tables'), 'land_units_tables missing');
		const units = await api.db.table('land_units_tables');
		assert.ok(units.rows.length > 1000);
		assert.deepEqual(units.errors, []);
		const swordsmen = units.byKey.get('wh_main_emp_inf_swordsmen');
		assert.equal(swordsmen?.source.pack, 'db.pack');
		const found = await api.db.findKey('wh_main_emp_inf_swordsmen');
		assert.ok(found.some((f) => f.table === 'land_units_tables'));
		// The grid opens on a row.
		await vscode.commands.executeCommand('totalwar.openDbTable', 'land_units_tables', 'wh_main_emp_inf_swordsmen');
		// The tab model is updated asynchronously.
		const gridTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
			.some((t) => t.input instanceof vscode.TabInputWebview && t.label === 'land_units_tables');
		for (let i = 0; i < 50 && !gridTab(); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
		assert.ok(tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.label === 'land_units_tables'),
			`tabs: ${tabs.map((t) => t.label).join(', ')}`);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it('generates Lua API stubs and completes DB keys and events in Lua', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack'))) {
			this.skip();
		}
		this.timeout(180000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		const dir = await api.luaApi.refresh(true);
		assert.ok(dir && fs.existsSync(path.join(dir, '_lib.lib_campaign_manager.lua')), `stubs in ${dir}`);
		assert.match(fs.readFileSync(path.join(dir, '_types.lua'), 'utf8'), /---@type campaign_manager\ncm = nil/);
		assert.ok(api.luaApi.events.includes('FactionTurnStart'));

		// A saved file: an unsaved one would make later debug sessions ask to save it.
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-lua-')), 'complete.lua');
		fs.writeFileSync(file, 'cm:add_unit_model_overrides("wh_main_emp_inf_swor")\ncore:add_listener("x", "FactionTu');
		const doc = await vscode.workspace.openTextDocument(file);
		const keys = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 49));
		assert.ok(keys.items.some((i) => i.label === 'wh_main_emp_inf_swordsmen'), keys.items.slice(0, 10).map((i) => i.label).join(', '));
		if (!vscode.extensions.getExtension('sumneko.lua')) {
			const events = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(1, 33));
			assert.ok(events.items.some((i) => i.label === 'FactionTurnStart'));
		}
	});

	it('lists the DB tables in the Game Database view', async function () {
		if (!fs.existsSync(path.join(wh3, 'tw_test_mod.txt'))) {
			this.skip();
		}
		this.timeout(120000);
		await api.sources.configure({ exeDir: wh3, modListFile: 'tw_test_mod.txt', game: 'warhammer_3' });
		const root = await api.dbTree.getChildren();
		assert.ok(root.length > 1000);
		// Only tables; clicking one opens it in the grid.
		const table = root.find((n) => (n as { table?: string }).table === 'land_units_tables')!;
		assert.deepEqual(await api.dbTree.getChildren(table), []);
		const item = api.dbTree.getTreeItem(table);
		assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.deepEqual(item.command?.arguments, ['land_units_tables']);
	});

	it('shows each mod\'s own files under @mods', async function () {
		// Uses a mod list with at least one mod in it, if this machine has one.
		const modList = ['tw_test_mod.txt', 'used_mods.txt'].find((f) => fs.existsSync(path.join(wh3, f)));
		if (!fs.existsSync(path.join(wh3, 'data', 'data.pack')) || !modList) {
			this.skip();
		}
		await api.sources.configure({ exeDir: wh3, modListFile: modList!, game: 'warhammer_3' });
		const mods = await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/@mods'));
		assert.ok(mods.length > 0, 'no mods listed');
		const [packName] = mods[0];
		assert.match(packName, /\.pack$/);
		const root = (await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/'))).map(([n]) => n).sort();
		assert.deepEqual(root, ['@basegame', '@mods']);
		const walk = async (uri: vscode.Uri): Promise<string[]> => {
			const out: string[] = [];
			for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
				const child = vscode.Uri.joinPath(uri, name);
				out.push(...(type === vscode.FileType.Directory ? await walk(child) : [child.path]));
			}
			return out;
		};
		const modRoot = vscode.Uri.parse(`totalwar:/@mods/${packName}`);
		const files = await walk(modRoot);
		assert.ok(files.length > 0);
		// Every file of the mod is listed; the debugger maps Lua files.
		const lua = files.find((f) => f.endsWith('.lua'))!;
		assert.ok(lua, 'no Lua file in the mod');
		const own = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(`totalwar:${lua}`)));
		assert.ok(own.length > 0);
		// The copy the game runs is the first mod's: for the first mod's files, that mod.
		const inner = lua.slice(modRoot.path.length + 1);
		assert.equal(api.sources.uriFor(inner), vscode.Uri.parse(`totalwar:${lua}`).toString());
		// Back to the plain game files for the next tests.
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
	});

	it('refuses to start without a valid executable', async () => {
		const started = await vscode.debug.startDebugging(undefined, {
			name: 'bad', type: 'totalwar-lua', request: 'launch', executable: path.join(extensionRoot, 'does-not-exist.exe'),
		});
		assert.equal(started, false);
	});

	it('shows the game\'s DB tables in the virtual files, read-only in the editor', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack'))) {
			this.skip();
		}
		this.timeout(120000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		// Every file is listed, not only Lua and DB tables: a PNG reads back as its bytes.
		const top = (await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/@basegame'))).map(([n]) => n);
		assert.ok(top.includes('ui') && top.includes('script') && top.includes('db'), top.join(', '));
		const findPng = async (dir: vscode.Uri, depth: number): Promise<vscode.Uri | undefined> => {
			for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
				const child = vscode.Uri.joinPath(dir, name);
				if (type === vscode.FileType.File && name.endsWith('.png')) {
					return child;
				}
				if (type === vscode.FileType.Directory && depth > 0) {
					const found = await findPng(child, depth - 1);
					if (found) {
						return found;
					}
				}
			}
			return undefined;
		};
		const png = await findPng(vscode.Uri.parse('totalwar:/@basegame/ui'), 3);
		assert.ok(png, 'no png under ui/');
		const bytes = await vscode.workspace.fs.readFile(png);
		assert.deepEqual([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join(''), 'PNG');
		assert.equal((await vscode.workspace.fs.stat(png)).type, vscode.FileType.File);
		// The filter hides files, and folders left empty; hidden files still open.
		const config = vscode.workspace.getConfiguration('totalwar');
		await config.update('virtualFiles.exclude', ['audio', '*.png'], vscode.ConfigurationTarget.Global);
		try {
			await api.sources.refilter();
			const filtered = (await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/@basegame'))).map(([n]) => n);
			assert.ok(!filtered.includes('audio') && filtered.includes('ui'), filtered.join(', '));
			const pngFolder = vscode.Uri.joinPath(png, '..');
			const left = await vscode.workspace.fs.readDirectory(pngFolder).then((l) => l.map(([n]) => n), () => [] as string[]);
			assert.ok(!left.some((n) => n.endsWith('.png')), left.join(', '));
			assert.equal((await vscode.workspace.fs.stat(png)).type, vscode.FileType.File);
		} finally {
			await config.update('virtualFiles.exclude', undefined, vscode.ConfigurationTarget.Global);
			await api.sources.refilter();
		}
		const tables = await vscode.workspace.fs.readDirectory(vscode.Uri.parse('totalwar:/@basegame/db'));
		assert.ok(tables.some(([name, type]) => name === 'land_units_tables' && type === vscode.FileType.Directory));
		const uri = vscode.Uri.parse('totalwar:/@basegame/db/unit_armour_types_tables/data__');
		await vscode.commands.executeCommand('vscode.openWith', uri, 'totalwar.dbEditor');
		let doc;
		for (let i = 0; i < 100 && !(doc = api.dbEditor.documents.find((d) => d.uri.path === uri.path && (d.model || d.error))); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(doc?.model, doc?.error ?? 'not opened');
		assert.ok(doc.model.rows.length > 50);
		assert.equal(doc.readOnly, true);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it('edits and saves a DB table file', async function () {
		this.timeout(120000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdb-edit-'));
		const file = vscode.Uri.file(path.join(dir, 'pack', 'db', 'unit_armour_types_tables', '!!!test'));
		fs.mkdirSync(path.dirname(file.fsPath), { recursive: true });
		fs.writeFileSync(file.fsPath, ''); // a new, empty fragment
		const open = async () => {
			await vscode.commands.executeCommand('vscode.openWith', file, 'totalwar.dbEditor');
			for (let i = 0; i < 100 && !api.dbEditor.documents.some((d) => d.uri.fsPath === file.fsPath && (d.model || d.error)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const doc = api.dbEditor.documents.find((d) => d.uri.fsPath === file.fsPath)!;
			assert.ok(doc?.model, doc?.error ?? 'not opened');
			return doc;
		};
		let doc = await open();
		assert.equal(doc.model!.rows.length, 0);
		const keyCol = doc.model!.fields.findIndex((f) => f.isKey);
		const row = doc.model!.newRow();
		row[keyCol] = 'tw_test_armour';
		api.dbEditor.makeEdit(doc, { type: 'insert', index: 0, rows: [row] }, 'Add row');
		await vscode.commands.executeCommand('workbench.action.files.save');
		assert.ok(fs.statSync(file.fsPath).size > 0, 'not saved');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		doc = await open();
		assert.deepEqual(doc.model!.rows.map((r) => r[keyCol]), ['tw_test_armour']);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it('edits TSV tables and loc files, packs them as binary and migrates old table versions', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack'))) {
			this.skip();
		}
		this.timeout(180000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const native = require(path.join(extensionRoot, 'native', 'rpfm-interface.node')) as typeof import('../../../../rpfm-interface/rpfm-interface');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdb-tsv-'));
		const table = vscode.Uri.file(path.join(dir, 'pack', 'db', 'unit_armour_types_tables', '!!!test.tsv'));
		const loc = vscode.Uri.file(path.join(dir, 'pack', 'text', 'db', '!!!test.loc.tsv'));
		for (const f of [table, loc]) {
			fs.mkdirSync(path.dirname(f.fsPath), { recursive: true });
			fs.writeFileSync(f.fsPath, '');
		}
		const edit = async (file: vscode.Uri, values: Record<string, string>) => {
			await vscode.commands.executeCommand('vscode.openWith', file, 'totalwar.dbEditor');
			for (let i = 0; i < 100 && !api.dbEditor.documents.some((d) => d.uri.fsPath === file.fsPath && (d.model || d.error)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const doc = api.dbEditor.documents.find((d) => d.uri.fsPath === file.fsPath)!;
			assert.ok(doc?.model, doc?.error ?? 'not opened');
			const row = doc.model!.newRow();
			for (const [name, value] of Object.entries(values)) {
				row[doc.model!.fields.findIndex((f) => f.name === name)] = value;
			}
			api.dbEditor.makeEdit(doc, { type: 'insert', index: 0, rows: [row] }, 'Add row');
			await vscode.commands.executeCommand('workbench.action.files.save');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			return fs.readFileSync(file.fsPath, 'utf8');
		};
		assert.match(await edit(table, { key: 'tw_test_armour' }), /^key\t[\s\S]*#unit_armour_types_tables;\d+;[\s\S]*\ntw_test_armour\t/);
		assert.match(await edit(loc, { key: 'tw_test_text', text: 'Hello' }), /#Loc;1;[\s\S]*\ntw_test_text\tHello\tfalse/);

		const { schema } = await api.db.schema();
		const out = path.join(dir, 'test.pack');
		assert.equal(native.createPackFromFolder(path.join(dir, 'pack'), out, 'warhammer_3', schema), 2);
		const packed = native.openPacks([out], 'warhammer_3', true);
		assert.deepEqual(packed.paths(), ['db/unit_armour_types_tables/!!!test', 'text/db/!!!test.loc']);
		const decoded = packed.decodeDb('db/unit_armour_types_tables/!!!test', schema)!;
		assert.equal(decoded.rows[0][decoded.fields.findIndex((f) => f.name === 'key')], 'tw_test_armour');
		assert.deepEqual(packed.decodeLoc('text/db/!!!test.loc'), [{ key: 'tw_test_text', text: 'Hello', tooltip: false }]);

		// An older version of a table is rewritten with the game's.
		const gameVersion = (await api.db.gameVersion('land_units_tables'))!;
		const old = [gameVersion - 1, gameVersion - 2, gameVersion - 3].map((v) => schema.emptyTable('land_units_tables', v)).find((t) => t);
		if (old) {
			const file = path.join(dir, 'pack', 'db', 'land_units_tables', '!!!old');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, native.encodeDb(schema, 'land_units_tables', old.version, [], 'warhammer_3'));
			await vscode.commands.executeCommand('totalwar.migrateDbTable', vscode.Uri.file(file));
			assert.equal(native.decodeDbBytes(fs.readFileSync(file), 'land_units_tables', schema).version, gameVersion);
		}
	});

	it('lists problems of the mod\'s DB tables in the Problems view', async function () {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack')) || !folder) {
			this.skip();
		}
		this.timeout(180000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const native = require(path.join(extensionRoot, 'native', 'rpfm-interface.node')) as typeof import('../../../../rpfm-interface/rpfm-interface');
		const { schema } = await api.db.schema();
		const version = (await api.db.gameVersion('main_units_tables'))!;
		const empty = schema.emptyTable('main_units_tables', version)!;
		const model = new DbTableModel('main_units_tables', version, '', empty.fields, []);
		const row = model.newRow();
		const set = (name: string, value: string) => {
			row[empty.fields.findIndex((f) => f.name === name)] = value;
		};
		set('unit', 'tw_test_unit');
		set('land_unit', 'tw_no_such_land_unit');
		model.rows = [row, [...row]];
		const file = path.join(folder!.uri.fsPath, 'pack', 'db', 'main_units_tables', '!!!diag');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, native.encodeDb(schema, 'main_units_tables', version, model.completeRows(), 'warhammer_3'));
		try {
			const n = await api.modDiagnostics.run();
			const problems = vscode.languages.getDiagnostics(vscode.Uri.file(file)).map((d) => `${d.code}: ${d.message}`);
			assert.ok(n >= 2, problems.join('\n'));
			assert.ok(problems.some((p) => /^broken-reference: .*land_unit "tw_no_such_land_unit"/.test(p)), problems.join('\n'));
			assert.ok(problems.some((p) => /^duplicate-key: Row 2/.test(p)), problems.join('\n'));
		} finally {
			fs.rmSync(path.join(folder!.uri.fsPath, 'pack'), { recursive: true, force: true });
		}
	});

	it('plans the copy of a unit with the rows and texts that belong to it', async function () {
		if (!fs.existsSync(path.join(wh3, 'data', 'db.pack'))) {
			this.skip();
		}
		this.timeout(300000);
		await api.sources.configure({ exeDir: wh3, modListFile: '', game: 'warhammer_3' });
		const { schema } = await api.db.schema();
		const loc = await api.db.loc();
		const reverse = new Map<string, { table: string; column: string }[]>();
		for (const t of schema.tableNames()) {
			for (const f of schema.emptyTable(t)?.fields ?? []) {
				if (f.refTable) {
					reverse.set(f.refTable, [...reverse.get(f.refTable) ?? [], { table: t, column: f.name }]);
				}
			}
		}
		const tables = new Set(await api.db.tables());
		const plan = await planClone('main_units_tables', 'wh_main_emp_inf_swordsmen', 'tw_test_swordsmen', {
			table: async (name) => (tables.has(name) ? api.db.table(name).catch(() => undefined) : undefined),
			referencing: async (name) => reverse.get(name) ?? [],
			loc: (k) => loc.get(k),
		});
		const summary = plan.rows.map((r) => `${r.table}: ${r.oldKey} -> ${r.newKey}`);
		if (process.env.TW_SHOW_PLAN) console.log(`      ${summary.join('\n      ')}\n      loc: ${plan.loc.map((l) => l.newKey).join(', ')}\n      skipped: ${JSON.stringify(plan.skipped)}`);
		assert.ok(summary.includes('main_units_tables: wh_main_emp_inf_swordsmen -> tw_test_swordsmen'), summary.join('\n'));
		assert.ok(summary.includes('land_units_tables: wh_main_emp_inf_swordsmen -> tw_test_swordsmen'), summary.join('\n'));
		assert.ok(plan.loc.some((l) => l.newKey === 'land_units_onscreen_name_tw_test_swordsmen'));
		const main = plan.rows.find((r) => r.table === 'main_units_tables')!;
		const columns = (await api.db.table('main_units_tables')).columns;
		assert.equal(main.values[columns.findIndex((c) => c.name === 'land_unit')], 'tw_test_swordsmen');
		const allowed = plan.rows.filter((r) => r.table === 'building_units_allowed_tables');
		assert.ok(allowed.length && allowed.every((r) => r.newKey !== r.oldKey), 'building_units_allowed rows get new keys');

		// Written into the mod, the copy references only rows that exist.
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const pack = path.join(folder.uri.fsPath, 'pack');
			fs.mkdirSync(pack, { recursive: true });
			try {
				const written = await api.writeClone(pack, 'tw_test', plan);
				assert.ok(written.some((u) => u.fsPath.endsWith(path.join('main_units_tables', '!!!tw_test'))), written.map((u) => u.fsPath).join('\n'));
				await api.modDiagnostics.run();
				const errors = written.flatMap((u) => vscode.languages.getDiagnostics(u)
					.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).map((d) => `${path.basename(path.dirname(u.fsPath))}: ${d.message}`));
				assert.deepEqual(errors, []);
			} finally {
				fs.rmSync(pack, { recursive: true, force: true });
			}
		}
	});

	it('debugs the fake game end to end through the inline adapter', async function () {
		if (!fs.existsSync(lua)) {
			this.skip();
		}
		const stopped = new Promise<{ line: number; source?: string }>((resolve) => {
			const tracker = vscode.debug.registerDebugAdapterTrackerFactory('totalwar-lua', {
				createDebugAdapterTracker: (session) => ({
					onDidSendMessage: async (m: { type: string; event?: string }) => {
						if (m.type === 'event' && m.event === 'stopped') {
							const st = await session.customRequest('stackTrace', { threadId: 1 });
							tracker.dispose();
							resolve({ line: st.stackFrames[0].line, source: st.stackFrames[0].source?.path });
						}
					},
				}),
			});
		});

		vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
			new vscode.Location(vscode.Uri.file(testScript), new vscode.Position(11, 0)))]);

		// The "game" is the Lua interpreter running the fake game loop.
		const args = ['"' + path.join(fixtures, 'run_game.lua') + '"', '"' + debuggeeRoot + '"', '"' + fixtures + '"', 'campaign', '40'].join(' ');
		const ok = await vscode.debug.startDebugging(undefined, {
			name: 'fake game', type: 'totalwar-lua', request: 'launch',
			executable: lua, modListFile: '', arguments: args, sourceFilesPath: fixtures, installDebuggerMod: false,
		});
		assert.ok(ok, 'debug session did not start');

		const where = await stopped;
		assert.equal(where.line, 12);
		assert.equal(path.normalize(where.source ?? '').toLowerCase(), path.normalize(testScript).toLowerCase());

		await vscode.debug.stopDebugging();
		vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
	});
});

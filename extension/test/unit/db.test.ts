import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { DebugClient } from '@vscode/debugadapter-testsupport';

import { DB_REF_BASE, DbVariables, isDbRef } from '../../src/adapter/dbVariables';
import { TwLuaDebugSession } from '../../src/adapter/session';
import { DbEdit, DbTableModel, parseValue } from '../../src/db/dbTableModel';
import {
	compareFragments, DbField, EffectiveTable, Fragment, fragmentEffect, GameDatabase, mapRows, mergeFragments, PackFiles,
	selectFragments, sortsAfterGame, tableNames,
} from '../../src/db/effective';
import { downloadIsStale, downloadSchema, findSchema, resolveSchema, schemaFileName, SCHEMA_MAX_AGE_MS } from '../../src/db/schema';

const key: DbField = { name: 'key', fieldType: 'StringU8', isKey: true };
const cost: DbField = { name: 'cost', fieldType: 'I32', isKey: false };
const armour: DbField = { name: 'armour', fieldType: 'StringU8', isKey: false, refTable: 'unit_armour_types', refColumn: 'key' };

function fragment(pack: string, file: string, fields: DbField[], rows: (string | number)[][], version = 1): Fragment {
	return { pack, path: `db/land_units_tables/${file}`, data: { table: 'land_units_tables', version, guid: '', fields, rows } };
}

describe('effective DB tables', () => {
	it('loads fragments by file name: ! before data__ before letters', () => {
		const names = ['zzz_mod', 'data__', '!!!mod', 'Abc', '_under', '0num'];
		const sorted = names.map((n) => ({ pack: 'p', path: `db/t/${n}` })).sort(compareFragments).map((f) => f.path.slice(5));
		assert.deepEqual(sorted, ['!!!mod', '0num', '_under', 'Abc', 'data__', 'zzz_mod']);
	});

	it('takes a fragment path from the highest priority pack only', () => {
		const sources: PackFiles<string>[] = [
			{ label: 'mod_a.pack', owner: 'A', files: [{ path: 'db/land_units_tables/data__', table: 'land_units_tables', pack: 'mod_a.pack' }] },
			{ label: 'mod_b.pack', owner: 'B', files: [{ path: 'db/land_units_tables/!b', table: 'land_units_tables' }] },
			{ label: '@basegame', owner: 'G', files: [
				{ path: 'db/land_units_tables/data__', table: 'land_units_tables', pack: 'db.pack' },
				{ path: 'db/factions_tables/data__', table: 'factions_tables', pack: 'db.pack' },
			] },
		];
		assert.deepEqual(selectFragments(sources, 'land_units_tables'), [
			{ pack: 'mod_b.pack', path: 'db/land_units_tables/!b', owner: 'B' },
			{ pack: 'mod_a.pack', path: 'db/land_units_tables/data__', owner: 'A' },
		]);
		assert.deepEqual(tableNames(sources), ['factions_tables', 'land_units_tables']);
	});

	it('keeps the first row per key and records what it overrides', () => {
		const t = mergeFragments('land_units_tables', [
			fragment('mod.pack', '!!!mod', [key, cost], [['swordsmen', 999]]),
			fragment('db.pack', 'data__', [key, cost], [['swordsmen', 500], ['spearmen', 400]]),
		]);
		assert.deepEqual(t.rows.map((r) => [r.key, r.values[1], r.source.pack]), [['swordsmen', 999, 'mod.pack'], ['spearmen', 400, 'db.pack']]);
		const sw = t.byKey.get('swordsmen')!;
		assert.deepEqual(sw.overridden, [{ source: { pack: 'db.pack', path: 'db/land_units_tables/data__' }, values: ['swordsmen', 500] }]);
		assert.equal(t.byKey.get('spearmen')!.overridden.length, 0);
	});

	it('maps fragments of older versions onto the newest columns by name', () => {
		const t = mergeFragments('land_units_tables', [
			fragment('old_mod.pack', '!old', [cost, key], [[10, 'a']], 1),
			fragment('db.pack', 'data__', [key, armour, cost], [['b', 'heavy', 20]], 2),
		]);
		assert.deepEqual(t.columns.map((c) => c.name), ['key', 'armour', 'cost']);
		assert.deepEqual(t.byKey.get('a')!.values, ['a', undefined, 10]);
		assert.deepEqual(t.byKey.get('b')!.values, ['b', 'heavy', 20]);
	});

	it('joins compound keys and numbers keyless rows', () => {
		const second: DbField = { ...cost, name: 'level', isKey: true };
		const compound = mergeFragments('t', [fragment('p', 'x', [key, second], [['a', 1], ['a', 2], ['a', 1]])]);
		assert.deepEqual(compound.rows.map((r) => r.key), ['a | 1', 'a | 2']);
		const keyless = mergeFragments('t', [fragment('p', 'x', [cost], [[1], [1]])]);
		assert.deepEqual(keyless.rows.map((r) => r.key), ['#0', '#1']);
	});
});

describe('DB schema', () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'twdb-'));
	const ron = '(\n\tversion: 5,\n\tdefinitions: {},\n)';

	it('names schema files as rpfm-schemas does', () => {
		assert.equal(schemaFileName('warhammer_3'), 'schema_wh3.ron');
		assert.equal(schemaFileName('three_kingdoms'), 'schema_3k.ron');
	});

	it('prefers the setting, then the download, then the bundled copy', () => {
		const dir = tmp();
		const where = { downloadDir: path.join(dir, 'dl'), bundledDir: path.join(dir, 'bundled') };
		assert.equal(findSchema('warhammer_3', where), undefined);
		fs.mkdirSync(where.bundledDir);
		fs.writeFileSync(path.join(where.bundledDir, 'schema_wh3.ron'), ron);
		assert.equal(findSchema('warhammer_3', where)?.origin, 'bundled');
		fs.mkdirSync(where.downloadDir);
		fs.writeFileSync(path.join(where.downloadDir, 'schema_wh3.ron'), ron);
		assert.equal(findSchema('warhammer_3', where)?.origin, 'downloaded');
		// A folder setting is searched for the game's file; a file setting is used as is.
		const custom = path.join(dir, 'rpfm');
		fs.mkdirSync(custom);
		fs.writeFileSync(path.join(custom, 'schema_wh3.ron'), ron);
		assert.deepEqual(findSchema('warhammer_3', { ...where, setting: custom }), { file: path.join(custom, 'schema_wh3.ron'), origin: 'setting' });
		assert.equal(findSchema('warhammer_3', { ...where, setting: path.join(dir, 'missing.ron') })?.origin, 'downloaded');
	});

	it('downloads, refreshes when stale and falls back when offline', async () => {
		const dir = tmp();
		const where = { downloadDir: path.join(dir, 'dl'), bundledDir: path.join(dir, 'bundled') };
		let fetched = '';
		const file = await downloadSchema('warhammer_3', where.downloadDir, async (url) => ((fetched = url), ron));
		assert.match(fetched, /rpfm-schemas\/master\/schema_wh3\.ron$/);
		assert.equal(fs.readFileSync(file, 'utf8'), ron);
		assert.equal(downloadIsStale('warhammer_3', where.downloadDir), false);
		assert.equal(downloadIsStale('warhammer_3', where.downloadDir, Date.now() + SCHEMA_MAX_AGE_MS + 1000), true);
		await assert.rejects(downloadSchema('warhammer_3', where.downloadDir, async () => '<html>404</html>'), /does not look like/);

		// Stale and offline: the existing copy is used.
		fs.utimesSync(file, new Date(0), new Date(0));
		const logs: string[] = [];
		const found = await resolveSchema('warhammer_3', where, (m) => logs.push(m), async () => {
			throw new Error('offline');
		});
		assert.deepEqual(found, { file, origin: 'downloaded' });
		assert.match(logs.join(), /offline.*downloaded copy/);
	});
});

/** A two-table database for the adapter tests. */
function fakeDatabase(): GameDatabase {
	const tables: Record<string, EffectiveTable> = {
		land_units_tables: mergeFragments('land_units_tables', [
			fragment('mod.pack', '!!!mod', [key, armour, cost], [['wh_main_emp_inf_swordsmen', 'heavy', 999]]),
			fragment('db.pack', 'data__', [key, armour, cost], [['wh_main_emp_inf_swordsmen', 'heavy', 500], ['wh_main_emp_inf_spearmen', 'light', 400]]),
		]),
		unit_armour_types: mergeFragments('unit_armour_types', [
			{ pack: 'db.pack', path: 'db/unit_armour_types/data__', data: { table: 'unit_armour_types', version: 1, guid: '', fields: [key, { ...cost, name: 'value' }], rows: [['heavy', 80], ['light', 30]] } },
		]),
	};
	return {
		tables: async () => Object.keys(tables).sort(),
		table: async (name) => {
			const t = tables[name];
			if (!t) {
				throw new Error(`no table ${name}`);
			}
			return t;
		},
		findKey: async (k) => Object.values(tables).filter((t) => t.byKey.has(k)).map((t) => ({ table: t.name, row: t.byKey.get(k)! })),
	};
}

describe('DB variables', () => {
	it('hands out references that cannot collide with the game\'s', async () => {
		const v = new DbVariables(fakeDatabase());
		const all = await v.evaluate(':db');
		assert.ok(isDbRef(all.variablesReference) && !isDbRef(DB_REF_BASE - 1));
		const tables = await v.variables({ variablesReference: all.variablesReference });
		assert.deepEqual(tables.map((t) => t.name), ['land_units_tables', 'unit_armour_types']);
		const rows = await v.variables({ variablesReference: tables[0].variablesReference, start: 1, count: 1 });
		assert.deepEqual(rows.map((r) => r.name), ['wh_main_emp_inf_spearmen']);
	});

	it('shows fields, the source, overridden rows and follows references', async () => {
		const v = new DbVariables(fakeDatabase());
		const result = await v.evaluate(':db land_units_tables swordsmen');
		assert.match(result.result, /wh_main_emp_inf_swordsmen \(from mod\.pack\)/);
		const fields = await v.variables({ variablesReference: result.variablesReference });
		const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
		assert.equal(byName.cost.value, '999');
		assert.equal(byName['(source)'].value, 'mod.pack/db/land_units_tables/!!!mod');
		assert.equal(byName['(overrides)'].value, 'db.pack');
		const losers = await v.variables({ variablesReference: byName['(overrides)'].variablesReference });
		const loser = await v.variables({ variablesReference: losers[0].variablesReference });
		assert.equal(loser.find((f) => f.name === 'cost')!.value, '500');
		const armourRow = await v.variables({ variablesReference: byName.armour.variablesReference });
		assert.equal(armourRow.find((f) => f.name === 'value')!.value, '80');
	});

	it('evaluates :db queries and completes tables and keys', async () => {
		const v = new DbVariables(fakeDatabase());
		assert.equal((await v.evaluate(':db')).result, '2 tables');
		const all = await v.evaluate(':db land_units_tables');
		assert.equal(all.result, 'land_units_tables: 2 of 2 rows');
		assert.equal(all.indexedVariables, 2);
		assert.match((await v.evaluate(':db heavy')).result, /in unit_armour_types/);
		await assert.rejects(v.evaluate(':db nothing_like_this'), /neither a table nor a key/);
		assert.deepEqual((await v.complete(':db land')).map((c) => c.label), ['land_units_tables']);
		assert.deepEqual((await v.complete(':db land_units_tables wh_main_emp_inf_sp')).map((c) => c.label), ['wh_main_emp_inf_spearmen']);
	});

	it('answers :db in the debug session without a connected game', async () => {
		const server = net.createServer((socket) => {
			const session = new TwLuaDebugSession({ database: fakeDatabase() });
			session.setRunAsServer(true);
			session.start(socket, socket);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const dc = new DebugClient('node', 'unused', 'totalwar-lua');
		try {
			await dc.start((server.address() as net.AddressInfo).port);
			await dc.initializeRequest();
			const r = await dc.evaluateRequest({ expression: ':db unit_armour_types', context: 'repl' });
			assert.equal(r.body.result, 'unit_armour_types: 2 of 2 rows');
			const rows = await dc.variablesRequest({ variablesReference: r.body.variablesReference });
			assert.deepEqual(rows.body.variables.map((x) => x.name), ['heavy', 'light']);
			const done = await dc.completionsRequest({ text: ':db unit_', column: 10 });
			assert.deepEqual(done.body.targets.map((t) => t.label), ['unit_armour_types']);
			await assert.rejects(dc.setVariableRequest({ variablesReference: r.body.variablesReference, name: 'heavy', value: '1' }), /read-only/);
			// Anything else still needs the game.
			await assert.rejects(dc.evaluateRequest({ expression: 'x', context: 'repl' }), /not connected/);
		} finally {
			await dc.stop();
			server.close();
		}
	});
});

describe('DB editor', () => {
	const others = () => mergeFragments('land_units_tables', [
		fragment('tw_test_lib.pack', '!!tw_test_lib', [key, cost], [['swordsmen', 77], ['halberdiers', 70]]),
		fragment('db.pack', 'data__', [key, cost], [['swordsmen', 60], ['spearmen', 60]]),
	]);

	it('tells what each row of a fragment does in the game', () => {
		const effects = fragmentEffect({ pack: '(this file)', path: 'db/land_units_tables/!!!tw_test_mod' }, [key, cost],
			[['swordsmen', 88], ['spearmen', 60], ['new_unit', 1], ['swordsmen', 5]], others());
		assert.deepEqual(effects.map((e) => e.kind), ['wins', 'wins', 'new', 'duplicate']);
		assert.deepEqual(effects[0].other, { pack: 'tw_test_lib.pack', path: 'db/land_units_tables/!!tw_test_lib' });
		assert.deepEqual(effects[0].changed, { 1: '77' });
		assert.deepEqual(effects[1].changed, {}, 'same values: nothing highlighted');
		const late = fragmentEffect({ pack: '(this file)', path: 'db/land_units_tables/zzz_mod' }, [key, cost], [['spearmen', 1]], others());
		assert.deepEqual(late.map((e) => [e.kind, e.other?.pack]), [['loses', 'db.pack']]);
		assert.equal(sortsAfterGame('db/land_units_tables/zzz_mod'), true);
		assert.equal(sortsAfterGame('db/land_units_tables/!!!mod'), false);
	});

	it('copies game rows into a fragment\'s columns by name', () => {
		const t = others();
		assert.deepEqual(mapRows(t, [t.byKey.get('halberdiers')!], [cost, armour, key]), [[70, undefined, 'halberdiers']]);
	});

	it('applies and undoes edits', () => {
		const m = new DbTableModel('t', 1, 'g', [key, cost], [['a', 1], ['b', 2], ['c', 3]]);
		const edits: DbEdit[] = [
			{ type: 'set', row: 1, col: 1, value: 20, old: 2 },
			{ type: 'insert', index: 1, rows: [['x', 9], ['y', 8]] },
			m.deleteEdit([3, 0]),
		];
		// The delete edit was made against the original rows: rebuild it after the others.
		const states: unknown[] = [JSON.stringify(m.rows)];
		m.apply(edits[0]);
		states.push(JSON.stringify(m.rows));
		m.apply(edits[1]);
		states.push(JSON.stringify(m.rows));
		edits[2] = m.deleteEdit([3, 0]);
		m.apply(edits[2]);
		assert.deepEqual(m.rows, [['x', 9], ['y', 8], ['c', 3]]);
		m.revert(edits[2]);
		assert.equal(JSON.stringify(m.rows), states[2]);
		m.revert(edits[1]);
		assert.equal(JSON.stringify(m.rows), states[1]);
		m.revert(edits[0]);
		assert.equal(JSON.stringify(m.rows), states[0]);
	});

	it('parses typed values by column type', () => {
		const f = (fieldType: string): DbField => ({ name: 'x', fieldType, isKey: false });
		assert.equal(parseValue(f('I32'), ' 42 '), 42);
		assert.equal(parseValue(f('I32'), '4.2'), undefined);
		assert.equal(parseValue(f('I16'), '40000'), undefined);
		assert.equal(parseValue(f('F32'), '0.25'), 0.25);
		assert.equal(parseValue(f('F32'), 'abc'), undefined);
		assert.equal(parseValue(f('Boolean'), 'true'), true);
		assert.equal(parseValue(f('StringU8'), ' keep spaces '), ' keep spaces ');
		assert.equal(parseValue(f('SequenceU32'), 'x'), undefined);
		const m = new DbTableModel('t', 1, '', [{ ...key, defaultValue: 'k' }, { ...cost, defaultValue: '5' }, f('Boolean'), f('StringU8')], []);
		assert.deepEqual(m.newRow(), ['k', 5, false, '']);
	});

	// The native module and a schema, when this machine has them built/downloaded.
	const native = path.resolve(__dirname, '../../../../rpfm-interface/rpfm-interface.win32-x64-msvc.node');
	const schemaFile = path.resolve(__dirname, '../../../schemas/schema_wh3.ron');
	it('round-trips a table through the native encoder, keeping its GUID', function () {
		if (!fs.existsSync(native) || !fs.existsSync(schemaFile)) {
			this.skip();
		}
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const lib = require(native) as typeof import('../../../rpfm-interface/rpfm-interface');
		const schema = lib.loadSchema(schemaFile);
		const empty = schema.emptyTable('unit_armour_types_tables')!;
		const m = new DbTableModel(empty.table, empty.version, '', empty.fields, []);
		m.apply({ type: 'insert', index: 0, rows: [m.newRow()] });
		const keyCol = m.fields.findIndex((x) => x.isKey);
		m.apply({ type: 'set', row: 0, col: keyCol, value: 'tw_test_armour', old: m.rows[0][keyCol] });
		const guid = '0a1b2c3d-0000-4000-8000-123456789abc';
		const bytes = lib.encodeDb(schema, m.table, m.version, m.completeRows(), 'warhammer_3', guid);
		const back = lib.decodeDbBytes(bytes, m.table, schema);
		assert.equal(back.guid, guid);
		assert.equal(back.version, m.version);
		assert.deepEqual(back.rows, m.completeRows());
	});
});

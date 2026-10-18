import * as assert from 'node:assert/strict';

import { planClone } from '../../src/db/cloneEntity';
import { DbField, EffectiveTable, mergeFragments } from '../../src/db/effective';

function table(name: string, fields: DbField[], rows: (string | number | boolean)[][]): EffectiveTable {
	return mergeFragments(name, [{ pack: 'db.pack', path: `db/${name}/data__`, data: { table: name, version: 1, guid: '', fields, rows } }], []);
}

const key = (name: string, extra: Partial<DbField> = {}): DbField => ({ name, fieldType: 'StringU8', isKey: true, ...extra });
const col = (name: string, extra: Partial<DbField> = {}): DbField => ({ name, fieldType: 'StringU8', isKey: false, ...extra });

const TABLES: Record<string, EffectiveTable> = {
	main_units_tables: table('main_units_tables', [key('unit'), col('land_unit', { refTable: 'land_units_tables' }), col('caste', { refTable: 'unit_castes_tables' })], [
		['emp_swords', 'emp_swords', 'melee_infantry'],
		['emp_spears', 'emp_spears', 'melee_infantry'],
	]),
	land_units_tables: table('land_units_tables', [key('key'), col('armour', { refTable: 'unit_armour_types_tables' })], [['emp_swords', 'plate'], ['emp_spears', 'plate']]),
	unit_castes_tables: table('unit_castes_tables', [key('caste')], [['melee_infantry']]),
	unit_armour_types_tables: table('unit_armour_types_tables', [key('key')], [['plate']]),
	permissions_tables: table('permissions_tables', [key('unit', { refTable: 'main_units_tables' }), key('group')], [['emp_swords', 'empire'], ['emp_spears', 'empire']]),
	building_units_allowed_tables: table('building_units_allowed_tables', [key('key', { fieldType: 'I32' }), col('unit', { refTable: 'main_units_tables' }), col('building')], [[7, 'emp_swords', 'barracks'], [9, 'emp_spears', 'barracks']]),
};

const REFS: Record<string, { table: string; column: string }[]> = {
	main_units_tables: [{ table: 'permissions_tables', column: 'unit' }, { table: 'building_units_allowed_tables', column: 'unit' }],
	land_units_tables: [{ table: 'main_units_tables', column: 'land_unit' }],
};

const LOC: Record<string, string> = { land_units_onscreen_name_emp_swords: 'Swordsmen' };

describe('copying a game entity', () => {
	it('copies the rows that belong to it, links and texts, and shares the rest', async () => {
		const plan = await planClone('main_units_tables', 'emp_swords', 'my_swords', {
			table: async (n) => TABLES[n],
			referencing: async (n) => REFS[n] ?? [],
			loc: (k) => (LOC[k] ? { text: LOC[k], tooltip: false } : undefined),
		});
		const rows = Object.fromEntries(plan.rows.map((r) => [`${r.table}:${r.oldKey}`, r]));
		assert.deepEqual(Object.keys(rows).sort(), [
			'building_units_allowed_tables:7',
			'land_units_tables:emp_swords',
			'main_units_tables:emp_swords',
			'permissions_tables:emp_swords | empire',
		]);
		assert.deepEqual(rows['main_units_tables:emp_swords'].values, ['my_swords', 'my_swords', 'melee_infantry']);
		assert.deepEqual(rows['land_units_tables:emp_swords'].values, ['my_swords', 'plate']);
		assert.deepEqual(rows['permissions_tables:emp_swords | empire'].values, ['my_swords', 'empire']);
		assert.deepEqual(rows['building_units_allowed_tables:7'].values, [1009, 'my_swords', 'barracks']);
		assert.deepEqual(plan.loc, [{ oldKey: 'land_units_onscreen_name_emp_swords', newKey: 'land_units_onscreen_name_my_swords', text: 'Swordsmen', tooltip: false }]);
	});

	it('refuses a missing row or an unchanged key', async () => {
		const data = { table: async (n: string) => TABLES[n], referencing: async () => [], loc: () => undefined };
		await assert.rejects(planClone('main_units_tables', 'nope', 'x', data), /has no row "nope"/);
		await assert.rejects(planClone('main_units_tables', 'emp_swords', 'emp_swords', data), /must differ/);
	});
});

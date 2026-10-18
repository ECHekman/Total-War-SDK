import * as assert from 'node:assert/strict';

import type { DbField } from '../../src/db/effective';
import { CheckContext, checkLocRows, checkModTable, guessLocalisedColumns } from '../../src/db/modChecks';

const FIELDS: DbField[] = [
	{ name: 'key', fieldType: 'StringU8', isKey: true },
	{ name: 'armour', fieldType: 'StringU8', isKey: false, refTable: 'unit_armour_types_tables', refColumn: 'key' },
	{ name: 'cost', fieldType: 'I32', isKey: false },
];

function ctx(over: Partial<CheckContext> = {}): CheckContext {
	return {
		keys: (t) => (t === 'unit_armour_types_tables' ? new Set(['plate', 'none']) : t === 'land_units_tables' ? new Set(['old']) : undefined),
		gameVersion: () => 5,
		inGame: (_t, k) => k === 'old',
		localisedColumns: () => ['onscreen_name'],
		hasLoc: (k) => k === 'land_units_onscreen_name_mine',
		...over,
	};
}

describe('mod checks', () => {
	it('accepts a correct table', () => {
		const problems = checkModTable({ table: 'land_units_tables', fileName: '!!!m', version: 5, fields: FIELDS, rows: [['mine', 'plate', 1], ['old', '', 2]] }, ctx());
		assert.deepEqual(problems, []);
	});

	it('finds outdated versions, broken references, repeated keys and missing loc', () => {
		const problems = checkModTable({
			table: 'land_units_tables', fileName: '!!!m', version: 4, fields: FIELDS,
			rows: [['mine', 'plate', 1], ['new_unit', 'platee', 1], ['mine', 'none', 3]],
		}, ctx());
		assert.deepEqual(problems.map((p) => [p.code, p.row]), [
			['outdated-version', undefined],
			['broken-reference', 1],
			['missing-loc', 1],
			['duplicate-key', 2],
		]);
		assert.match(problems[1].message, /armour "platee" is not a key of unit_armour_types_tables/);
		assert.match(problems[2].message, /land_units_onscreen_name_new_unit/);
	});

	it('skips references to tables the game lacks and warns about unknown tables', () => {
		const problems = checkModTable({ table: 'nope_tables', fileName: 'x', version: 1, fields: FIELDS, rows: [['a', 'whatever', 1]] },
			ctx({ keys: () => undefined, gameVersion: () => undefined }));
		assert.deepEqual(problems.map((p) => p.code), ['unknown-table', 'missing-loc']);
	});

	it('limits the problems listed per kind', () => {
		const rows = Array.from({ length: 80 }, (_, i) => [`k${i}`, 'bad', 0]);
		const problems = checkModTable({ table: 'land_units_tables', fileName: 'x', version: 5, fields: FIELDS, rows },
			ctx({ localisedColumns: () => [] }));
		assert.equal(problems.filter((p) => p.code === 'broken-reference' && p.severity === 'error').length, 50);
		assert.match(problems.at(-1)!.message, /30 more broken reference/);
	});

	it('finds repeated loc keys', () => {
		assert.deepEqual(checkLocRows([['a', 'x', false], ['b', 'y', false], ['a', 'z', true]]).map((p) => p.row), [2]);
	});

	it('guesses which columns are localised', () => {
		const loc = new Set(['land_units_onscreen_name_a', 'land_units_onscreen_name_b', 'land_units_short_description_text_a']);
		assert.deepEqual(guessLocalisedColumns('land_units_tables', [{ name: 'short_description_text', fieldType: 'StringU8', isKey: false }], ['a', 'b'], (k) => loc.has(k)), ['onscreen_name']);
	});
});

import * as assert from 'node:assert/strict';

import { dbRefRulesFor, dbRefValueAt, findDbRefs } from '../../src/assets/dbRefs';

describe('DB keys in JSON views', () => {
	const rules = dbRefRulesFor('/c:/mod/pack/ui/portraits/portholes/portrait_settings_my_mod.bin.json');

	it('applies to portrait settings only', () => {
		assert.equal(rules.length, 2);
		assert.deepEqual(dbRefRulesFor('/c:/x/animations/database/battle/bin/hu1.bin.json'), []);
	});

	it('finds art set ids and variant file names', () => {
		const json = '{\n  "entries": [\n    {\n      "id": "wh2_art_set_x",\n      "variants": [{ "filename": "var_x", "file_diffuse": "ui/x.png" }, { "filename": "" }]\n    }\n  ]\n}';
		const refs = findDbRefs(json, rules);
		assert.deepEqual(refs.map((r) => [r.rule.table, r.value]), [['campaign_character_art_sets_tables', 'wh2_art_set_x'], ['variants_tables', 'var_x']]);
		for (const r of refs) {
			assert.equal(json.slice(r.start, r.end), r.value);
		}
	});

	it('finds the value being typed', () => {
		assert.deepEqual(dbRefValueAt('      "id": "wh2_ar', 19, rules)?.prefix, 'wh2_ar');
		assert.equal(dbRefValueAt('      "id": "wh2_ar', 19, rules)?.start, 13);
		assert.equal(dbRefValueAt('      "fov": 30', 15, rules), undefined);
	});
});

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DECODED_PATTERNS, isDbTablePath, packPathFromDiskPath, TEXT_SUFFIXES, textLanguage } from '../../src/fileTypes';

/** Suffixes VS Code itself maps to the language we want (or a close one), so package.json leaves them out. */
const BUILT_IN = new Set(['.bat', '.code-snippets', '.code-workspace', '.css', '.csv', '.fbx', '.fx', '.h', '.hlsl', '.htm', '.html',
	'.inl', '.js', '.json', '.log', '.lua', '.md', '.py', '.sql', '.tsv', '.txt', '.xml', '.yml', '.yaml']);

describe('file types', () => {
	it('finds the language of text files by suffix, longest first', () => {
		assert.equal(textLanguage('variantmeshes/variantmeshdefinitions/wh3_main_kho_bloodletter.variantmeshdefinition'), 'xml');
		assert.equal(textLanguage('Foo.XML.MATERIAL'), 'xml');
		assert.equal(textLanguage('script/campaign/mod/x.lua'), 'lua');
		assert.equal(textLanguage('shaders/x.fx_fragment'), 'hlsl');
		assert.equal(textLanguage('db/units_tables/data__'), undefined);
		assert.equal(textLanguage('text/db/units.loc'), undefined);
		assert.equal(textLanguage('ui/skins/default/x.png'), undefined);
	});

	it('package.json gives every other suffix its language', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as
			{ contributes: { languages: { id: string; extensions: string[] }[] } };
		const contributed = new Map(pkg.contributes.languages.flatMap((l) => l.extensions.map((e) => [e, l.id] as const)));
		for (const [suffix, language] of TEXT_SUFFIXES) {
			if (!BUILT_IN.has(suffix)) {
				assert.equal(contributed.get(suffix), language, suffix);
			}
		}
		for (const [suffix, language] of contributed) {
			assert.equal(textLanguage(`x${suffix}`), language, suffix);
		}
	});

	it('package.json opens the structured binary files as JSON', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as
			{ contributes: { customEditors: { viewType: string; selector: { filenamePattern: string }[] }[] } };
		const editor = pkg.contributes.customEditors.find((e) => e.viewType === 'totalwar.decodedEditor');
		assert.deepEqual(editor?.selector.map((s) => s.filenamePattern), DECODED_PATTERNS);
	});

	it('finds the pack path of files outside the pack folder', () => {
		assert.equal(packPathFromDiskPath('C:/mods/x/Animations/database/battle/bin/hu1_tables.bin'), 'Animations/database/battle/bin/hu1_tables.bin');
		assert.equal(packPathFromDiskPath('C:/Downloads/portrait_settings_x.bin'), 'portrait_settings_x.bin');
	});

	it('recognises DB table fragments', () => {
		assert.ok(isDbTablePath('db/units_tables/data__'));
		assert.ok(isDbTablePath('DB\\land_units_tables\\!!my_mod'));
		assert.ok(!isDbTablePath('db/units_tables'));
		assert.ok(!isDbTablePath('db/units_tables/sub/x'));
	});
});

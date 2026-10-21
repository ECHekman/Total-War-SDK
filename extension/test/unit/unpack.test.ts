import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RpfmModule } from '../../src/rpfm';
import { diskForms, existingFiles, isSafePackPath, unpackPack } from '../../src/unpack';

const native = path.resolve(__dirname, '../../../../rpfm-interface/rpfm-interface.win32-x64-msvc.node');
const schemaFile = path.resolve(__dirname, '../../../schemas/schema_wh3.ron');
const examplePack = path.resolve(__dirname, '../../../../example/pack');

describe('unpacking packs', () => {
	it('refuses paths that leave the folder', () => {
		assert.ok(isSafePackPath('script/campaign/mod/x.lua'));
		for (const bad of ['../x.lua', 'script/../../x', 'C:/x', '/x', 'a//b', 'a/./b']) {
			assert.ok(!isSafePackPath(bad), bad);
		}
	});

	it('knows both forms of DB tables and loc files', () => {
		assert.deepEqual(diskForms('P', 'db/units_tables/x').map((f) => path.basename(f)), ['x', 'x.tsv']);
		assert.deepEqual(diskForms('P', 'text/db/x.loc').map((f) => path.basename(f)), ['x.loc', 'x.loc.tsv']);
		assert.deepEqual(diskForms('P', 'script/x.lua').map((f) => path.basename(f)), ['x.lua']);
	});

	describe('with the native module', () => {
		let lib: RpfmModule;
		let dir: string;
		let pack: string;
		before(function () {
			if (!fs.existsSync(native)) {
				this.skip();
			}
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			lib = require(native) as RpfmModule;
		});
		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twunpack-'));
			const src = path.join(dir, 'src');
			for (const rel of ['script/campaign/mod/example_mod.lua', 'db/unit_armour_types_tables/!!!example_mod', 'text/db/example_mod.loc',
				'ui/portraits/portholes/portrait_settings_example_mod.bin']) {
				fs.mkdirSync(path.join(src, path.dirname(rel)), { recursive: true });
				fs.copyFileSync(path.join(examplePack, rel), path.join(src, rel));
			}
			pack = path.join(dir, 'example_mod.pack');
			lib.createPackFromFolder(src, pack, 'warhammer_3');
		});
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

		it('unpacks every file byte for byte', () => {
			const out = path.join(dir, 'out');
			const r = unpackPack(lib, pack, out, { game: 'warhammer_3', conflict: 'overwrite', tableFormat: 'binary' });
			assert.equal(r.written, 4);
			for (const rel of ['script/campaign/mod/example_mod.lua', 'db/unit_armour_types_tables/!!!example_mod', 'ui/portraits/portholes/portrait_settings_example_mod.bin']) {
				assert.deepEqual(fs.readFileSync(path.join(out, rel)), fs.readFileSync(path.join(dir, 'src', rel)), rel);
			}
		});

		it('keeps or replaces the files the folder already has', () => {
			const out = path.join(dir, 'out');
			const lua = path.join(out, 'script', 'campaign', 'mod', 'example_mod.lua');
			fs.mkdirSync(path.dirname(lua), { recursive: true });
			fs.writeFileSync(lua, 'mine');
			fs.mkdirSync(path.join(out, 'text', 'db'), { recursive: true });
			fs.writeFileSync(path.join(out, 'text', 'db', 'example_mod.loc.tsv'), 'mine');
			assert.deepEqual(existingFiles(lib, pack, out, 'warhammer_3').sort(), ['script/campaign/mod/example_mod.lua', 'text/db/example_mod.loc']);

			const kept = unpackPack(lib, pack, out, { game: 'warhammer_3', conflict: 'skip', tableFormat: 'binary' });
			assert.deepEqual([kept.written, kept.skipped], [2, 2]);
			assert.equal(fs.readFileSync(lua, 'utf8'), 'mine');

			unpackPack(lib, pack, out, { game: 'warhammer_3', conflict: 'overwrite', tableFormat: 'binary' });
			assert.notEqual(fs.readFileSync(lua, 'utf8'), 'mine');
			// The TSV form of the loc file made way for the binary one.
			assert.ok(!fs.existsSync(path.join(out, 'text', 'db', 'example_mod.loc.tsv')));
			assert.ok(fs.existsSync(path.join(out, 'text', 'db', 'example_mod.loc')));
		});

		it('writes DB tables and loc files as TSV when asked', function () {
			if (!fs.existsSync(schemaFile)) {
				this.skip();
			}
			const out = path.join(dir, 'out');
			const r = unpackPack(lib, pack, out, { game: 'warhammer_3', conflict: 'overwrite', tableFormat: 'tsv', schema: lib.loadSchema(schemaFile) });
			assert.deepEqual(r.keptBinary, []);
			assert.match(fs.readFileSync(path.join(out, 'db', 'unit_armour_types_tables', '!!!example_mod.tsv'), 'utf8'), /#unit_armour_types_tables;/);
			assert.match(fs.readFileSync(path.join(out, 'text', 'db', 'example_mod.loc.tsv'), 'utf8'), /#Loc;/);
			// Packing the TSV again gives the same rows (TSV keeps no GUID).
			const schema = lib.loadSchema(schemaFile);
			const again = path.join(dir, 'again.pack');
			lib.createPackFromFolder(out, again, 'warhammer_3', schema);
			const table = 'db/unit_armour_types_tables/!!!example_mod';
			const a = lib.openPacks([pack], 'warhammer_3').decodeDb(table, schema)!;
			const b = lib.openPacks([again], 'warhammer_3').decodeDb(table, schema)!;
			assert.deepEqual([b.version, b.rows], [a.version, a.rows]);
			assert.deepEqual(lib.openPacks([again], 'warhammer_3').decodeLoc('text/db/example_mod.loc'), lib.openPacks([pack], 'warhammer_3').decodeLoc('text/db/example_mod.loc'));
		});
	});
});

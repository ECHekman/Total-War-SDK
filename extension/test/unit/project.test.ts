import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createProjectFiles, isValidModName, modNameForPack, TEMPLATE_EXECUTABLE, TEMPLATE_MOD_NAME } from '../../src/createProject';
import { listSaveGames } from '../../src/saves';

const exampleDir = path.resolve(__dirname, '..', '..', '..', '..', 'example');

describe('example project', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-project-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('uses the template name and path the generator replaces', () => {
		const launch = fs.readFileSync(path.join(exampleDir, '.vscode', 'launch.json'), 'utf8');
		assert.ok(launch.includes(TEMPLATE_EXECUTABLE));
		assert.ok(launch.includes(TEMPLATE_MOD_NAME));
		assert.ok(fs.existsSync(path.join(exampleDir, `${TEMPLATE_MOD_NAME}.code-workspace`)));
	});

	it('creates a renamed copy pointing at the given game', () => {
		const target = path.join(dir, 'karls_mod');
		const ws = createProjectFiles(exampleDir, target, 'karls_mod', 'D:\\Games\\WH3\\Warhammer3.exe');
		assert.equal(ws, path.join(target, 'karls_mod.code-workspace'));
		assert.ok(fs.existsSync(ws));
		assert.ok(fs.existsSync(path.join(target, 'pack', 'script', 'campaign', 'mod', 'karls_mod.lua')));
		const launch = fs.readFileSync(path.join(target, '.vscode', 'launch.json'), 'utf8');
		const tasks = fs.readFileSync(path.join(target, '.vscode', 'tasks.json'), 'utf8');
		for (const text of [launch, tasks]) {
			assert.ok(text.includes('D:/Games/WH3/Warhammer3.exe'));
			assert.ok(!text.includes(TEMPLATE_MOD_NAME));
			assert.ok(text.includes('karls_mod_mods.txt'));
		}
		assert.match(fs.readFileSync(path.join(target, 'pack', 'script', 'campaign', 'mod', 'karls_mod.lua'), 'utf8'),
			/local mod_name = "karls_mod"/);
	});

	it('copies binary files byte for byte and can leave out the example mod files', () => {
		const template = path.join(dir, 'template');
		const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, ...Buffer.from('example_mod'), 0xc3]);
		fs.mkdirSync(path.join(template, 'pack', 'ui'), { recursive: true });
		fs.writeFileSync(path.join(template, 'pack', 'ui', 'portrait_settings_example_mod.bin'), bytes);
		fs.writeFileSync(path.join(template, 'example_mod.code-workspace'), '{"folders": [{"path": "."}], "x": "example_mod"}');
		const target = path.join(dir, 'new');
		createProjectFiles(template, target, 'karls_mod', 'C:/x.exe');
		assert.deepEqual(fs.readFileSync(path.join(target, 'pack', 'ui', 'portrait_settings_karls_mod.bin')), bytes);
		assert.match(fs.readFileSync(path.join(target, 'karls_mod.code-workspace'), 'utf8'), /"x": "karls_mod"/);

		const empty = path.join(dir, 'empty');
		createProjectFiles(template, empty, 'karls_mod', 'C:/x.exe', { packContents: false });
		assert.deepEqual(fs.readdirSync(path.join(empty, 'pack')), []);
		assert.ok(fs.existsSync(path.join(empty, 'karls_mod.code-workspace')));
	});

	it('names a project after its pack', () => {
		assert.equal(modNameForPack('C:/data/!!my_mod.pack'), 'my_mod');
		assert.equal(modNameForPack('D:/x/Cool Mod (v2).PACK'), 'Cool_Mod_v2');
		assert.equal(modNameForPack('---.pack'), 'my_mod');
	});

	it('refuses bad names and non-empty folders', () => {
		assert.equal(isValidModName('my mod'), false);
		assert.equal(isValidModName('my_mod2'), true);
		fs.writeFileSync(path.join(dir, 'x.txt'), '');
		assert.throws(() => createProjectFiles(exampleDir, dir, 'my_mod', 'C:/x.exe'), /not empty/);
	});

	it('lists campaign saves newest first', () => {
		fs.writeFileSync(path.join(dir, 'old.save'), '');
		fs.writeFileSync(path.join(dir, 'notes.txt'), '');
		fs.writeFileSync(path.join(dir, 'new.save'), '');
		fs.utimesSync(path.join(dir, 'old.save'), new Date(2020, 1, 1), new Date(2020, 1, 1));
		assert.deepEqual(listSaveGames(dir).map((s) => s.name), ['new.save', 'old.save']);
		assert.deepEqual(listSaveGames(path.join(dir, 'missing')), []);
	});
});

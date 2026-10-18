import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createProjectFiles, isValidModName, TEMPLATE_EXECUTABLE, TEMPLATE_MOD_NAME } from '../../src/createProject';
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

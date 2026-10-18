import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { gameByKey, gameForExecutable } from '../../src/games';
import { addModToList, parseModList, resolveModPacks } from '../../src/modList';
import { parseLibraryFolders } from '../../src/steam';

describe('mod list', () => {
	const text = [
		'add_working_directory "C:/Steam/steamapps/workshop/content/1142710/2864762290";',
		'add_working_directory C:/mods/other ;',
		'mod "tw_lua_debugger.pack";',
		'mod my_mod.pack;',
		'',
		'game_startup_mode campaign_load "x.save";',
	].join('\r\n');

	it('parses working directories and mods', () => {
		assert.deepEqual(parseModList(text), {
			workingDirectories: ['C:/Steam/steamapps/workshop/content/1142710/2864762290', 'C:/mods/other'],
			mods: ['tw_lua_debugger.pack', 'my_mod.pack'],
		});
	});

	it('resolves packs from working directories and the data folder', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-mods-'));
		try {
			fs.mkdirSync(path.join(root, 'ws'));
			fs.mkdirSync(path.join(root, 'game', 'data'), { recursive: true });
			fs.writeFileSync(path.join(root, 'ws', 'a.pack'), '');
			fs.writeFileSync(path.join(root, 'game', 'data', 'b.pack'), '');
			const packs = resolveModPacks({ workingDirectories: [path.join(root, 'ws')], mods: ['b.pack', 'missing.pack', 'a.pack'] },
				path.join(root, 'game'));
			assert.deepEqual(packs, [path.join(root, 'game', 'data', 'b.pack'), path.join(root, 'ws', 'a.pack')]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('adds a mod once', () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-mods-')), 'used_mods.txt');
		try {
			fs.writeFileSync(file, 'mod "a.pack";');
			assert.equal(addModToList(file, 'B.pack'), true);
			assert.equal(addModToList(file, 'b.pack'), false);
			assert.deepEqual(parseModList(fs.readFileSync(file, 'utf8')).mods, ['a.pack', 'B.pack']);
		} finally {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		}
	});
});

describe('steam and games', () => {
	it('parses libraryfolders.vdf', () => {
		const vdf = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`;
		assert.deepEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
	});

	it('recognises games by executable', () => {
		assert.equal(gameForExecutable('C:\\x\\Warhammer3.exe')?.key, 'warhammer_3');
		assert.equal(gameForExecutable('/x/three_kingdoms.exe')?.key, 'three_kingdoms');
		assert.equal(gameForExecutable('C:/x/other.exe'), undefined);
		assert.equal(gameByKey('nope').key, 'warhammer_3');
	});
});

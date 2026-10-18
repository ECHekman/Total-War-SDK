import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveDependencies, steamappsFolder, workshopPack } from '../../src/dependencies';
import { gameByKey } from '../../src/games';
import { byPriority, inListOrder, parseModList, writeModList } from '../../src/modList';
import { WORKSHOP_CACHE_TTL, WorkshopClient, WorkshopItem, cachedWorkshopClient, workshopClosure } from '../../src/workshop';

describe('mod dependencies', () => {
	let root: string;
	let steamapps: string;
	let exe: string;
	let workspace: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-deps-'));
		steamapps = path.join(root, 'steamapps');
		const gameDir = path.join(steamapps, 'common', 'Total War WARHAMMER III');
		fs.mkdirSync(path.join(gameDir, 'data'), { recursive: true });
		exe = path.join(gameDir, 'Warhammer3.exe');
		fs.writeFileSync(exe, '');
		fs.writeFileSync(path.join(gameDir, 'data', 'local_dep.pack'), '');
		const item = path.join(steamapps, 'workshop', 'content', '1142710', '2789857593');
		fs.mkdirSync(item, { recursive: true });
		fs.writeFileSync(path.join(item, 'debug_activator.pack'), '');
		fs.writeFileSync(path.join(item, 'debug_activator.png'), '');
		workspace = path.join(root, 'my_mod');
		fs.mkdirSync(path.join(root, 'other_mod', 'pack'), { recursive: true });
		fs.mkdirSync(workspace);
		fs.mkdirSync(path.join(root, 'packs'));
		fs.writeFileSync(path.join(root, 'packs', 'loose.pack'), '');
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const ctx = () => ({ workspaceDir: workspace, executable: exe, game: gameByKey('warhammer_3') });

	it('finds the Steam library of the game', () => {
		assert.equal(steamappsFolder(exe), steamapps);
		assert.equal(steamappsFolder(path.join(root, 'elsewhere', 'Warhammer3.exe')), undefined);
		assert.equal(workshopPack(steamapps, 1142710, '2789857593'),
			path.join(steamapps, 'workshop', 'content', '1142710', '2789857593', 'debug_activator.pack'));
	});

	it('resolves Workshop items, data packs, pack paths and local projects', () => {
		const deps = resolveDependencies([
			'2789857593',
			'local_dep.pack',
			'../packs/loose.pack',
			{ folder: '../other_mod/pack', modName: 'other_mod' },
		], ctx());
		assert.deepEqual(deps.map((d) => d.pack), ['debug_activator.pack', 'local_dep.pack', 'loose.pack', 'other_mod.pack']);
		assert.equal(deps[0].workingDirectory, path.join(steamapps, 'workshop', 'content', '1142710', '2789857593'));
		assert.equal(deps[1].workingDirectory, undefined);
		assert.equal(deps[2].workingDirectory, path.join(root, 'packs'));
		assert.equal(deps[3].packFrom, path.join(root, 'other_mod', 'pack'));
	});

	it('explains what is missing', () => {
		assert.throws(() => resolveDependencies(['123'], ctx()), /not downloaded.*id=123/);
		assert.throws(() => resolveDependencies(['nope.pack'], ctx()), /not in .*data/);
		assert.throws(() => resolveDependencies(['../packs/nope.pack'], ctx()), /does not exist/);
		assert.throws(() => resolveDependencies([{ folder: '../missing', modName: 'x.pack' }], ctx()), /does not exist/);
		assert.throws(() => resolveDependencies(['some mod'], ctx()), /Cannot understand/);
	});

	it('writes a project mod list in load order and refuses used_mods.txt', () => {
		const file = path.join(root, 'my_mod_mods.txt');
		const highFirst = ['my_mod.pack', 'tw_lua_debugger.pack', 'debug_activator.pack'];
		writeModList(file, ['D:\\workshop\\2789857593', 'D:\\workshop\\2789857593'], highFirst);
		const text = fs.readFileSync(file, 'utf8');
		assert.ok(text.startsWith('add_working_directory "D:/workshop/2789857593";\r\n'));
		assert.equal(text.match(/add_working_directory/g)?.length, 1);
		assert.deepEqual(parseModList(text).mods, inListOrder(highFirst));
		assert.throws(() => writeModList(path.join(root, 'used_mods.txt'), [], highFirst), /Refusing/);
	});

	it('orders packs by the game\'s mod priority', () => {
		const list = ['y.pack', 'a.pack', 'z.pack', 'b.pack'];
		const ordered = byPriority(list, (p) => p);
		assert.equal(ordered.length, 4);
		assert.deepEqual([...ordered].sort(), [...list].sort());
		// inListOrder is the inverse mapping for writing a mod list
		assert.deepEqual(byPriority(inListOrder(ordered), (p) => p).slice(0, 1), ordered.slice(0, 1));
	});
});

describe('Workshop dependencies', () => {
	const steam = (items: Record<string, { title: string; children: string[] }>) => {
		const asked: string[][] = [];
		const client: WorkshopClient = {
			info: async (ids) => {
				asked.push(ids);
				return ids.filter((id) => items[id]).map((id) => ({ id, ...items[id] }));
			},
			subscribe: async () => [],
		};
		return { client, asked };
	};

	it('lists required items after the declared ones, each once', async () => {
		const { client, asked } = steam({
			'1': { title: 'A', children: ['3', '2'] },
			'2': { title: 'B', children: ['4'] },
			'3': { title: 'C', children: ['1'] },
			'4': { title: 'D', children: [] },
		});
		const { items, unknown } = await workshopClosure(['1', '2', '9'], client);
		assert.deepEqual(items.map((i) => i.id), ['1', '2', '3', '4']);
		assert.deepEqual(unknown, ['9']);
		assert.deepEqual(asked, [['1', '2', '9'], ['3', '4']]);
	});

	it('answers from the cache while it is fresh', async () => {
		const { client, asked } = steam({ '1': { title: 'A', children: [] }, '2': { title: 'B', children: [] } });
		const store = new Map<string, WorkshopItem & { at: number }>();
		const cache = { get: (id: string) => store.get(id), set: (i: WorkshopItem) => store.set(i.id, { ...i, at: 1000 }) };
		await cachedWorkshopClient(client, cache, 1000).info(['1']);
		const again = await cachedWorkshopClient(client, cache, 2000).info(['1', '2']);
		assert.deepEqual(again.map((i) => i.id).sort(), ['1', '2']);
		assert.deepEqual(asked, [['1'], ['2']]);
		await cachedWorkshopClient(client, cache, 1000 + WORKSHOP_CACHE_TTL + 1).info(['1']);
		assert.deepEqual(asked.at(-1), ['1']);
	});
});

import * as path from 'node:path';
import * as vscode from 'vscode';

import { DbSchema, PackHolder, rpfm } from '../rpfm';
import { LiveSourceFS } from '../SourceFileSystemProvider';
import {
	EffectiveRow, EffectiveTable, Fragment, fragmentName, GameDatabase, mergeFragments, PackFiles, selectFragments, tableNames,
} from './effective';
import { downloadSchema, resolveSchema, SchemaLocations, SchemaOrigin } from './schema';

/** Decoded tables kept in memory. */
const CACHE_SIZE = 40;

interface LoadedSchema {
	game: string;
	schema: DbSchema;
	file: string;
	origin: SchemaOrigin;
}

interface Loaded {
	game: string;
	schema: LoadedSchema;
	sources: PackFiles<PackHolder>[];
	tables: string[];
}

/** A table's decoded fragments (load order) and their merge. */
interface Decoded {
	fragments: Fragment[];
	errors: string[];
	table: EffectiveTable;
}

/**
 * The effective DB tables of the game and the mods in the mod list, using the
 * packs opened by the virtual source files (same install, mod list and order).
 */
/** A loc entry as the game sees it. */
export interface LocEntry {
	text: string;
	tooltip: boolean;
	/** Mod pack (or `@basegame`) and file it comes from. */
	pack: string;
	file: string;
}

export class DbService implements GameDatabase, vscode.Disposable {
	private loading: Promise<Loaded> | undefined;
	private schemaLoading: { game: string; promise: Promise<LoadedSchema> } | undefined;
	private readonly cache = new Map<string, Decoded>();
	private keyIndex: Promise<Map<string, string[]>> | undefined;
	private locIndex: Promise<Map<string, LocEntry>> | undefined;
	/** The finished key index and its keys sorted, for prefix lookups. */
	private keyIndexReady: { index: Map<string, string[]>; sorted: string[] } | undefined;
	private generation = 0;

	private readonly emitter = new vscode.EventEmitter<void>();
	/** Fired when the packs, mod list or schema changed: tables must be fetched again. */
	readonly onDidChange = this.emitter.event;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly sources: LiveSourceFS, private readonly locations: () => SchemaLocations,
		private readonly log: vscode.OutputChannel) {
		// The source file system reloads its packs when the configuration or mod list changes.
		this.subscription = sources.onDidReload(() => this.invalidate());
	}

	invalidate(): void {
		this.generation++;
		this.loading = undefined;
		this.keyIndex = undefined;
		this.keyIndexReady = undefined;
		this.locIndex = undefined;
		this.cache.clear();
		this.emitter.fire();
	}

	/** Downloads the current schema now (command), then reloads. */
	async updateSchema(): Promise<string> {
		const game = this.sources.game ?? 'warhammer_3';
		const file = await downloadSchema(game, this.locations().downloadDir);
		this.schemaLoading = undefined;
		this.invalidate();
		return file;
	}

	/** Schema file and origin in use, once loaded. */
	async describe(): Promise<string> {
		const l = await this.load();
		return `${path.basename(l.schema.file)} (${l.schema.origin}), ${l.tables.length} tables`;
	}

	/** Game key of the configured game (or the twdev.game setting). */
	get game(): string {
		return this.sources.game ?? vscode.workspace.getConfiguration('twdev').get<string>('game') ?? 'warhammer_3';
	}

	/**
	 * The loc entries (`text/**.loc`) of the game and the mod list: key -> text.
	 * Mods in load order first, then the game; within a pack, files by name.
	 * The first entry with a key wins.
	 */
	loc(): Promise<Map<string, LocEntry>> {
		if (!this.locIndex) {
			const loading = (async () => {
				const started = Date.now();
				const packs = await this.sources.packSources();
				const index = new Map<string, LocEntry>();
				for (const { label, holder } of packs) {
					for (const file of holder.locPaths()) {
						await new Promise((resolve) => setImmediate(resolve));
						let rows;
						try {
							rows = holder.decodeLoc(file) ?? [];
						} catch (e) {
							this.log.appendLine(`Loc: ${(e as Error).message}`);
							continue;
						}
						for (const r of rows) {
							if (!index.has(r.key)) {
								index.set(r.key, { text: r.text, tooltip: r.tooltip, pack: label, file });
							}
						}
					}
				}
				this.log.appendLine(`Loc: ${index.size} entries in ${Date.now() - started} ms.`);
				return index;
			})();
			this.locIndex = loading;
			loading.catch(() => {
				if (this.locIndex === loading) {
					this.locIndex = undefined;
				}
			});
		}
		return this.locIndex;
	}

	/**
	 * The schema for the configured game. Unlike the tables it needs no game
	 * packs, so DB files can be edited without a game install.
	 */
	schema(): Promise<LoadedSchema> {
		const game = this.sources.game ?? vscode.workspace.getConfiguration('twdev').get<string>('game') ?? 'warhammer_3';
		if (this.schemaLoading?.game !== game) {
			const promise = (async () => {
				const found = await resolveSchema(game, this.locations(), (m) => this.log.appendLine(m));
				if (!found) {
					throw new Error(`No DB schema for ${game}. Run "TotalWar: Update DB Schema" or set twdev.dbSchemaPath.`);
				}
				return { game, schema: await rpfm().loadSchemaAsync(found.file), file: found.file, origin: found.origin };
			})();
			this.schemaLoading = { game, promise };
			promise.catch(() => {
				if (this.schemaLoading?.promise === promise) {
					this.schemaLoading = undefined;
				}
			});
		}
		return this.schemaLoading.promise;
	}

	private load(): Promise<Loaded> {
		if (!this.loading) {
			const loading = this.doLoad();
			this.loading = loading;
			// Retry on the next request after a failure (e.g. game not found yet).
			loading.catch(() => {
				if (this.loading === loading) {
					this.loading = undefined;
				}
			});
		}
		return this.loading;
	}

	private async doLoad(): Promise<Loaded> {
		const packs = await this.sources.packSources();
		const game = this.sources.game;
		if (!game || packs.length === 0) {
			throw new Error('No game packs loaded. Start a Total War debug session (or check the "Total War Modding Tools" output).');
		}
		const started = Date.now();
		const schema = await this.schema();
		const sources = packs.map(({ label, holder }) => ({ label, files: holder.dbFiles(), owner: holder }));
		const tables = tableNames(sources);
		this.log.appendLine(`DB: ${tables.length} tables, schema ${path.basename(schema.file)} (${schema.origin}), `
			+ `in ${Date.now() - started} ms.`);
		return { game, schema, sources, tables };
	}

	async tables(): Promise<string[]> {
		return (await this.load()).tables;
	}

	async table(name: string): Promise<EffectiveTable> {
		return (await this.decoded(name)).table;
	}

	/**
	 * The table without the fragments named `fileName` (in any pack): what the
	 * game would use if that file did not exist. For the effect of a file
	 * being edited, whose own packed copy may be out of date.
	 */
	async tableExcluding(name: string, fileName: string): Promise<EffectiveTable> {
		const d = await this.decoded(name);
		const lower = fileName.toLowerCase();
		return mergeFragments(name, d.fragments.filter((f) => fragmentName(f.path).toLowerCase() !== lower), d.errors);
	}

	/** Version of the game's own fragment of a table (`data__`), the one new fragments should use. */
	async gameVersion(name: string): Promise<number | undefined> {
		const d = await this.decoded(name);
		const own = d.fragments.find((f) => fragmentName(f.path).toLowerCase() === 'data__') ?? d.fragments.at(-1);
		return own && own.data.version >= 0 ? own.data.version : undefined;
	}

	private async decoded(name: string): Promise<Decoded> {
		const cached = this.cache.get(name);
		if (cached) {
			// Most recently used last.
			this.cache.delete(name);
			this.cache.set(name, cached);
			return cached;
		}
		const generation = this.generation;
		const decoded = this.decode(await this.load(), name);
		if (generation === this.generation) {
			this.cache.set(name, decoded);
			while (this.cache.size > CACHE_SIZE) {
				this.cache.delete(this.cache.keys().next().value!);
			}
		}
		return decoded;
	}

	private decode(loaded: Loaded, name: string): Decoded {
		const fragments: Fragment[] = [];
		const errors: string[] = [];
		for (const f of selectFragments(loaded.sources, name)) {
			try {
				const data = f.owner!.decodeDb(f.path, loaded.schema.schema);
				if (data) {
					fragments.push({ pack: f.pack, path: f.path, data });
				}
			} catch (e) {
				errors.push(`${f.pack}/${f.path}: ${(e as Error).message}`);
			}
		}
		return { fragments, errors, table: mergeFragments(name, fragments, errors) };
	}

	async row(table: string, key: string): Promise<EffectiveRow | undefined> {
		return (await this.table(table)).byKey.get(key);
	}

	async findKey(key: string): Promise<{ table: string; row: EffectiveRow }[]> {
		const index = await this.currentKeyIndex();
		const found: { table: string; row: EffectiveRow }[] = [];
		for (const table of index.get(key) ?? []) {
			const row = await this.row(table, key);
			if (row) {
				found.push({ table, row });
			}
		}
		return found;
	}

	/**
	 * Keys starting with `prefix`, with their tables, at most `limit`. Builds the
	 * key index first if needed.
	 */
	async keysWithPrefix(prefix: string, limit: number): Promise<{ key: string; tables: string[] }[]> {
		await this.currentKeyIndex();
		const ready = this.keyIndexReady;
		if (!ready) {
			return [];
		}
		const { sorted, index } = ready;
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid] < prefix) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		const out: { key: string; tables: string[] }[] = [];
		for (let i = lo; i < sorted.length && out.length < limit && sorted[i].startsWith(prefix); i++) {
			out.push({ key: sorted[i], tables: index.get(sorted[i])! });
		}
		return out;
	}

	/** Tables that have `key`, if the key index is already built (never builds it). */
	tablesWithKeyIfIndexed(key: string): string[] | undefined {
		return this.keyIndexReady?.index.get(key);
	}

	/** Starts building the key index in the background. */
	prepareKeyIndex(): void {
		this.buildKeyIndex().catch(() => undefined);
	}

	/**
	 * key -> tables, for tables with a single key column. Built once in the
	 * background, a table at a time so the extension host stays responsive.
	 */
	/**
	 * The key index of the current packs. An index being built when the packs
	 * change (a debug session or test configures another install) is thrown
	 * away; then this waits for the one of the new packs.
	 */
	private async currentKeyIndex(): Promise<Map<string, string[]>> {
		for (let attempt = 0; ; attempt++) {
			const generation = this.generation;
			try {
				return await this.buildKeyIndex();
			} catch (e) {
				if (attempt >= 3 || generation === this.generation && !/changed while indexing/.test((e as Error).message)) {
					throw e;
				}
			}
		}
	}

	private buildKeyIndex(): Promise<Map<string, string[]>> {
		if (!this.keyIndex) {
			const generation = this.generation;
			const building = (async () => {
				const loaded = await this.load();
				const started = Date.now();
				const index = new Map<string, string[]>();
				for (const name of loaded.tables) {
					if (generation !== this.generation) {
						throw new Error('The packs changed while indexing.');
					}
					await new Promise((resolve) => setImmediate(resolve));
					const table = (this.cache.get(name) ?? this.decode(loaded, name)).table;
					if (table.columns.filter((c) => c.isKey).length !== 1) {
						continue;
					}
					for (const row of table.rows) {
						const list = index.get(row.key);
						if (list) {
							list.push(name);
						} else {
							index.set(row.key, [name]);
						}
					}
				}
				this.log.appendLine(`DB: indexed ${index.size} keys in ${Date.now() - started} ms.`);
				if (generation === this.generation) {
					this.keyIndexReady = { index, sorted: [...index.keys()].sort() };
				}
				return index;
			})();
			this.keyIndex = building;
			building.catch(() => {
				if (this.keyIndex === building) {
					this.keyIndex = undefined;
				}
			});
		}
		return this.keyIndex;
	}

	dispose(): void {
		this.subscription.dispose();
		this.emitter.dispose();
	}
}

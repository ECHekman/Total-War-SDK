/**
 * RPFM schemas (`schema_<game>.ron`) needed to decode DB tables.
 *
 * Looked up in order: the `totalwar.dbSchemaPath` setting, a copy downloaded from
 * the rpfm-schemas repository into the extension's global storage, and the
 * snapshot shipped in the VSIX (`schemas/`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCHEMA_URL = 'https://raw.githubusercontent.com/Frodo45127/rpfm-schemas/master';
/** A downloaded schema older than this is refreshed (when online) before use. */
export const SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Schema file names in rpfm-schemas (rpfm_lib's `GameInfo::schema_file_name`). */
const SCHEMA_FILES: Record<string, string> = {
	warhammer_3: 'schema_wh3.ron',
	warhammer_2: 'schema_wh2.ron',
	three_kingdoms: 'schema_3k.ron',
	troy: 'schema_troy.ron',
	rome_2: 'schema_rom2.ron',
};

export function schemaFileName(game: string): string {
	return SCHEMA_FILES[game] ?? `schema_${game}.ron`;
}

export interface SchemaLocations {
	/** `totalwar.dbSchemaPath`: a schema file, or a folder with `schema_<game>.ron` files. */
	setting?: string;
	/** Folder schemas are downloaded to. */
	downloadDir: string;
	/** Folder with the schemas shipped in the VSIX. */
	bundledDir: string;
}

export type SchemaOrigin = 'setting' | 'downloaded' | 'bundled';

/** The schema file to use for a game, without downloading. */
export function findSchema(game: string, where: SchemaLocations): { file: string; origin: SchemaOrigin } | undefined {
	const name = schemaFileName(game);
	if (where.setting) {
		const file = isDirectory(where.setting) ? path.join(where.setting, name) : where.setting;
		if (fs.existsSync(file)) {
			return { file, origin: 'setting' };
		}
	}
	for (const [dir, origin] of [[where.downloadDir, 'downloaded'], [where.bundledDir, 'bundled']] as const) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) {
			return { file, origin };
		}
	}
	return undefined;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export type FetchText = (url: string) => Promise<string>;

const defaultFetch: FetchText = async (url) => {
	const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	return res.text();
};

/** Downloads the game's schema into `downloadDir`. Returns the file. */
export async function downloadSchema(game: string, downloadDir: string, fetchText: FetchText = defaultFetch): Promise<string> {
	const name = schemaFileName(game);
	const text = await fetchText(`${SCHEMA_URL}/${name}`);
	if (!/^\s*\(/.test(text)) {
		throw new Error(`${name} does not look like an RPFM schema`);
	}
	fs.mkdirSync(downloadDir, { recursive: true });
	const file = path.join(downloadDir, name);
	// Write next to it and rename, so a schema being read is never half written.
	fs.writeFileSync(`${file}.tmp`, text);
	fs.renameSync(`${file}.tmp`, file);
	return file;
}

/** Whether the downloaded schema is missing or older than SCHEMA_MAX_AGE_MS. */
export function downloadIsStale(game: string, downloadDir: string, now = Date.now()): boolean {
	try {
		return now - fs.statSync(path.join(downloadDir, schemaFileName(game))).mtimeMs > SCHEMA_MAX_AGE_MS;
	} catch {
		return true;
	}
}

/**
 * The schema to use, refreshing the download first when it is stale (unless a
 * setting points elsewhere). A failed download falls back to what is there.
 */
export async function resolveSchema(game: string, where: SchemaLocations, log: (msg: string) => void,
	fetchText?: FetchText): Promise<{ file: string; origin: SchemaOrigin } | undefined> {
	const found = findSchema(game, where);
	if (found?.origin !== 'setting' && downloadIsStale(game, where.downloadDir)) {
		try {
			const file = await downloadSchema(game, where.downloadDir, fetchText);
			log(`DB schema: downloaded ${path.basename(file)}.`);
			return { file, origin: 'downloaded' };
		} catch (e) {
			log(`DB schema: could not download ${schemaFileName(game)} (${(e as Error).message}); `
				+ (found ? `using the ${found.origin} copy.` : 'no schema available.'));
		}
	}
	return found;
}

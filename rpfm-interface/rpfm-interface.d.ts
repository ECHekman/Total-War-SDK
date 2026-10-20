/* Type definitions for the rpfm-interface native module (see src/lib.rs). */

export declare class PackHolder {
	/** Paths (as stored in the pack, `/` separated) of all `.lua` files. */
	luaPaths(): string[];
	/**
	 * The folders of the pack, leaving out files matching any of the `exclude`
	 * globs (relative to the pack root, any case; without a `/` they match a name
	 * in any folder) and the folders left empty. Built on a worker thread.
	 */
	dirTreeAsync(exclude?: string[]): Promise<DirTree>;
	/** Whether the pack has a file at this path (any case). */
	hasFile(path: string): boolean;
	/** Paths (as stored in the pack, `/` separated) of all files, sorted. */
	paths(): string[];
	/** Contents of a text file, or null when the pack has no such file. */
	readText(path: string): string | null;
	/** Raw contents of a file, or null when the pack has no such file. */
	readBytes(path: string): Buffer | null;
	/** The DB table fragments (`db/<table>/<file>`) in the pack. */
	dbFiles(): DbFile[];
	/** Decodes a DB table fragment with a schema. Null when the pack has no such file. */
	decodeDb(path: string, schema: DbSchema): DbTable | null;
	/** Paths of the loc files in the packs, sorted. */
	locPaths(): string[];
	/** Decodes a loc file. Null when the pack has no such file. */
	decodeLoc(path: string): LocRow[] | null;
	/** Decodes a structured binary file to JSON (see `decodeToJson`). Null when the pack has no such file or it has no JSON form. */
	decodeToJson(path: string, game: string): DecodedJson | null;
}

/** The folders of a pack, possibly filtered (see `PackHolder.dirTreeAsync`). */
export declare class DirTree {
	/** The files and folders in a folder (`""` for the root; any case), sorted by name; null when there is no such folder (or nothing in it passes the filter). */
	listDir(dir: string): DirEntry[] | null;
}

/** An entry of a folder in a pack. */
export interface DirEntry {
	name: string;
	isDir: boolean;
}

/** A DB table fragment in a pack. */
export interface DbFile {
	/** Path in the pack: `db/<table>/<file>`. */
	path: string;
	/** Table name, e.g. `land_units_tables`. */
	table: string;
	/** File name of the pack the fragment was read from. */
	pack?: string;
}

/** A column of a decoded DB table. */
export interface DbField {
	name: string;
	fieldType: string;
	isKey: boolean;
	/** Table this column references, if any (its pack folder name, e.g. `unit_armour_types_tables`). */
	refTable?: string;
	refColumn?: string;
	description?: string;
	/** The schema's default for new rows, as text. */
	defaultValue?: string;
	/** Columns of the referenced table that describe a key (e.g. its name). */
	lookup?: string[];
}

export type DbValue = boolean | number | string;

/** A decoded DB table fragment. */
export interface DbTable {
	table: string;
	/** Version of the definition used to decode it. */
	version: number;
	/** GUID in the table's header (empty when it has none). */
	guid: string;
	fields: DbField[];
	rows: DbValue[][];
}

/** An RPFM schema (`schema_<game>.ron`), used to decode DB tables. */
export declare class DbSchema {
	/**
	 * An empty table with the given version of a table's definition, or the newest
	 * one (null when the schema lacks it). The newest is not always the one the
	 * game uses: prefer the version of the game's own fragment.
	 */
	emptyTable(table: string, version?: number): DbTable | null;
	/** Names of the tables the schema has definitions for. */
	tableNames(): string[];
}

/**
 * Encodes rows into a DB table fragment (the bytes of `db/<table>/<file>`) with
 * the schema's definition of that table and version. Rows have one value per
 * column, in the order `decodeDb` returns them.
 */
export declare function encodeDb(schema: DbSchema, table: string, version: number, rows: DbValue[][], game: string, guid?: string): Buffer;

/** Decodes a DB table fragment from its bytes (a loose `db/<table>/<file>` on disk). */
export declare function decodeDbBytes(bytes: Buffer, table: string, schema: DbSchema): DbTable;

/** Loads an RPFM schema file. */
export declare function loadSchema(path: string): DbSchema;
export declare function loadSchemaAsync(path: string): Promise<DbSchema>;

/**
 * Opens and merges packs (lazy loaded). Packs are grouped by type (game packs,
 * then mods, then movie packs; a later group overrides an earlier one); within a
 * group the FIRST pack wins. Without `keepOrder` the packs of a group are sorted
 * by file name first (RPFM's model of the default load order); with it, the
 * given order is the priority order.
 */
export declare function openPacks(paths: string[], game: string, keepOrder?: boolean): PackHolder;
export declare function openPacksAsync(paths: string[], game: string, keepOrder?: boolean): Promise<PackHolder>;

/**
 * Builds a mod pack from a folder. Returns the number of files packed. `.tsv`
 * files go in as the binary DB table / loc file they describe, at their path
 * without `.tsv` (DB tables need `schema`).
 */
export declare function createPackFromFolder(folder: string, outPath: string, game: string, schema?: DbSchema): number;
export declare function createPackFromFolderAsync(folder: string, outPath: string, game: string, schema?: DbSchema): Promise<number>;

/** A row of a localisation (`.loc`) file. */
export interface LocRow {
	key: string;
	text: string;
	tooltip: boolean;
}

/** Decodes a loc file from its bytes. */
export declare function decodeLocBytes(bytes: Buffer): LocRow[];
/** Encodes rows into the bytes of a loc file. */
export declare function encodeLoc(rows: LocRow[]): Buffer;

/** A TSV file (RPFM's format) converted to a binary DB table or loc file. */
export interface TsvImport {
	/** Path in the pack the TSV names in its header. */
	path: string;
	kind: 'db' | 'loc';
	bytes: Buffer;
}

/** Converts a TSV file to the binary file it describes (DB tables need `schema`). */
export declare function tsvToBinary(tsvPath: string, schema: DbSchema | undefined | null, game: string): TsvImport;
/** Writes a binary DB table or loc file (`bytes`, at `packPath` in a pack) as TSV. */
export declare function binaryToTsv(bytes: Buffer, packPath: string, schema: DbSchema, tsvPath: string): void;

/** Paths of the game's own packs (from its manifest), in load order. `gamePath` is the executable folder. */
export declare function caPackPaths(gamePath: string, game: string): string[];

/** Game keys rpfm knows about (warhammer_3, three_kingdoms, ...). */
export declare function supportedGameKeys(): string[];

/** A structured binary file decoded to JSON (see `decodeToJson`). */
export interface DecodedJson {
	/** RPFM's name of the type, e.g. `PortraitSettings`; pass it to `encodeFromJson`. */
	fileType: string;
	/** The decoded file, pretty printed. */
	json: string;
	/**
	 * Whether the file can be saved from its JSON: saving the JSON unchanged
	 * gives back its exact bytes (RPFM reads all of it). Checked per file.
	 */
	editable: boolean;
	/** Why it cannot be saved, when it cannot. */
	readOnlyReason?: string | null;
}

/**
 * Decodes a structured binary file to JSON; the type comes from `packPath`
 * (portrait settings, anim tables, matched combat, atlas, anim fragments,
 * group formations, BMD, vegetation). Null for other types.
 */
export declare function decodeToJson(bytes: Buffer, packPath: string, game: string): DecodedJson | null;
/**
 * Encodes JSON from `decodeToJson` back into the binary file (only for files
 * it says are editable). Throws for invalid JSON and for values that would not
 * read back the same.
 */
export declare function encodeFromJson(json: string, fileType: string, packPath: string, game: string): Buffer;

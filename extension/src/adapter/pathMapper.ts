import * as fs from 'node:fs';
import * as path from 'node:path';

export const VIRTUAL_SCHEME = 'totalwar';

/** Read access to the Lua files inside the game's pack files (the `totalwar:` file system). */
export interface VirtualSources {
	/** Returns the `totalwar:/...` URI string for a pack path key, if the file exists in the packs. */
	uriFor(key: string): string | undefined;
	/** Returns the file contents for a pack path key. */
	read(key: string): string | undefined;
}

export interface PathMapperOptions {
	/** Folder that mirrors the pack layout (contains `script/`). Searched first. */
	sourceFilesPath?: string;
	workspaceFolders?: string[];
	/** Game executable folder; loose `script/` files next to the exe override packs. */
	exeDir?: string;
	virtual?: VirtualSources;
	fileExists?: (p: string) => boolean;
	listDirs?: (p: string) => string[];
}

export interface MappedSource {
	/** Lower-case pack relative key, e.g. `script/campaign/mod/foo.lua`. */
	key: string;
	name: string;
	/** File system path or `totalwar:/` URI. Undefined when only available by reference. */
	path?: string;
}

function toSlashes(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Turns a path into the relative form used by the game (`script/...`), keeping its case.
 * Returns undefined when the path does not contain a `script` folder.
 */
function scriptRelative(p: string): string | undefined {
	const s = toSlashes(p);
	if (/^script\//i.test(s)) {
		return s;
	}
	const m = /\/(script\/.*)$/i.exec(s);
	return m ? m[1] : undefined;
}

export function normalizeKey(p: string): string {
	let s = toSlashes(p).toLowerCase();
	while (s.startsWith('./')) {
		s = s.slice(2);
	}
	return s.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

/** Relative path (original case) for a chunk name reported by Lua's debug.getinfo. */
export function chunkToRelative(chunk: string): string {
	let s = chunk.startsWith('@') ? chunk.slice(1) : chunk;
	s = toSlashes(s);
	while (s.startsWith('./')) {
		s = s.slice(2);
	}
	// The game may load scripts by module path, without the extension.
	if (!/\.[A-Za-z0-9]+$/.test(s)) {
		s += '.lua';
	}
	return scriptRelative(s) ?? s;
}

export function chunkToKey(chunk: string): string {
	return normalizeKey(chunkToRelative(chunk));
}

/** Whether the debug adapter got a `totalwar:` URI (VS Code passes non-file URIs as strings). */
export function isVirtualPath(p: string): boolean {
	return p.toLowerCase().startsWith(VIRTUAL_SCHEME + ':');
}

export class PathMapper {
	private readonly fileExists: (p: string) => boolean;
	private readonly listDirs: (p: string) => string[];
	private readonly cache = new Map<string, MappedSource>();
	private roots: string[] | undefined;

	constructor(private readonly options: PathMapperOptions) {
		this.fileExists = options.fileExists ?? ((p) => {
			try {
				return fs.statSync(p).isFile();
			} catch {
				return false;
			}
		});
		this.listDirs = options.listDirs ?? ((p) => {
			try {
				return fs.readdirSync(p, { withFileTypes: true })
					.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
					.map((d) => path.join(p, d.name));
			} catch {
				return [];
			}
		});
	}

	/** Maps a path VS Code gave us (file path or totalwar URI) to the key used for breakpoints. */
	editorPathToKey(p: string): string {
		if (isVirtualPath(p)) {
			let rest = p.slice(VIRTUAL_SCHEME.length + 1);
			try {
				rest = decodeURIComponent(rest);
			} catch {
				// keep as is
			}
			// totalwar:/@basegame/<path> and totalwar:/@mods/<pack>/<path>: the path inside the pack.
			return normalizeKey(rest.replace(/^\/+/, '')).replace(/^@basegame\//, '').replace(/^@mods\/[^/]+\//, '');
		}
		const rel = scriptRelative(p);
		if (rel) {
			return normalizeKey(rel);
		}
		for (const root of this.explicitRoots()) {
			const r = path.relative(root, p);
			if (r && !r.startsWith('..') && !path.isAbsolute(r)) {
				return normalizeKey(r);
			}
		}
		return normalizeKey(p);
	}

	/** Maps a Lua chunk name to something VS Code can open. */
	chunkToSource(chunk: string): MappedSource {
		const cached = this.cache.get(chunk);
		if (cached) {
			return cached;
		}
		const rel = chunkToRelative(chunk);
		const key = normalizeKey(rel);
		const name = path.posix.basename(rel);
		let result: MappedSource | undefined;

		if (path.isAbsolute(rel) && this.fileExists(rel)) {
			result = { key, name, path: path.normalize(rel) };
		}
		if (!result) {
			for (const root of this.searchRoots()) {
				const candidate = path.join(root, rel);
				if (this.fileExists(candidate)) {
					result = { key, name, path: candidate };
					break;
				}
			}
		}
		if (!result) {
			const uri = this.options.virtual?.uriFor(key);
			result = { key, name, path: uri };
		}
		this.cache.set(chunk, result);
		return result;
	}

	readVirtual(key: string): string | undefined {
		return this.options.virtual?.read(key);
	}

	clearCache(): void {
		this.cache.clear();
		this.roots = undefined;
	}

	private explicitRoots(): string[] {
		const roots: string[] = [];
		if (this.options.sourceFilesPath) {
			roots.push(this.options.sourceFilesPath);
		}
		roots.push(...(this.options.workspaceFolders ?? []));
		return roots;
	}

	/**
	 * Folders that may contain a `script/` tree: the explicit source folder, the
	 * workspace folders and their direct sub folders (e.g. `<workspace>/pack`),
	 * and finally loose files next to the game executable.
	 */
	private searchRoots(): string[] {
		if (!this.roots) {
			const roots: string[] = [];
			if (this.options.sourceFilesPath) {
				roots.push(this.options.sourceFilesPath);
			}
			for (const ws of this.options.workspaceFolders ?? []) {
				roots.push(ws, ...this.listDirs(ws));
			}
			if (this.options.exeDir) {
				roots.push(this.options.exeDir, path.join(this.options.exeDir, 'data'));
			}
			this.roots = roots;
		}
		return this.roots;
	}
}

import * as path from 'node:path';
import * as vscode from 'vscode';

import { VIRTUAL_SCHEME } from '../adapter/pathMapper';
import { packPathFromDiskPath } from '../fileTypes';
import { DEFAULT_GAME } from '../games';
import { modPackFolder } from '../modProject';
import { rpfm } from '../rpfm';
import { BASEGAME_FOLDER, LiveSourceFS, MODS_FOLDER } from '../SourceFileSystemProvider';

export const DECODED_SCHEME = 'totalwar-decoded';

interface Decoded {
	fileType: string;
	json: string;
	/** Whether saving the JSON as shown gives back the file's exact bytes (checked per file). */
	editable: boolean;
	readOnlyReason?: string | null;
	packPath: string;
}

/**
 * Writable `totalwar-decoded:` file system: a binary file (on disk or in the
 * `totalwar:` virtual files) as the JSON RPFM decodes it to. Saving encodes the
 * JSON and writes the binary file; the JSON is never stored. Read only for
 * the virtual files and for a file that saving its JSON unchanged would not
 * give back byte for byte (checked when it is opened; see `readOnlyReason`).
 *
 * URI: the source's path plus `.json` (so JSON schemas match it by name), with
 * the source URI in the query.
 */
export class DecodedFileSystemProvider implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	private readonly cache = new Map<string, { mtime: number; decoded: Decoded }>();

	constructor(private readonly sources: LiveSourceFS) {}

	static uriFor(source: vscode.Uri): vscode.Uri {
		return vscode.Uri.from({ scheme: DECODED_SCHEME, path: `${source.path}.json`, query: source.toString() });
	}

	static sourceOf(uri: vscode.Uri): vscode.Uri {
		return vscode.Uri.parse(uri.query);
	}

	/** Decodes the source (cached until it changes); throws when it has no JSON form. */
	async decode(source: vscode.Uri): Promise<Decoded> {
		const stat = await vscode.workspace.fs.stat(source);
		const hit = this.cache.get(source.toString());
		if (hit && hit.mtime === stat.mtime && stat.mtime !== 0) {
			return hit.decoded;
		}
		const packPath = packPathOf(source);
		const bytes = await vscode.workspace.fs.readFile(source);
		const result = rpfm().decodeToJson(Buffer.from(bytes), packPath, this.game());
		if (!result) {
			throw new Error(`${packPath} has no JSON form.`);
		}
		const decoded: Decoded = { ...result, packPath };
		this.cache.set(source.toString(), { mtime: stat.mtime, decoded });
		return decoded;
	}

	private game(): string {
		return this.sources.game ?? vscode.workspace.getConfiguration('totalwar').get<string>('game') ?? DEFAULT_GAME;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const source = DecodedFileSystemProvider.sourceOf(uri);
		const stat = await vscode.workspace.fs.stat(source);
		const decoded = await this.decode(source).catch(() => undefined);
		const writable = vscode.workspace.fs.isWritableFileSystem(source.scheme) !== false && decoded?.editable === true;
		return {
			type: vscode.FileType.File,
			ctime: stat.ctime,
			mtime: stat.mtime,
			size: decoded ? Buffer.byteLength(decoded.json) : 0,
			permissions: writable ? undefined : vscode.FilePermission.Readonly,
		};
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		try {
			return new TextEncoder().encode((await this.decode(DecodedFileSystemProvider.sourceOf(uri))).json);
		} catch (e) {
			throw vscode.FileSystemError.Unavailable((e as Error).message);
		}
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const source = DecodedFileSystemProvider.sourceOf(uri);
		const { fileType, packPath, editable } = await this.decode(source);
		if (!editable || vscode.workspace.fs.isWritableFileSystem(source.scheme) === false) {
			throw vscode.FileSystemError.NoPermissions(`${packPath} cannot be saved here.`);
		}
		let bytes: Buffer;
		try {
			bytes = rpfm().encodeFromJson(new TextDecoder().decode(content), fileType, packPath, this.game());
		} catch (e) {
			throw vscode.FileSystemError.Unavailable((e as Error).message);
		}
		await vscode.workspace.fs.writeFile(source, bytes);
		this.cache.delete(source.toString());
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	watch(uri: vscode.Uri): vscode.Disposable {
		const source = DecodedFileSystemProvider.sourceOf(uri);
		if (source.scheme !== 'file') {
			return new vscode.Disposable(() => undefined);
		}
		// The binary file changed on disk (another tool, git): show the new JSON.
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(source.fsPath)), path.basename(source.fsPath)));
		const changed = () => {
			this.cache.delete(source.toString());
			this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		};
		watcher.onDidChange(changed);
		watcher.onDidCreate(changed);
		return watcher;
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions();
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions();
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
}

/**
 * The path of a file in its pack, which RPFM reads its type from: in the
 * virtual files the path after the pack's folder; on disk the path in the
 * mod's pack folder, else from its `animations/` folder, else its name.
 */
export function packPathOf(source: vscode.Uri): string {
	const p = source.path.replace(/^\/+/, '');
	if (source.scheme === VIRTUAL_SCHEME) {
		const lower = p.toLowerCase();
		if (lower.startsWith(`${BASEGAME_FOLDER.toLowerCase()}/`)) {
			return p.slice(BASEGAME_FOLDER.length + 1);
		}
		if (lower.startsWith(`${MODS_FOLDER.toLowerCase()}/`)) {
			return p.split('/').slice(2).join('/');
		}
		return p;
	}
	const pack = modPackFolder();
	if (pack && source.scheme === 'file') {
		const rel = path.relative(pack, source.fsPath);
		if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
			return rel.split(path.sep).join('/');
		}
	}
	return packPathFromDiskPath(p);
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { VIRTUAL_SCHEME } from '../adapter/pathMapper';
import { DECODED_SCHEME, DecodedFileSystemProvider } from '../decoded/DecodedFileSystemProvider';
import { modPackFolder } from '../modProject';
import { rpfm } from '../rpfm';
import { LiveSourceFS } from '../SourceFileSystemProvider';
import { ASSET_EXTENSIONS, findAssetReferences, pathPrefixAt, toPackPath } from './references';

/** Largest side of texture thumbnails in hovers, in pixels. */
const THUMBNAIL_SIZE = 160;

/** Text files that reference assets: in the virtual files, and in the mod's pack folder. */
export const ASSET_DOCUMENTS: vscode.DocumentSelector = [
	{ language: 'xml', scheme: VIRTUAL_SCHEME },
	{ language: 'xml', scheme: 'file', pattern: '**/pack/**' },
	{ scheme: 'file', pattern: '**/*.{variantmeshdefinition,wsmodel,material}' },
	// Structured binary files as JSON (portrait images, anim fragments).
	{ scheme: DECODED_SCHEME },
];
/** The mod's files that the "Check Mod" command scans. */
const MOD_ASSET_GLOB = '**/pack/**/*.{variantmeshdefinition,wsmodel,material,xml}';
const EXCLUDE = '{**/out/**,**/node_modules/**,**/.git/**}';

/** Where a referenced file comes from: the mod's pack folder first, then the packs in load order. */
export interface Located {
	uri: vscode.Uri;
	/** `this mod`, `@basegame` or a mod pack's file name. */
	from: string;
}

export class AssetResolver {
	constructor(private readonly sources: LiveSourceFS) {}

	async locate(packPath: string): Promise<Located | undefined> {
		const pack = modPackFolder();
		const local = pack && path.join(pack, ...packPath.split('/'));
		if (local && fs.existsSync(local)) {
			return { uri: vscode.Uri.file(local), from: 'this mod' };
		}
		const found = await this.sources.locate(packPath);
		return found && { uri: found.uri, from: found.pack };
	}

	/** Whether a missing file can be told apart from packs that are not loaded. */
	get canCheck(): boolean {
		return this.sources.loadedPacks;
	}

	/** Names in a pack folder: the mod's folder on disk and all packs. */
	async list(dir: string): Promise<{ name: string; isDir: boolean }[]> {
		const entries = new Map<string, { name: string; isDir: boolean }>();
		const pack = modPackFolder();
		const local = pack && path.join(pack, ...dir.split('/').filter(Boolean));
		if (local && fs.existsSync(local)) {
			for (const e of fs.readdirSync(local, { withFileTypes: true })) {
				entries.set(e.name.toLowerCase(), { name: e.name, isDir: e.isDirectory() });
			}
		}
		for (const e of await this.sources.listPackDir(dir)) {
			if (!entries.has(e.name.toLowerCase())) {
				entries.set(e.name.toLowerCase(), e);
			}
		}
		return [...entries.values()];
	}
}

/** Ctrl+click on an asset path opens the copy the game uses. */
export class AssetLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private readonly assets: AssetResolver) {}

	async provideDocumentLinks(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
		const links: vscode.DocumentLink[] = [];
		for (const ref of findAssetReferences(doc.getText())) {
			if (token.isCancellationRequested) {
				break;
			}
			const found = await this.assets.locate(ref.path);
			if (found) {
				const link = new vscode.DocumentLink(new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end)), found.uri);
				link.tooltip = `Open (from ${found.from})`;
				links.push(link);
			}
		}
		return links;
	}
}

/** Hovering an asset path tells where the game gets the file from. */
export class AssetHoverProvider implements vscode.HoverProvider {
	/** @param thumbnails Folder for texture thumbnails (hovers show images from files). */
	constructor(private readonly assets: AssetResolver, private readonly thumbnails: string) {}

	/** A small PNG of a texture, written to the thumbnails folder; undefined for other files or when it cannot be read. */
	private async thumbnail(packPath: string, uri: vscode.Uri): Promise<vscode.Uri | undefined> {
		if (!/\.(dds|png|tga|jpe?g)$/i.test(packPath)) {
			return undefined;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			const name = createHash('sha1').update(`${uri.toString()}|${stat.mtime}|${stat.size}`).digest('hex');
			const file = path.join(this.thumbnails, `${name}.png`);
			if (!fs.existsSync(file)) {
				const png = rpfm().imageThumbnail(Buffer.from(await vscode.workspace.fs.readFile(uri)), packPath, THUMBNAIL_SIZE);
				if (!png) {
					return undefined;
				}
				fs.mkdirSync(this.thumbnails, { recursive: true });
				fs.writeFileSync(file, png);
			}
			return vscode.Uri.file(file);
		} catch {
			return undefined; // a texture format the image library does not read
		}
	}

	async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
		const offset = doc.offsetAt(pos);
		const ref = findAssetReferences(doc.getText()).find((r) => r.start <= offset && offset <= r.end);
		if (!ref) {
			return undefined;
		}
		const found = await this.assets.locate(ref.path);
		const range = new vscode.Range(doc.positionAt(ref.start), doc.positionAt(ref.end));
		if (found) {
			const md = new vscode.MarkdownString(`\`${ref.path}\` from **${found.from}**`);
			const thumb = await this.thumbnail(ref.path, found.uri);
			if (thumb) {
				md.appendMarkdown(`\n\n![](${thumb.toString()})`);
			}
			return new vscode.Hover(md, range);
		}
		return this.assets.canCheck ? new vscode.Hover(`\`${ref.path}\` is not in the mod or in the packs of the game and mod list.`, range) : undefined;
	}
}

/** Completes asset paths folder by folder from the mod and the packs. */
export class AssetCompletionProvider implements vscode.CompletionItemProvider {
	static readonly triggers = ['/', '\\', '"'];

	constructor(private readonly assets: AssetResolver) {}

	async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken,
		context: vscode.CompletionContext): Promise<vscode.CompletionItem[] | undefined> {
		const at = pathPrefixAt(doc.lineAt(pos.line).text, pos.character);
		// Right after a quote only when asked (Ctrl+Space): every attribute starts with one.
		if (!at || (!at.prefix && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter)) {
			return undefined;
		}
		const sep = at.prefix.includes('\\') ? '\\' : '/';
		const typed = toPackPath(at.prefix);
		const cut = typed.lastIndexOf('/');
		const dir = cut < 0 ? '' : typed.slice(0, cut);
		let entries;
		try {
			entries = await this.assets.list(dir);
		} catch {
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		const nameStart = at.start + Math.max(at.prefix.lastIndexOf('/'), at.prefix.lastIndexOf('\\')) + 1;
		const range = new vscode.Range(pos.line, nameStart, pos.line, pos.character);
		const assetFile = new RegExp(`\\.(${ASSET_EXTENSIONS.map((e) => e.replace(/\./g, '\\.')).join('|')})$`, 'i');
		return entries
			.filter((e) => e.isDir || assetFile.test(e.name))
			.map((e) => {
				const item = new vscode.CompletionItem(e.name, e.isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
				item.range = range;
				if (e.isDir) {
					item.insertText = e.name + sep;
					item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
				}
				return item;
			});
	}
}

/** Warns about asset paths in the mod's files that point at no file of the mod or the packs. */
export class AssetDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('Total War assets');
	private readonly disposables: vscode.Disposable[] = [this.collection];
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(private readonly assets: AssetResolver, onDidReload: vscode.Event<void>) {
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
			vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
			onDidReload(() => vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0))),
		);
		vscode.workspace.textDocuments.forEach((d) => this.schedule(d, 0));
	}

	private schedule(doc: vscode.TextDocument, delay = 800): void {
		// The mod's files only: the game's own references are not the mod's problem.
		const own = doc.uri.scheme === 'file' || (doc.uri.scheme === DECODED_SCHEME && DecodedFileSystemProvider.sourceOf(doc.uri).scheme === 'file');
		if (!own || !vscode.languages.match(ASSET_DOCUMENTS, doc)) {
			return;
		}
		const key = doc.uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			void this.check(doc.uri, doc.getText()).then((d) => this.collection.set(doc.uri, d));
		}, delay));
	}

	private async check(uri: vscode.Uri, text: string): Promise<vscode.Diagnostic[]> {
		const lines = new LineIndex(text);
		const problems: vscode.Diagnostic[] = [];
		for (const ref of findAssetReferences(text)) {
			if (await this.assets.locate(ref.path) || !this.assets.canCheck) {
				continue;
			}
			const d = new vscode.Diagnostic(new vscode.Range(lines.position(ref.start), lines.position(ref.end)),
				`${ref.path} is not in the mod or in the packs of the game and mod list.`, vscode.DiagnosticSeverity.Warning);
			d.source = 'Total War';
			problems.push(d);
		}
		return problems;
	}

	/** Checks every asset file of the mod (the "Check Mod" command); resolves with the number of problems. */
	async checkWorkspace(): Promise<number> {
		let count = 0;
		for (const uri of await vscode.workspace.findFiles(MOD_ASSET_GLOB, EXCLUDE)) {
			const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
			const text = open?.getText() ?? decodeText(await vscode.workspace.fs.readFile(uri));
			const problems = await this.check(uri, text);
			this.collection.set(uri, problems);
			count += problems.length;
		}
		return count;
	}

	dispose(): void {
		this.timers.forEach((t) => clearTimeout(t));
		this.disposables.forEach((d) => d.dispose());
	}
}

/** A file's text: UTF-16 with a BOM (some of the game's files) or UTF-8. */
function decodeText(bytes: Uint8Array): string {
	const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
	return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes);
}

/** Offsets to positions for text that is not an open document. */
export class LineIndex {
	private readonly starts = [0];

	constructor(text: string) {
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) {
				this.starts.push(i + 1);
			}
		}
	}

	position(offset: number): vscode.Position {
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.starts[mid] <= offset) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return new vscode.Position(lo, offset - this.starts[lo]);
	}
}

/** Registers the asset path features. */
export function registerAssetProviders(sources: LiveSourceFS, storage: string): { diagnostics: AssetDiagnostics; disposables: vscode.Disposable[] } {
	const assets = new AssetResolver(sources);
	// Thumbnails of the last session are not needed any more.
	const thumbnails = path.join(storage, 'thumbnails');
	fs.rmSync(thumbnails, { recursive: true, force: true });
	const diagnostics = new AssetDiagnostics(assets, sources.onDidReload);
	return {
		diagnostics,
		disposables: [
			diagnostics,
			vscode.languages.registerDocumentLinkProvider(ASSET_DOCUMENTS, new AssetLinkProvider(assets)),
			vscode.languages.registerHoverProvider(ASSET_DOCUMENTS, new AssetHoverProvider(assets, thumbnails)),
			vscode.languages.registerCompletionItemProvider(ASSET_DOCUMENTS, new AssetCompletionProvider(assets), ...AssetCompletionProvider.triggers),
		],
	};
}

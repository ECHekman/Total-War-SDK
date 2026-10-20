/**
 * Asset paths in the game's text files: variant mesh definitions point at
 * models and textures, wsmodels at materials, materials at textures, ...
 * All of them are pack paths with a folder (`variantmeshes/.../x.rigid_model_v2`),
 * in an attribute value or element text, written with `/` or `\` in any case.
 */

/** Extensions of the files these references point at. */
export const ASSET_EXTENSIONS = [
	'rigid_model_v2', 'wsmodel', 'variantmeshdefinition', 'xml.material', 'material', 'xml.shader',
	'dds', 'png', 'tga', 'jpg', 'jpeg', 'anim', 'anm.meta', 'snd.meta', 'frg', 'animpack', 'bmd', 'xml',
];

export interface AssetReference {
	/** As written. */
	text: string;
	/** Normalised pack path: `/` separated, no leading `/`, as written otherwise. */
	path: string;
	/** Offsets of `text` in the document. */
	start: number;
	end: number;
}

const EXT = ASSET_EXTENSIONS.map((e) => e.replace(/\./g, '\\.')).join('|');
/** A value between `"`/`'`/`>` and `"`/`'`/`<`, with a folder and a known extension. */
const REFERENCE = new RegExp(`(?<=["'>]\\s*)([\\w\\-. ]*[/\\\\][\\w\\-. /\\\\]*?\\.(?:${EXT}))(?=\\s*["'<])`, 'gi');

/** Normalises a path as written to a pack path. */
export function toPackPath(text: string): string {
	return text.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/** The asset references in a text file. */
export function findAssetReferences(text: string): AssetReference[] {
	const refs: AssetReference[] = [];
	for (const m of text.matchAll(REFERENCE)) {
		const raw = m[1];
		const lead = raw.length - raw.trimStart().length;
		const value = raw.trim();
		const start = m.index + lead;
		refs.push({ text: value, path: toPackPath(value), start, end: start + value.length });
	}
	return refs;
}

/**
 * The path being typed at `offset` in a line, for completion: the run of path
 * characters before it that starts right after a quote or `>`. Undefined
 * outside a value.
 */
export function pathPrefixAt(line: string, offset: number): { start: number; prefix: string } | undefined {
	const before = line.slice(0, offset);
	const m = /["'>]([\w\-. /\\]*)$/.exec(before);
	if (!m) {
		return undefined;
	}
	return { start: offset - m[1].length, prefix: m[1] };
}

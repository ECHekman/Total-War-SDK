/**
 * Text files in packs, as RPFM recognises them (rpfm_lib `files/text/mod.rs`
 * `EXTENSIONS`, plus `.variantmeshdefinition` and `.wsmodel`): file name
 * suffix -> VS Code language id. The first matching suffix wins, so longer
 * ones come before the shorter ones they end with.
 *
 * `contributes.languages` in package.json adds the suffixes VS Code does not
 * know to these languages (test/unit/fileTypes.test.ts keeps the two in sync).
 */
export const TEXT_SUFFIXES: readonly (readonly [string, string])[] = [
	['.variantmeshdefinition', 'xml'],
	['.wsmodel', 'xml'],
	['.xml.material', 'xml'],
	['.xml.shader', 'xml'],
	['.environment_group.override', 'xml'],
	['.agf', 'plaintext'],
	['.bat', 'bat'],
	['.battle_script', 'lua'],
	['.battle_speech_camera', 'plaintext'],
	['.benchmark', 'xml'],
	['.bob', 'plaintext'],
	['.cco', 'plaintext'],
	['.cindyscene', 'xml'],
	['.cindyscenemanager', 'xml'],
	['.code-snippets', 'json'],
	['.code-workspace', 'json'],
	['.css', 'css'],
	['.csv', 'plaintext'],
	['.environment', 'xml'],
	['.environment_group', 'xml'],
	['.fbx', 'plaintext'],
	['.fx', 'hlsl'],
	['.fx_fragment', 'hlsl'],
	['.glsl', 'cpp'],
	['.h', 'cpp'],
	['.hlsl', 'hlsl'],
	['.htm', 'html'],
	['.html', 'html'],
	['.inl', 'cpp'],
	['.json', 'json'],
	['.js', 'javascript'],
	['.kfa', 'xml'],
	['.kfc', 'xml'],
	['.kfe', 'xml'],
	['.kfe_temp', 'xml'],
	['.kfl', 'xml'],
	['.kfl_temp', 'xml'],
	['.kfsl', 'xml'],
	['.kfp', 'xml'],
	['.kfcs', 'xml'],
	['.kfcs_temp', 'xml'],
	['.ktr', 'xml'],
	['.ktr_temp', 'xml'],
	['.lighting', 'xml'],
	['.log', 'log'],
	['.lua', 'lua'],
	['.md', 'markdown'],
	['.model_statistics', 'xml'],
	['.mvscene', 'xml'],
	['.py', 'python'],
	['.sbs', 'xml'],
	['.shader', 'xml'],
	['.sql', 'sql'],
	['.tai', 'plaintext'],
	['.technique', 'xml'],
	['.texture_array', 'plaintext'],
	['.tsv', 'plaintext'],
	['.twui', 'lua'],
	['.txt', 'plaintext'],
	['.xml', 'xml'],
	['.xml_temp', 'xml'],
	['.xt', 'plaintext'],
	['.yml', 'yaml'],
	['.yaml', 'yaml'],
	['.material', 'xml'],
];

/** Language of a text file in a pack by its name, or undefined when RPFM does not read it as text. */
export function textLanguage(fileName: string): string | undefined {
	const name = fileName.toLowerCase();
	return TEXT_SUFFIXES.find(([suffix]) => name.endsWith(suffix))?.[1];
}

/** Whether a file in a pack is a DB table fragment (`db/<table>_tables/<file>`). */
export function isDbTablePath(packPath: string): boolean {
	return /^db\/[^/]+_tables\/[^/]+$/i.test(packPath.replace(/\\/g, '/'));
}

/**
 * Structured binary files opened as JSON by default (rpfm-interface
 * `decodeToJson`), as custom editor selectors (package.json
 * `totalwar.decodedEditor`). `.atlas` and `groupformations.bin` are left
 * out: in WH3 the atlases are Spine text files and group formations are not
 * supported; "Open as JSON" still tries them. (RPFM reads about 90% of WH3's
 * BMDs; the rest use a file or section version it does not know and show the
 * decode error.)
 */
export const DECODED_PATTERNS = [
	'**/*portrait_settings*.bin', '**/animations/**/*_tables.bin', '**/animations/matched_combat/**/*.bin',
	'**/animations/database/matched/**/*.bin', '**/animations/database/trigger/**/*.bin',
	'**/animations/**/battle/**/*.bin', '**/*.frg', '**/*.bmd', '**/*.vegetation',
];

/** The pack path of a file outside the mod's pack folder (`/` separated): from its `animations/` folder, else its name. */
export function packPathFromDiskPath(diskPath: string): string {
	const parts = diskPath.split('/');
	const at = parts.map((s) => s.toLowerCase()).lastIndexOf('animations');
	return at >= 0 ? parts.slice(at).join('/') : parts[parts.length - 1];
}

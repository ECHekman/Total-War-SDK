import * as vscode from 'vscode';

import { virtualFilesExclude } from './SourceFileSystemProvider';

/**
 * Kinds of pack files that can be hidden from the virtual files as a group,
 * as glob patterns for `totalwar.virtualFiles.exclude` (relative to a pack; a
 * pattern without `/` matches a name in any folder, a folder hides its contents).
 */
export const FILE_CATEGORIES: { label: string; detail: string; globs: string[] }[] = [
	{ label: 'Audio', detail: 'audio/, .wem, .bnk', globs: ['audio', '*.wem', '*.bnk'] },
	{ label: 'Animations', detail: 'animations/, .anim, .frg, .meta', globs: ['animations', '*.anim', '*.frg', '*.meta'] },
	{ label: 'Models and materials', detail: 'variantmeshes/, rigidmodels/, .rigid_model_v2, .wsmodel, .material, .variantmeshdefinition',
		globs: ['variantmeshes', 'rigidmodels', '*.rigid_model_v2', '*.wsmodel', '*.material', '*.variantmeshdefinition'] },
	{ label: 'Textures and images', detail: '.dds, .png, .jpg, .tga', globs: ['*.dds', '*.png', '*.jpg', '*.jpeg', '*.tga'] },
	{ label: 'Maps and terrain', detail: 'terrain/, battleterrain/, campaign_maps/, prefabs/, .bmd, .compressed_map, .grass',
		globs: ['terrain', 'battleterrain', 'campaign_maps', 'prefabs', '*.bmd', '*.compressed_map', '*.grass'] },
	{ label: 'Shaders and effects', detail: 'shaders/, fx/, vfx/, effects/, .hlsl_compiled', globs: ['shaders', 'fx', 'vfx', 'effects', '*.hlsl_compiled'] },
	{ label: 'Movies', detail: 'movies/, .ca_vp8, .bk2', globs: ['movies', '*.ca_vp8', '*.bk2'] },
	{ label: 'UI', detail: 'ui/', globs: ['ui'] },
	{ label: 'Text and localisation', detail: 'text/, .loc', globs: ['text', '*.loc'] },
	{ label: 'DB tables', detail: 'db/', globs: ['db'] },
	{ label: 'Scripts', detail: 'script/, .lua', globs: ['script', '*.lua'] },
];

/**
 * "TotalWar: Filter Virtual Files…": tick the kinds of files to show; the
 * unticked ones are hidden. Writes `totalwar.virtualFiles.exclude` (patterns of
 * your own are kept).
 */
export async function filterVirtualFiles(): Promise<void> {
	const current = new Set(virtualFilesExclude());
	const items = FILE_CATEGORIES.map((c) => ({ ...c, picked: !c.globs.some((g) => current.has(g)) }));
	const known = new Set(FILE_CATEGORIES.flatMap((c) => c.globs));
	const own = [...current].filter((g) => !known.has(g));
	const picks = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: 'Show in Virtual TW Source Files',
		placeHolder: own.length
			? `Your own patterns are kept: ${own.join(', ')} (edit them in the totalwar.virtualFiles.exclude setting)`
			: 'Unticked kinds are hidden; folders left empty disappear. Hidden files still open from the debugger.',
	});
	if (!picks) {
		return;
	}
	const shown = new Set(picks.map((p) => p.label));
	const exclude = [...own, ...FILE_CATEGORIES.filter((c) => !shown.has(c.label)).flatMap((c) => c.globs)];
	const target = vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFile
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
	await vscode.workspace.getConfiguration('totalwar').update('virtualFiles.exclude', exclude.length ? exclude : undefined, target);
}

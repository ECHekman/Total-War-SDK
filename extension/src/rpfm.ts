import * as path from 'node:path';

import type * as Rpfm from '../../rpfm-interface/rpfm-interface';

export type { DbSchema, DirEntry, DirTree, PackHolder } from '../../rpfm-interface/rpfm-interface';
export type RpfmModule = typeof Rpfm;

let cached: RpfmModule | undefined;
let loadError: Error | undefined;

/**
 * Loads the rpfm-interface native module shipped in `<extension>/native`.
 * Throws a readable error when it is missing (e.g. a development checkout
 * where rpfm-interface was not built).
 */
export function rpfm(): RpfmModule {
	if (cached) {
		return cached;
	}
	if (loadError) {
		throw loadError;
	}
	const file = path.join(__dirname, '..', 'native', 'rpfm-interface.node');
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		cached = require(file) as RpfmModule;
		return cached;
	} catch (e) {
		loadError = new Error(`Could not load the pack file library (${file}): ${(e as Error).message}`);
		throw loadError;
	}
}

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// The Lua debuggee mod and the rpfm native module live outside the extension
// folder; copy them in so they end up in the VSIX.
function copyAssets() {
	const debuggeeSrc = path.join(here, '..', 'debuggee');
	const debuggeeDst = path.join(here, 'debuggee');
	fs.rmSync(debuggeeDst, { recursive: true, force: true });
	fs.cpSync(debuggeeSrc, debuggeeDst, { recursive: true });

	const exampleSrc = path.join(here, '..', 'example');
	const exampleDst = path.join(here, 'example');
	fs.rmSync(exampleDst, { recursive: true, force: true });
	fs.cpSync(exampleSrc, exampleDst, { recursive: true, filter: (src) => !/[\\/]out([\\/]|$)/.test(src) });

	for (const file of ['LICENSE.txt', 'NOTICE-vscode-mono-debug.txt']) {
		fs.copyFileSync(path.join(here, '..', file), path.join(here, file));
	}

	const nativeSrc = path.join(here, '..', 'rpfm-interface', 'rpfm-interface.win32-x64-msvc.node');
	const nativeDst = path.join(here, 'native', 'rpfm-interface.node');
	if (fs.existsSync(nativeSrc)) {
		fs.mkdirSync(path.dirname(nativeDst), { recursive: true });
		const same = fs.existsSync(nativeDst) && fs.readFileSync(nativeSrc).equals(fs.readFileSync(nativeDst));
		try {
			if (!same) {
				fs.copyFileSync(nativeSrc, nativeDst);
			}
		} catch (e) {
			// Loaded by a running Extension Development Host: Windows locks it.
			if (e.code !== 'EBUSY' && e.code !== 'EPERM') {
				throw e;
			}
			console.warn(`[assets] ${nativeDst} is in use (close the Extension Development Host to update it).`);
		}
	} else if (!fs.existsSync(nativeDst)) {
		console.warn(`[assets] ${nativeSrc} not found: build rpfm-interface first (npm run build in ../rpfm-interface). Pack features will be unavailable.`);
	}

	// Steam Workshop downloads (src/workshop.ts): the helper and the steam_api64.dll next to it.
	const steamBin = path.join(here, '..', 'steam-helper', 'bin');
	for (const name of ['steam-helper.exe', 'steam_api64.dll']) {
		const src = path.join(steamBin, name);
		const dst = path.join(here, 'native', name);
		if (!fs.existsSync(src)) {
			console.warn(`[assets] ${src} not found: build steam-helper first (npm run build in ../steam-helper). Workshop downloads will be unavailable.`);
			continue;
		}
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
			fs.copyFileSync(src, dst);
		}
	}
}

copyAssets();
await bundleSchemas();

// Snapshot of the RPFM schema shipped in the VSIX: the DB view's fallback when
// it cannot download a current one (see src/db/schema.ts). Fetched once, and
// refreshed for production builds.
async function bundleSchemas() {
	const dir = path.join(here, 'schemas');
	for (const name of ['schema_wh3.ron']) {
		const file = path.join(dir, name);
		if (fs.existsSync(file) && !production) {
			continue;
		}
		try {
			const res = await fetch(`https://raw.githubusercontent.com/Frodo45127/rpfm-schemas/master/${name}`, { signal: AbortSignal.timeout(60000) });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
			console.log(`[assets] downloaded ${name}`);
		} catch (e) {
			const msg = `[assets] could not download ${name}: ${e.message}`;
			if (production && !fs.existsSync(file)) {
				throw new Error(msg);
			}
			console.warn(msg);
		}
	}
}

const ctx = await esbuild.context({
	entryPoints: ['src/extension.ts'],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	outfile: 'dist/extension.js',
	external: ['vscode'],
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: 'info',
});

if (watch) {
	await ctx.watch();
} else {
	await ctx.rebuild();
	await ctx.dispose();
}

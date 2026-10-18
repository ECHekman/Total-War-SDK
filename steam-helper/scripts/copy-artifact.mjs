// Copies steam-helper.exe and the steam_api64.dll it links against (from the
// steamworks-sys build output) to bin/, where the extension build picks them up.
import * as fs from 'node:fs';
import * as path from 'node:path';

const profile = process.argv[2] ?? 'release';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const target = path.join(root, 'target', profile);
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });

fs.copyFileSync(path.join(target, 'steam-helper.exe'), path.join(bin, 'steam-helper.exe'));

const buildDir = path.join(target, 'build');
const dll = fs.readdirSync(buildDir)
	.filter((d) => d.startsWith('steamworks-sys-'))
	.map((d) => path.join(buildDir, d, 'out', 'steam_api64.dll'))
	.filter((f) => fs.existsSync(f))
	.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!dll) {
	throw new Error(`steam_api64.dll not found under ${buildDir}`);
}
fs.copyFileSync(dll, path.join(bin, 'steam_api64.dll'));
console.log(`${target} -> ${bin}`);

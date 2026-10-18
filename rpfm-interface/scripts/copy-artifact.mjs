// Copies the cargo build output to a Node addon file name (<name>.<platform>-<arch>-<abi>.node).
import * as fs from 'node:fs';
import * as path from 'node:path';

const profile = process.argv[2] ?? 'release';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const lib = { win32: 'rpfm_interface.dll', darwin: 'librpfm_interface.dylib' }[process.platform] ?? 'librpfm_interface.so';
const triple = process.platform === 'win32' ? `win32-${process.arch}-msvc` : `${process.platform}-${process.arch}`;
const src = path.join(root, 'target', profile, lib);
const dst = path.join(root, `rpfm-interface.${triple}.node`);
fs.copyFileSync(src, dst);
console.log(`${src} -> ${dst}`);

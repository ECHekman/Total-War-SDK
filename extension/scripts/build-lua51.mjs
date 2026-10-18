// Downloads the official Lua 5.1.5 sources and builds a standalone interpreter
// (.tools/lua51/lua51.exe) used by the debuggee integration tests. Total War
// runs Lua 5.1, so the tests must too.
//
// Windows: compiled with MSVC (found through vswhere). Elsewhere: cc.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const URL_ = 'https://www.lua.org/ftp/lua-5.1.5.tar.gz';
const SHA256 = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const toolsDir = path.resolve(here, '..', '.tools', 'lua51');
const exe = path.join(toolsDir, process.platform === 'win32' ? 'lua51.exe' : 'lua51');

if (fs.existsSync(exe) && !process.argv.includes('--force')) {
	console.log(`Lua 5.1 already built: ${exe}`);
	process.exit(0);
}

fs.mkdirSync(toolsDir, { recursive: true });
const tarball = path.join(toolsDir, 'lua-5.1.5.tar.gz');

if (!fs.existsSync(tarball)) {
	console.log(`Downloading ${URL_}`);
	const res = await fetch(URL_);
	if (!res.ok) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}
	fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
}

const digest = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
if (digest !== SHA256) {
	fs.rmSync(tarball);
	throw new Error(`SHA-256 mismatch for lua-5.1.5.tar.gz: got ${digest}`);
}

const srcRoot = path.join(toolsDir, 'lua-5.1.5');
fs.rmSync(srcRoot, { recursive: true, force: true });
execFileSync('tar', ['-xzf', path.basename(tarball)], { cwd: toolsDir, stdio: 'inherit' });

const srcDir = path.join(srcRoot, 'src');
const sources = fs.readdirSync(srcDir)
	.filter((f) => f.endsWith('.c') && f !== 'luac.c' && f !== 'print.c');

if (process.platform === 'win32') {
	const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
		'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
	const vsPath = execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
		'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
	{ encoding: 'utf8' }).trim();
	if (!vsPath) {
		throw new Error('MSVC (Visual Studio C++ build tools) not found.');
	}
	const vcvars = path.join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
	const cmd = `call "${vcvars}" >nul && cl /nologo /O2 /MT /W0 /Fe:"${exe}" ${sources.join(' ')}`;
	const script = path.join(toolsDir, 'build.cmd');
	fs.writeFileSync(script, `@echo off\r\ncd /d "${srcDir}"\r\n${cmd}\r\n`);
	execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit' });
} else {
	execFileSync('cc', ['-O2', '-DLUA_USE_POSIX', '-o', exe, ...sources, '-lm'], { cwd: srcDir, stdio: 'inherit' });
}

console.log(`Built ${exe}`);

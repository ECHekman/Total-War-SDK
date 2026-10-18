import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');

describe('versions', () => {
	it('the debugger mod and the extension have the same version', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as { version: string };
		const lua = fs.readFileSync(path.join(extensionRoot, '..', 'debuggee', 'script', '_lib', 'mod', 'vscode-debuggee.lua'), 'utf8');
		const mod = /local MOD_VERSION = '([^']+)'/.exec(lua)?.[1];
		assert.equal(mod, pkg.version, 'bump MOD_VERSION in vscode-debuggee.lua together with package.json');
	});
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

/** Uses a locally installed VS Code when available, otherwise downloads one. */
function localVSCode(): string | undefined {
	if (process.env.VSCODE_EXECUTABLE) {
		return process.env.VSCODE_EXECUTABLE;
	}
	if (process.platform === 'win32' && !process.env.CI) {
		const candidate = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
	const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'twdbg-ws-'));
	try {
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath: localVSCode(),
			launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes',
				'--user-data-dir', path.join(workspace, '.user-data')],
		});
	} catch (e) {
		console.error('Extension tests failed', e);
		process.exitCode = 1;
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

void main();

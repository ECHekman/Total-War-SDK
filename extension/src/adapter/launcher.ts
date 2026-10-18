import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * Total War takes its command line as `;` separated script commands. The first
 * one is the mod list file, e.g. `used_mods.txt; game_startup_mode campaign_load "x.save";`
 */
export function buildArgumentString(modListFile: string | undefined, args: string | undefined): string {
	const parts: string[] = [];
	const mods = (modListFile ?? '').trim().replace(/;+$/, '');
	if (mods) {
		parts.push(mods + ';');
	}
	const extra = (args ?? '').trim();
	if (extra) {
		parts.push(extra);
	}
	return parts.join(' ');
}

export interface LaunchOptions {
	executable: string;
	argumentString: string;
	env?: { [key: string]: string | null | undefined };
}

export function launchGame(opts: LaunchOptions): ChildProcess {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		if (v === null || v === undefined) {
			delete env[k];
		} else {
			env[k] = String(v);
		}
	}
	// windowsVerbatimArguments: the game parses its command line itself and the
	// argument string already contains its own quoting. Node does not quote the
	// executable in that mode, so do it here: an unquoted "C:\Program Files (x86)\..."
	// makes the game misread its arguments (the mod list is ignored).
	return spawn(opts.executable, opts.argumentString ? [opts.argumentString] : [], {
		argv0: `"${opts.executable}"`,
		cwd: path.dirname(opts.executable),
		env,
		detached: true,
		stdio: 'ignore',
		windowsHide: false,
		windowsVerbatimArguments: true,
	});
}

/**
 * Process ids of running copies of `executable` that started at or after
 * `since` (ms since epoch). Used to find the game when Steam restarted it
 * under a new process. Windows only; resolves to [] elsewhere or on failure.
 */
export function findProcessesStartedSince(executable: string, since: number): Promise<number[]> {
	if (process.platform !== 'win32') {
		return Promise.resolve([]);
	}
	const name = path.basename(executable).replace(/'/g, "''");
	const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | `
		+ 'Select-Object ProcessId, ExecutablePath, @{n="Started";e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | '
		+ 'ConvertTo-Json -Compress';
	return new Promise((resolve) => {
		execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
			if (err || !stdout.trim()) {
				return resolve([]);
			}
			try {
				const parsed = JSON.parse(stdout) as unknown;
				const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; ExecutablePath?: string; Started: number }[];
				const wanted = path.resolve(executable).toLowerCase();
				resolve(rows
					.filter((r) => r.Started >= since - 1000 && (!r.ExecutablePath || path.resolve(r.ExecutablePath).toLowerCase() === wanted))
					.map((r) => r.ProcessId));
			} catch {
				resolve([]);
			}
		});
	});
}

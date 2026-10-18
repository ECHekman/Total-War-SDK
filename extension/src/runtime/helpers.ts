// Helpers of the game tools (no vscode import: unit tested).

/** A Lua string literal for a key or name (rejects what a key never contains). */
export function luaString(value: string): string {
	if (/[\r\n\0]/.test(value)) {
		throw new Error(`Not a valid key: ${JSON.stringify(value)}`);
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The game's chunk name for a script file: its path from the `script` folder
 * up, with backslashes (`script\campaign\mod\x.lua`), as the game loads it.
 */
export function chunkNameFor(fsPath: string): string | undefined {
	const parts = fsPath.split(/[\\/]/);
	const i = parts.map((p) => p.toLowerCase()).lastIndexOf('script');
	return i >= 0 ? parts.slice(i).join('\\') : undefined;
}

/** An event name filter: a name, or a pattern with `*`. */
export function matchesName(pattern: string, name: string): boolean {
	const re = new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
	return re.test(name);
}

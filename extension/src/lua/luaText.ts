// Text helpers for the Lua providers (no vscode import: unit tested).

/** The string literal the cursor is in on `line`, if any: its quote, start column and text before the cursor. */
export function stringAt(line: string, column: number): { quote: string; start: number; prefix: string } | undefined {
	let quote: string | undefined;
	let start = 0;
	for (let i = 0; i < column; i++) {
		const c = line[i];
		if (quote) {
			if (c === '\\') {
				i++;
			} else if (c === quote) {
				quote = undefined;
			}
		} else if (c === '"' || c === '\'') {
			quote = c;
			start = i;
		} else if (c === '-' && line[i + 1] === '-') {
			return undefined; // comment
		}
	}
	return quote ? { quote, start, prefix: line.slice(start + 1, column) } : undefined;
}

/** Whether the string starting at `start` is the second argument of an `add_listener(` call. */
export function isListenerEventArg(line: string, start: number): boolean {
	return /\badd_listener\s*\(\s*(?:"[^"]*"|'[^']*'|[\w.:[\]]+)\s*,\s*$/.test(line.slice(0, start));
}

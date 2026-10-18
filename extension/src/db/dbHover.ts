import * as vscode from 'vscode';

import { DEBUG_TYPE } from '../debugConfig';
import { DbService } from './DbService';
import { formatValue } from './effective';
import { LOC_COLUMN_NAMES, locPrefix } from './modChecks';

/** Fields shown per row in a hover; the grid has the rest. */
const MAX_FIELDS = 24;
const STRING_LITERAL = /"[^"\n\\]*"|'[^'\n\\]*'/;

/**
 * Hovering a string literal in Lua that is a DB key (a unit, building, effect...)
 * shows its effective row. Setting `totalwar.dbHover`: "debugging" (default, only
 * while a Total War debug session runs), "always" or "off".
 */
export class DbHoverProvider implements vscode.HoverProvider {
	constructor(private readonly db: DbService) {}

	async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const mode = vscode.workspace.getConfiguration('totalwar').get<string>('dbHover', 'debugging');
		if (mode === 'off' || (mode === 'debugging' && vscode.debug.activeDebugSession?.type !== DEBUG_TYPE)) {
			return undefined;
		}
		const range = doc.getWordRangeAtPosition(pos, STRING_LITERAL);
		if (!range) {
			return undefined;
		}
		const key = doc.getText(range).slice(1, -1);
		if (key.length < 3) {
			return undefined;
		}
		let found;
		try {
			found = await this.db.findKey(key);
		} catch {
			return undefined; // no packs or schema yet: the view shows why
		}
		if (!found.length || token.isCancellationRequested) {
			return undefined;
		}
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ['totalwar.openDbTable'] };
		for (const { table, row } of found.slice(0, 3)) {
			const t = await this.db.table(table);
			const open = `command:totalwar.openDbTable?${encodeURIComponent(JSON.stringify([table, row.key]))}`;
			md.appendMarkdown(`**${table}** — from \`${row.source.pack}\``);
			if (row.overridden.length) {
				md.appendMarkdown(` (overrides ${row.overridden.map((o) => `\`${o.source.pack}\``).join(', ')})`);
			}
			md.appendMarkdown(` · [open table](${open})\n\n`);
			for (const [column, text] of await locTextsFor(this.db, table, row.key, t.columns.map((c) => c.name))) {
				md.appendMarkdown(`*${column}*: ${escapeCell(text)}\n\n`);
			}
			md.appendMarkdown('| field | value |\n|---|---|\n');
			const shown = t.columns
				.map((c, i) => ({ c, v: row.values[i] }))
				.filter(({ c, v }) => !c.isKey && v !== undefined && v !== '');
			for (const { c, v } of shown.slice(0, MAX_FIELDS)) {
				md.appendMarkdown(`| ${c.name} | ${escapeCell(formatValue(v, c))} |\n`);
			}
			if (shown.length > MAX_FIELDS) {
				md.appendMarkdown(`| … | ${shown.length - MAX_FIELDS} more |\n`);
			}
			md.appendMarkdown('\n');
		}
		if (found.length > 3) {
			md.appendMarkdown(`Also in: ${found.slice(3).map((f) => f.table).join(', ')}`);
		}
		return new vscode.Hover(md, range);
	}
}

/** Columns whose loc text `<table>_<column>_<key>` exists, with the text. */
async function locTextsFor(db: DbService, table: string, key: string, columns: string[]): Promise<[string, string][]> {
	let loc;
	try {
		loc = await db.loc();
	} catch {
		return [];
	}
	const prefix = locPrefix(table);
	const out: [string, string][] = [];
	for (const column of new Set([...LOC_COLUMN_NAMES, ...columns])) {
		const entry = loc.get(`${prefix}_${column}_${key}`);
		if (entry?.text) {
			out.push([column, entry.text]);
		}
	}
	return out;
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
}

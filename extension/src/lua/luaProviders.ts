import * as vscode from 'vscode';

import { DbService } from '../db/DbService';
import { isListenerEventArg, stringAt } from './luaText';

/** Max DB keys offered at once; typing more narrows them. */
const MAX_KEYS = 200;
const MIN_PREFIX = 3;

/**
 * Completion in Lua strings: event names for `add_listener` (when the Lua
 * language server doesn't already offer them from the stubs) and DB keys.
 */
export class TwLuaCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly db: DbService, private readonly events: () => readonly string[]) {}

	async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
		const line = doc.lineAt(pos.line).text;
		const str = stringAt(line, pos.character);
		if (!str) {
			return undefined;
		}
		const range = new vscode.Range(pos.line, str.start + 1, pos.line, pos.character);

		if (isListenerEventArg(line, str.start)) {
			if (vscode.extensions.getExtension('sumneko.lua')) {
				return undefined; // the stubs give the server the event names
			}
			return this.events().map((name) => {
				const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
				item.range = range;
				item.detail = 'script event';
				return item;
			});
		}

		if (!vscode.workspace.getConfiguration('totalwar').get<boolean>('dbCompletion', true) || str.prefix.length < MIN_PREFIX) {
			return undefined;
		}
		let keys;
		try {
			keys = await this.db.keysWithPrefix(str.prefix, MAX_KEYS + 1);
		} catch {
			return undefined; // no game or schema: the DB view says why
		}
		if (token.isCancellationRequested || !keys.length) {
			return undefined;
		}
		const items = keys.slice(0, MAX_KEYS).map(({ key, tables }) => {
			const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
			item.range = range;
			item.detail = tables.join(', ');
			item.sortText = key;
			return item;
		});
		// Incomplete: more keys than shown, so ask again while typing.
		return new vscode.CompletionList(items, keys.length > MAX_KEYS);
	}

	async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
		if (item.kind !== vscode.CompletionItemKind.Value || typeof item.label !== 'string') {
			return item;
		}
		try {
			const found = await this.db.findKey(item.label);
			const first = found[0];
			if (first) {
				const t = await this.db.table(first.table);
				const fields = t.columns
					.map((c, i) => ({ c, v: first.row.values[i] }))
					.filter(({ c, v }) => !c.isKey && v !== undefined && v !== '')
					.slice(0, 8)
					.map(({ c, v }) => `${c.name}: ${String(v)}`);
				item.documentation = new vscode.MarkdownString(`**${first.table}** from \`${first.row.source.pack}\`\n\n${fields.map((f) => `- ${f}`).join('\n')}`);
			}
		} catch {
			// no details
		}
		return item;
	}
}

const STRING_LITERAL = /"([^"\n\\]{3,})"|'([^'\n\\]{3,})'/g;

/** Makes DB keys in Lua strings Ctrl+clickable: they open the row in the DB grid. */
export class DbKeyLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private readonly db: DbService) {}

	provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
		if (!vscode.workspace.getConfiguration('totalwar').get<boolean>('dbCompletion', true)) {
			return [];
		}
		this.db.prepareKeyIndex();
		const links: vscode.DocumentLink[] = [];
		const text = doc.getText();
		for (const m of text.matchAll(STRING_LITERAL)) {
			const key = m[1] ?? m[2];
			const tables = this.db.tablesWithKeyIfIndexed(key);
			if (!tables?.length) {
				continue;
			}
			const start = doc.positionAt(m.index! + 1);
			const link = new vscode.DocumentLink(
				new vscode.Range(start, start.translate(0, key.length)),
				vscode.Uri.parse(`command:totalwar.openDbTable?${encodeURIComponent(JSON.stringify([tables[0], key]))}`));
			link.tooltip = `Open in ${tables.join(', ')}`;
			links.push(link);
		}
		return links;
	}
}

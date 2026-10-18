import * as vscode from 'vscode';

import { DbService } from './DbService';

type Node =
	| { kind: 'message'; text: string }
	| { kind: 'table'; table: string };

/** "Game Database" view in Run and Debug: the tables; clicking one opens it in the grid. */
export class DbTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	/** Table name filter. */
	private tableFilter = '';
	private readonly subscription: vscode.Disposable;

	constructor(private readonly db: DbService, private readonly log?: vscode.OutputChannel) {
		this.subscription = db.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	get filter(): string {
		return this.tableFilter;
	}

	setTableFilter(filter: string): void {
		this.tableFilter = filter.trim().toLowerCase();
		this.refresh();
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'message') {
			const item = new vscode.TreeItem(node.text);
			item.tooltip = node.text;
			return item;
		}
		const item = new vscode.TreeItem(node.table);
		item.iconPath = new vscode.ThemeIcon('table');
		item.contextValue = 'dbTable';
		item.command = { command: 'totalwar.openDbTable', title: 'Open', arguments: [node.table] };
		return item;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (node) {
			return [];
		}
		try {
			const tables = (await this.db.tables()).filter((t) => t.toLowerCase().includes(this.tableFilter));
			this.log?.appendLine(`DB view: showing ${tables.length} tables.`);
			return tables.length
				? tables.map((table) => ({ kind: 'table', table }))
				: [{ kind: 'message', text: `No tables match "${this.tableFilter}".` }];
		} catch (e) {
			this.log?.appendLine(`DB view: ${(e as Error).message}`);
			return [{ kind: 'message', text: (e as Error).message }];
		}
	}

	dispose(): void {
		this.subscription.dispose();
		this.emitter.dispose();
	}
}

/** Table name of a tree node passed to a context menu command. */
export function tableOf(node: unknown): string | undefined {
	const n = node as { table?: string } | undefined;
	return typeof n?.table === 'string' ? n.table : undefined;
}

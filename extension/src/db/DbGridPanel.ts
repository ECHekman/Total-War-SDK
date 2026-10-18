import * as vscode from 'vscode';

import { DbService } from './DbService';
import { EffectiveTable } from './effective';
import { gridHtml, gridWebviewOptions } from './gridHtml';

/** A webview with one effective DB table as a sortable, filterable grid (read-only). */
export class DbGridPanel implements vscode.Disposable {
	private static readonly panels = new Map<string, DbGridPanel>();

	static async show(db: DbService, extensionUri: vscode.Uri, table: string, filter?: string): Promise<void> {
		const existing = DbGridPanel.panels.get(table);
		if (existing) {
			existing.panel.reveal();
			if (filter !== undefined) {
				void existing.panel.webview.postMessage({ type: 'filter', filter });
			}
			return;
		}
		const panel = vscode.window.createWebviewPanel('twdev.dbGrid', table, vscode.ViewColumn.Active,
			{ ...gridWebviewOptions(extensionUri), retainContextWhenHidden: true });
		DbGridPanel.panels.set(table, new DbGridPanel(db, extensionUri, table, panel, filter));
	}

	private readonly disposables: vscode.Disposable[] = [];

	private constructor(private readonly db: DbService, private readonly extensionUri: vscode.Uri,
		private readonly table: string, private readonly panel: vscode.WebviewPanel, private filter?: string) {
		panel.webview.html = gridHtml(panel.webview, extensionUri);
		this.disposables.push(
			panel.onDidDispose(() => this.dispose()),
			panel.webview.onDidReceiveMessage((msg: { type: string; table?: string; key?: string }) => {
				if (msg.type === 'ready') {
					void this.load();
				} else if (msg.type === 'open' && msg.table) {
					void DbGridPanel.show(this.db, this.extensionUri, msg.table, msg.key)
						.catch((e: Error) => vscode.window.showErrorMessage(e.message));
				} else if (msg.type === 'updateSchema') {
					void vscode.commands.executeCommand('twdev.updateDbSchema');
				}
			}),
			db.onDidChange(() => void this.load()),
		);
	}

	private async load(): Promise<void> {
		try {
			const t = await this.db.table(this.table);
			void this.panel.webview.postMessage({ type: 'init', mode: 'view', filter: this.filter, ...serialize(t) });
			this.filter = undefined;
		} catch (e) {
			void this.panel.webview.postMessage({ type: 'error', message: (e as Error).message });
		}
	}

	dispose(): void {
		DbGridPanel.panels.delete(this.table);
		this.disposables.forEach((d) => d.dispose());
		this.panel.dispose();
	}
}

function serialize(t: EffectiveTable) {
	return {
		table: t.name,
		columns: t.columns,
		errors: t.errors,
		fragments: t.fragments.map((f) => `${f.pack}/${f.path}`),
		rows: t.rows.map((r) => ({
			key: r.key,
			values: r.values.map((v) => (v === undefined ? null : v)),
			source: r.source.pack,
			overridden: r.overridden.map((o) => o.source.pack),
		})),
	};
}

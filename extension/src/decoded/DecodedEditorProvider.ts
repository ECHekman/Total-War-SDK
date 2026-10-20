import * as vscode from 'vscode';

import { DecodedFileSystemProvider } from './DecodedFileSystemProvider';

/**
 * Default editor of the structured binary files (portrait settings, anim
 * tables, ...): opens their JSON (`totalwar-decoded:`) in a text editor in its
 * place, so they are edited with VS Code's own JSON support and schemas. When
 * the file cannot be decoded it stays open with the reason.
 */
export class DecodedEditorProvider implements vscode.CustomReadonlyEditorProvider {
	static readonly viewType = 'totalwar.decodedEditor';

	constructor(private readonly decoded: DecodedFileSystemProvider) {}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		try {
			await this.decoded.decode(document.uri);
		} catch (e) {
			panel.webview.options = { enableCommandUris: ['vscode.openWith'] };
			panel.webview.html = errorHtml(document.uri, (e as Error).message);
			return;
		}
		await openDecoded(this.decoded, document.uri, panel.viewColumn);
		panel.dispose();
	}
}

/** "TotalWar: Open as JSON". Says why when a file the mod could change opens read only. */
export async function openDecoded(decoded: DecodedFileSystemProvider, source: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(DecodedFileSystemProvider.uriFor(source));
	if (doc.languageId !== 'json') {
		await vscode.languages.setTextDocumentLanguage(doc, 'json');
	}
	await vscode.window.showTextDocument(doc, { viewColumn, preview: false });
	const { readOnlyReason } = await decoded.decode(source);
	if (readOnlyReason && vscode.workspace.fs.isWritableFileSystem(source.scheme) !== false) {
		void vscode.window.showInformationMessage(readOnlyReason);
	}
}

function errorHtml(uri: vscode.Uri, message: string): string {
	const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	const args = encodeURIComponent(JSON.stringify([uri.toJSON(), 'default']));
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font-family: var(--vscode-font-family); padding: 1em;">
<p>${escape(message)}</p>
<p><a href="command:vscode.openWith?${args}">Open with the default editor</a></p>
</body></html>`;
}

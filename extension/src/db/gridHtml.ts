import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

/** Webview options for the DB grid (scripts from the extension's media folder only). */
export function gridWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

/**
 * The page of the DB grid (media/dbGrid.js), for the Game Database viewer and
 * the DB file editor. The script asks for its data with a "ready" message.
 */
export function gridHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('dbGrid.css')}">
</head>
<body>
<div id="bar">
	<input id="filter" type="text" placeholder="Filter rows (any column)">
	<label class="view-only"><input id="showSource" type="checkbox" checked> Source pack</label>
	<label class="view-only"><input id="onlyOverridden" type="checkbox"> Only rows that override others</label>
	<button id="add" class="edit-only hidden primary" title="Add a row with the schema's defaults">Add row</button>
	<button id="duplicate" class="edit-only hidden" title="Copy the selected rows">Duplicate</button>
	<button id="delete" class="edit-only hidden" title="Delete the selected rows (Del)">Delete</button>
	<button id="import" class="edit-only hidden" title="Copy rows from the game's tables (as your mod list has them)">Import from game…</button>
	<button id="updateSchema" class="hidden">Update DB Schema</button>
	<span id="info">Loading…</span>
</div>
<div id="banner" class="hidden"></div>
<div id="errors"></div>
<div id="scroll" tabindex="0"><table><thead></thead><tbody></tbody></table></div>
<script nonce="${nonce}" src="${media('dbGrid.js')}"></script>
</body>
</html>`;
}

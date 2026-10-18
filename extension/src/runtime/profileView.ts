import type * as vscode from 'vscode';

/** What the debuggee's profiler returns: folded stacks ("outer;...;inner") and their sample counts. */
export interface ProfileResult {
	samples: { s: string; n: number }[];
	total: number;
	seconds: number;
	interval: number;
}

export interface FunctionTime {
	name: string;
	self: number;
	total: number;
}

/** Samples per function: where it was running (self) and on the stack at all (total). */
export function functionTimes(result: ProfileResult): FunctionTime[] {
	const times = new Map<string, FunctionTime>();
	const get = (name: string) => {
		let t = times.get(name);
		if (!t) {
			t = { name, self: 0, total: 0 };
			times.set(name, t);
		}
		return t;
	};
	for (const { s, n } of result.samples) {
		const frames = s.split(';');
		get(frames[frames.length - 1]).self += n;
		for (const f of new Set(frames)) {
			get(f).total += n;
		}
	}
	return [...times.values()].sort((a, b) => b.self - a.self || b.total - a.total);
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}

/** The profile as a page: the busiest functions and a flame graph of the stacks. */
export function profileHtml(webview: vscode.Webview, result: ProfileResult): string {
	const nonce = Math.random().toString(36).slice(2);
	const top = functionTimes(result).slice(0, 60);
	const pct = (n: number) => (result.total ? `${((100 * n) / result.total).toFixed(1)}%` : '0%');
	const rows = top.map((t) => `<tr><td class="num">${pct(t.self)}</td><td class="num">${pct(t.total)}</td><td>${escapeHtml(t.name)}</td></tr>`).join('');
	const data = JSON.stringify(result.samples).replace(/</g, '\\u003c');
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 24px; }
h2 { font-size: 1.1em; margin: 18px 0 6px; }
table { border-collapse: collapse; width: 100%; }
td, th { padding: 2px 8px; text-align: left; border-bottom: 1px solid var(--vscode-editorWidget-border, #8884); font-family: var(--vscode-editor-font-family); font-size: 12px; }
th { font-weight: 600; }
.num { text-align: right; width: 5em; white-space: nowrap; }
#flame { position: relative; width: 100%; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.f { position: absolute; height: 17px; line-height: 17px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; box-sizing: border-box; padding: 0 3px; border: 1px solid var(--vscode-editor-background); cursor: pointer; color: #000; }
.f:hover { filter: brightness(1.15); }
.muted { opacity: .7; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; }
</style></head><body>
<p class="muted">${result.total} samples in ${result.seconds.toFixed(1)} s (one every ${result.interval} Lua instructions). Only Lua code is sampled; time in the game's own code between script calls does not show.</p>
<h2>Flame graph</h2>
<p class="muted">Outermost calls at the top; width is the share of samples. Click a block to zoom, <button id="reset">reset</button></p>
<div id="flame"></div>
<h2>Busiest functions</h2>
<table><tr><th class="num">self</th><th class="num">total</th><th>function (file:line where it is defined)</th></tr>${rows}</table>
<script nonce="${nonce}">
const samples = ${data};
const root = { name: 'all', value: 0, children: new Map() };
for (const { s, n } of samples) {
	root.value += n;
	let node = root;
	for (const frame of s.split(';')) {
		let child = node.children.get(frame);
		if (!child) { child = { name: frame, value: 0, children: new Map() }; node.children.set(frame, child); }
		child.value += n;
		node = child;
	}
}
const flame = document.getElementById('flame');
function color(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return 'hsl(' + (20 + h % 40) + ', 80%, ' + (55 + h % 15) + '%)';
}
function render(focus) {
	flame.textContent = '';
	let depth = 0;
	function draw(node, x, width, level) {
		if (width < 0.002) return;
		depth = Math.max(depth, level);
		const div = document.createElement('div');
		div.className = 'f';
		div.style.left = (x * 100) + '%';
		div.style.width = (width * 100) + '%';
		div.style.top = (level * 18) + 'px';
		div.style.background = color(node.name);
		div.textContent = node.name;
		div.title = node.name + ' — ' + node.value + ' samples (' + (100 * node.value / root.value).toFixed(1) + '%)';
		div.onclick = () => render(node);
		flame.appendChild(div);
		let cx = x;
		for (const child of [...node.children.values()].sort((a, b) => b.value - a.value)) {
			const w = width * child.value / node.value;
			draw(child, cx, w, level + 1);
			cx += w;
		}
	}
	draw(focus, 0, 1, 0);
	flame.style.height = ((depth + 1) * 18) + 'px';
}
document.getElementById('reset').onclick = () => render(root);
render(root);
</script></body></html>`;
}

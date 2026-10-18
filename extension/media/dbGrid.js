// The DB table grid, shared by the Game Database viewer ("view" mode: an
// effective table, read-only) and the DB file editor ("edit" mode: one table
// fragment). The extension owns the data: edits are posted to it, and it sends
// the rows back.
// @ts-check
(function () {
	// eslint-disable-next-line no-undef
	const vscode = acquireVsCodeApi();
	const ROW = 23, OVERSCAN = 20;

	/** @type {any} */
	let data;
	/** @type {any[]} */
	let view = [];
	let sortCol = -1, sortDir = 1;
	/** @type {string[]} */
	let colFilters = [];
	/** @type {number[]} column order: key columns first */
	let order = [];
	/** Selected rows (model indices) and the anchor for shift-select. */
	const selected = new Set();
	let anchor = -1;
	/** The focused cell (model row index, column). */
	let focus = { row: -1, col: -1 };
	/** @type {{ row: number, col: number } | undefined} */
	let editing;
	/** table -> Set of keys, for reference columns (marks unknown values). */
	const refKeys = new Map();
	/** "table|lookup" -> { options: {key, label}[] } or { error }: the choices of a reference column. */
	const refOptions = new Map();
	const requested = new Set();
	/** Redraws the open dropdown when its options arrive. */
	/** @type {(() => void) | undefined} */
	let onOptions;
	const optionsKey = (/** @type {any} */ c) => c.refTable + '|' + (c.lookup || []).join(',');

	const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
	const scroll = $('scroll');
	const thead = /** @type {HTMLElement} */ (document.querySelector('thead'));
	const tbody = /** @type {HTMLElement} */ (document.querySelector('tbody'));
	const editMode = () => data && data.mode === 'edit' && !data.readOnly;

	function text(/** @type {any} */ v) {
		return v === null || v === undefined ? '' : typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 10000) / 10000) : String(v);
	}
	function esc(/** @type {string} */ s) {
		return s.replace(/[&<>"]/g, (c) => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	}
	const isBool = (/** @type {any} */ c) => c.fieldType === 'Boolean';
	const isInt = (/** @type {any} */ c) => /I16|I32|I64/.test(c.fieldType);
	const isFloat = (/** @type {any} */ c) => /F32|F64/.test(c.fieldType);
	const editable = (/** @type {any} */ c) => !/^Sequence/.test(c.fieldType);

	/** Parses typed text for a column; undefined when invalid (mirrors dbTableModel.parseValue). */
	function parse(/** @type {any} */ c, /** @type {string} */ t) {
		const s = t.trim();
		if (isBool(c)) return /^(true|1|yes)$/i.test(s) ? true : /^(false|0|no|)$/i.test(s) ? false : undefined;
		if (isInt(c)) return /^-?\d+$/.test(s) ? Number(s) : undefined;
		if (isFloat(c)) return s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined;
		return t;
	}

	function sideColumn() {
		if (data.mode === 'edit') return 'effect';
		return /** @type {HTMLInputElement} */ ($('showSource')).checked ? 'source' : '';
	}

	function header() {
		order = data.columns.map((/** @type {any} */ _c, /** @type {number} */ i) => i)
			.sort((/** @type {number} */ a, /** @type {number} */ b) => (data.columns[b].isKey - data.columns[a].isKey) || a - b);
		const side = sideColumn();
		const names = order.map((i) => {
			const c = data.columns[i];
			const arrow = sortCol === i ? (sortDir > 0 ? ' ▲' : ' ▼') : '';
			const title = esc(c.fieldType + (c.refTable ? ' → ' + c.refTable + '.' + c.refColumn : '') + (c.description ? '\n' + c.description : ''));
			return '<th data-col="' + i + '" title="' + title + '"' + (c.isKey ? ' class="key"' : '') + '>' + esc(c.name) + arrow + '</th>';
		}).join('') + (side ? '<th data-col="-2">' + side + '</th>' : '');
		const filters = order.map((i) => '<th' + (data.columns[i].isKey ? ' class="key"' : '') + '><input data-col="' + i + '" value="' + esc(colFilters[i] || '') + '" placeholder="filter"></th>').join('')
			+ (side ? '<th></th>' : '');
		thead.innerHTML = '<tr class="names">' + names + '</tr><tr class="filters">' + filters + '</tr>';
	}

	function effectText(/** @type {any} */ e) {
		if (!e) return '';
		const where = e.other ? e.other.pack + '/' + e.other.path : '';
		switch (e.kind) {
			case 'new': return 'new row';
			case 'wins': return 'overrides ' + where;
			case 'loses': return 'loses to ' + where;
			case 'duplicate': return 'duplicate key: an earlier row wins';
		}
		return '';
	}

	function apply() {
		const f = /** @type {HTMLInputElement} */ ($('filter')).value.toLowerCase();
		const only = data.mode === 'view' && /** @type {HTMLInputElement} */ ($('onlyOverridden')).checked;
		view = data.rows.filter((/** @type {any} */ r) => {
			if (only && !r.overridden.length) return false;
			if (f && !r.values.some((/** @type {any} */ v) => text(v).toLowerCase().includes(f)) && !(r.source || '').toLowerCase().includes(f)) return false;
			for (const i in colFilters) {
				const cf = colFilters[i];
				if (cf && !text(r.values[i]).toLowerCase().includes(cf)) return false;
			}
			return true;
		});
		if (sortCol >= 0) {
			view.sort((a, b) => {
				const x = a.values[sortCol], y = b.values[sortCol];
				return (typeof x === 'number' && typeof y === 'number' ? x - y : text(x).localeCompare(text(y))) * sortDir;
			});
		}
		const info = view.length + ' of ' + data.rows.length + ' rows, ' + data.columns.length + ' columns';
		$('info').textContent = data.mode === 'view' ? info + ', ' + data.fragments.length + ' fragment(s)' : info + (data.version !== undefined ? ', version ' + data.version : '');
		$('info').title = data.mode === 'view' ? 'Fragments in load order (the first one with a key wins):\n' + data.fragments.join('\n') : '';
		render(true);
	}

	function cellHtml(/** @type {any} */ r, /** @type {number} */ i) {
		const c = data.columns[i], v = r.values[i];
		const cls = [c.isKey ? 'key' : '', typeof v === 'number' ? 'num' : '', c.refTable && v ? 'ref' : ''];
		let title = text(v);
		if (c.refTable && v) {
			cls.push('link');
			const keys = refKeys.get(c.refTable);
			if (editMode() && keys && !keys.has(text(v))) {
				cls.push('unknown');
				title += '\n(not a key of ' + c.refTable + ')';
			}
		}
		const e = data.effects && data.effects[r.index];
		if (e && e.changed && e.changed[i] !== undefined) {
			cls.push('changed');
			title += '\nwas ' + e.changed[i] + ' in ' + e.other.pack + '/' + e.other.path;
		}
		if (focus.row === r.index && focus.col === i) cls.push('focused');
		const c2 = cls.filter(Boolean).join(' ');
		return '<td data-col="' + i + '"' + (c2 ? ' class="' + c2 + '"' : '') + ' title="' + esc(title) + '">' + esc(text(v)) + '</td>';
	}

	function render(/** @type {boolean} */ reset) {
		if (editing) return; // keep the input; rendered again when the edit ends
		if (reset) scroll.scrollTop = Math.min(scroll.scrollTop, view.length * ROW);
		const first = Math.max(0, Math.floor(scroll.scrollTop / ROW) - OVERSCAN);
		const last = Math.min(view.length, Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW) + OVERSCAN);
		const side = sideColumn();
		const cols = order.length + (side ? 1 : 0);
		// Spacer rows stand in for the rows outside the viewport (heights set below: CSP forbids inline styles).
		const spacer = (/** @type {number} */ n) => '<tr class="spacer" data-h="' + n * ROW + '"><td colspan="' + cols + '"></td></tr>';
		let html = first ? spacer(first) : '';
		for (let p = first; p < last; p++) {
			const r = view[p];
			const cls = [r.overridden && r.overridden.length ? 'over' : '', selected.has(r.index) ? 'selected' : ''].filter(Boolean).join(' ');
			html += '<tr data-pos="' + p + '"' + (cls ? ' class="' + cls + '"' : '') + '>';
			for (const i of order) html += cellHtml(r, i);
			if (side === 'source') {
				const t = r.overridden.length ? r.source + ' (overrides ' + r.overridden.join(', ') + ')' : r.source;
				html += '<td class="src" title="' + esc(t) + '">' + esc(t) + '</td>';
			} else if (side === 'effect') {
				const e = data.effects && data.effects[r.index];
				const t = effectText(e);
				html += '<td class="effect ' + (e ? e.kind : '') + '" title="' + esc(t) + '">' + esc(t) + '</td>';
			}
			html += '</tr>';
		}
		if (last < view.length) html += spacer(view.length - last);
		tbody.innerHTML = html;
		tbody.querySelectorAll('tr.spacer').forEach((tr) => { /** @type {HTMLElement} */ (tr).style.height = /** @type {HTMLElement} */ (tr).dataset.h + 'px'; });
		updateButtons();
	}

	/** Updates the selected rows and focused cell in place. */
	function refreshSelection() {
		for (const tr of tbody.querySelectorAll('tr[data-pos]')) {
			const r = view[Number(/** @type {HTMLElement} */ (tr).dataset.pos)];
			tr.classList.toggle('selected', selected.has(r.index));
			for (const td of tr.querySelectorAll('td[data-col]')) {
				td.classList.toggle('focused', focus.row === r.index && focus.col === Number(/** @type {HTMLElement} */ (td).dataset.col));
			}
		}
		updateButtons();
	}

	function updateButtons() {
		if (data.mode !== 'edit') return;
		const ro = !editMode();
		for (const id of ['add', 'import']) /** @type {HTMLButtonElement} */ ($(id)).disabled = ro;
		for (const id of ['duplicate', 'delete']) /** @type {HTMLButtonElement} */ ($(id)).disabled = ro || selected.size === 0;
	}

	function rowAt(/** @type {Element} */ el) {
		const tr = el.closest('tr[data-pos]');
		return tr ? view[Number(/** @type {HTMLElement} */ (tr).dataset.pos)] : undefined;
	}

	/** Asks the extension for the choices of a reference column (once). */
	function needOptions(/** @type {any} */ c) {
		const k = optionsKey(c);
		if (!refOptions.has(k) && !requested.has(k)) {
			requested.add(k);
			vscode.postMessage({ type: 'refKeys', table: c.refTable, lookup: c.lookup });
		}
	}

	/**
	 * A list of choices under a cell being edited: the referenced table's keys
	 * (with their lookup text), filtered by what is typed.
	 */
	function dropdown(/** @type {any} */ c, /** @type {HTMLInputElement} */ input, /** @type {Element} */ td, /** @type {(v: string) => void} */ choose) {
		const box = document.createElement('div');
		box.className = 'options';
		document.body.appendChild(box);
		let active = -1;
		/** Filter only once something is typed: at first, show every choice with the current one active. */
		let typed = false;
		let scrolled = false;
		/** @type {{key: string, label: string}[]} */
		let shown = [];
		const place = () => {
			const r = td.getBoundingClientRect();
			box.style.left = r.left + 'px';
			box.style.minWidth = Math.max(r.width, 260) + 'px';
			const below = window.innerHeight - r.bottom;
			if (below < 160 && r.top > below) {
				box.style.top = '';
				box.style.bottom = (window.innerHeight - r.top) + 'px';
				box.style.maxHeight = Math.min(300, r.top - 8) + 'px';
			} else {
				box.style.bottom = '';
				box.style.top = r.bottom + 'px';
				box.style.maxHeight = Math.min(300, below - 8) + 'px';
			}
		};
		const draw = () => {
			const entry = refOptions.get(optionsKey(c));
			if (!entry) {
				box.innerHTML = '<div class="note">Loading the keys of ' + esc(c.refTable) + '…</div>';
				shown = [];
			} else if (entry.error) {
				box.innerHTML = '<div class="note">No choices: ' + esc(entry.error) + '</div>';
				shown = [];
			} else {
				const q = typed ? input.value.toLowerCase() : '';
				const matching = q ? entry.options.filter((/** @type {any} */ o) => o.key.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) : entry.options;
				// Unfiltered, keep the current value in the list even when it is far down.
				const limit = q ? 200 : Math.max(200, matching.findIndex((/** @type {any} */ o) => o.key === input.value) + 50);
				shown = matching.slice(0, limit);
				const more = matching.length - shown.length;
				if (!typed && active < 0) active = shown.findIndex((o) => o.key === input.value);
				active = Math.min(active, shown.length - 1);
				box.innerHTML = shown.map((o, i) => '<div class="option' + (i === active ? ' active' : '') + (o.key === input.value ? ' current' : '') + '" data-i="' + i + '">'
					+ '<span class="okey">' + esc(o.key) + '</span>' + (o.label ? '<span class="olabel">' + esc(o.label) + '</span>' : '') + '</div>').join('')
					+ (shown.length ? '' : '<div class="note">No keys of ' + esc(c.refTable) + ' match</div>')
					+ (more > 0 ? '<div class="note">' + more + ' more: type to narrow down</div>' : '');
			}
			place();
			if (!scrolled && active >= 0) {
				scrolled = true;
				const el = box.querySelector('.option.active');
				if (el) el.scrollIntoView({ block: 'center' });
			}
		};
		const scrollToActive = () => {
			const el = box.querySelector('.option.active');
			if (el) el.scrollIntoView({ block: 'nearest' });
		};
		box.addEventListener('mousedown', (e) => {
			// Keep the focus in the input; pick on mouse down.
			e.preventDefault();
			const el = /** @type {HTMLElement} */ (e.target).closest('.option');
			if (el) choose(shown[Number(/** @type {HTMLElement} */ (el).dataset.i)].key);
		});
		input.addEventListener('input', () => { typed = true; active = -1; draw(); });
		onOptions = draw;
		draw();
		return {
			/** Handles a key; true when it was used to move or pick. */
			key(/** @type {KeyboardEvent} */ e) {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					if (shown.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
					draw();
					scrollToActive();
					return true;
				}
				if (e.key === 'Enter' && active >= 0 && shown[active]) {
					choose(shown[active].key);
					return true;
				}
				return false;
			},
			close() {
				onOptions = undefined;
				box.remove();
			},
		};
	}

	// ---- editing ------------------------------------------------------------

	function startEdit(/** @type {number} */ index, /** @type {number} */ col) {
		const c = data.columns[col];
		if (!editMode() || !editable(c)) return;
		const r = data.rows.find((/** @type {any} */ x) => x.index === index);
		if (isBool(c)) {
			post({ type: 'set', row: index, col, value: !r.values[col] });
			return;
		}
		const tr = [...tbody.querySelectorAll('tr[data-pos]')].find((t) => view[Number(/** @type {HTMLElement} */ (t).dataset.pos)].index === index);
		const td = tr && tr.querySelector('td[data-col="' + col + '"]');
		if (!td) return;
		editing = { row: index, col };
		td.classList.add('editing');
		const input = document.createElement('input');
		input.value = text(r.values[col]);
		td.textContent = '';
		td.appendChild(input);
		input.focus();
		input.select();
		let done = false;
		/** @type {ReturnType<typeof dropdown> | undefined} */
		let list;
		const finish = (/** @type {boolean} */ commit, /** @type {number} */ move) => {
			if (done) return;
			const value = parse(c, input.value);
			if (commit && value === undefined) {
				input.classList.add('invalid');
				input.title = 'Not a valid ' + c.fieldType;
				return;
			}
			done = true;
			editing = undefined;
			if (list) list.close();
			if (commit && value !== r.values[col]) post({ type: 'set', row: index, col, value });
			const next = move ? order[order.indexOf(col) + move] : undefined;
			render(false);
			scroll.focus();
			if (next !== undefined) {
				focus = { row: index, col: next };
				startEdit(index, next);
			}
		};
		if (c.refTable) {
			needOptions(c);
			list = dropdown(c, input, td, (v) => { input.value = v; finish(true, 0); });
		}
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (list && list.key(e)) return;
			if (e.key === 'Enter') finish(true, 0);
			else if (e.key === 'Escape') finish(false, 0);
			else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
		});
		input.addEventListener('input', () => input.classList.toggle('invalid', parse(c, input.value) === undefined));
		input.addEventListener('blur', () => finish(true, 0));
	}

	function post(/** @type {any} */ edit) {
		vscode.postMessage({ type: 'edit', edit });
	}

	// ---- events ---------------------------------------------------------------

	scroll.addEventListener('scroll', () => requestAnimationFrame(() => render(false)));
	window.addEventListener('resize', () => render(false));
	$('filter').addEventListener('input', apply);
	$('onlyOverridden').addEventListener('change', apply);
	$('showSource').addEventListener('change', () => { header(); render(false); });
	thead.addEventListener('click', (e) => {
		const th = /** @type {HTMLElement} */ (e.target).closest('tr.names th');
		if (!th) return;
		const col = Number(/** @type {HTMLElement} */ (th).dataset.col);
		if (col < 0) return;
		sortDir = sortCol === col ? -sortDir : 1;
		sortCol = col;
		header();
		apply();
	});
	thead.addEventListener('input', (e) => {
		const t = /** @type {HTMLInputElement} */ (e.target);
		const col = t.dataset && t.dataset.col;
		if (col === undefined) return;
		colFilters[Number(col)] = t.value.toLowerCase();
		apply();
	});
	tbody.addEventListener('click', (e) => {
		const target = /** @type {HTMLElement} */ (e.target);
		const td = target.closest('td[data-col]');
		const r = rowAt(target);
		if (!td || !r) return;
		const col = Number(/** @type {HTMLElement} */ (td).dataset.col);
		const c = data.columns[col];
		// Ctrl+click (or a click in the viewer) on a reference opens the row it points to.
		if (c.refTable && r.values[col] && (data.mode === 'view' || e.ctrlKey || e.metaKey)) {
			vscode.postMessage({ type: 'open', table: c.refTable, key: text(r.values[col]) });
			return;
		}
		if (e.shiftKey && anchor >= 0) {
			const a = view.findIndex((x) => x.index === anchor), b = view.indexOf(r);
			selected.clear();
			for (let p = Math.min(a, b); p <= Math.max(a, b); p++) selected.add(view[p].index);
		} else if (e.ctrlKey || e.metaKey) {
			if (selected.has(r.index)) selected.delete(r.index); else selected.add(r.index);
			anchor = r.index;
		} else {
			selected.clear();
			selected.add(r.index);
			anchor = r.index;
		}
		focus = { row: r.index, col };
		// Only restyle: rebuilding the rows here would replace the cell between
		// the two clicks of a double-click, and the dblclick would go to a cell
		// no longer in the table.
		refreshSelection();
		scroll.focus();
	});
	tbody.addEventListener('dblclick', (e) => {
		const target = /** @type {HTMLElement} */ (e.target);
		const td = target.closest('td[data-col]');
		const r = rowAt(target);
		if (td && r) startEdit(r.index, Number(/** @type {HTMLElement} */ (td).dataset.col));
	});
	scroll.addEventListener('keydown', (e) => {
		if (!editMode() || editing) return;
		if ((e.key === 'Enter' || e.key === 'F2') && focus.row >= 0) {
			e.preventDefault();
			startEdit(focus.row, focus.col);
		} else if (e.key === 'Delete' && selected.size) {
			e.preventDefault();
			vscode.postMessage({ type: 'delete', indices: [...selected] });
		}
	});
	$('add').addEventListener('click', () => vscode.postMessage({ type: 'add', after: selected.size ? Math.max(...selected) : -1 }));
	$('duplicate').addEventListener('click', () => vscode.postMessage({ type: 'duplicate', indices: [...selected] }));
	$('delete').addEventListener('click', () => vscode.postMessage({ type: 'delete', indices: [...selected] }));
	$('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
	$('updateSchema').addEventListener('click', () => vscode.postMessage({ type: 'updateSchema' }));

	/** Rows as the grid keeps them: model index plus the row data. */
	function withIndex(/** @type {any[]} */ rows) {
		return rows.map((r, index) => (Array.isArray(r) ? { index, values: r } : { index, ...r }));
	}

	window.addEventListener('message', (e) => {
		const msg = e.data;
		switch (msg.type) {
			case 'error':
				$('info').textContent = '';
				$('errors').textContent = msg.message;
				$('updateSchema').classList.toggle('hidden', !msg.schema);
				return;
			case 'init': {
				data = { ...msg, rows: withIndex(msg.rows) };
				const edit = data.mode === 'edit';
				for (const el of document.querySelectorAll('.view-only')) el.classList.toggle('hidden', edit);
				for (const el of document.querySelectorAll('.edit-only')) el.classList.toggle('hidden', !edit || data.readOnly);
				$('errors').textContent = (data.errors || []).join('\n');
				$('banner').textContent = data.banner || '';
				$('banner').classList.toggle('hidden', !data.banner);
				$('updateSchema').classList.toggle('hidden', !data.schemaProblem);
				colFilters = [];
				selected.clear();
				header();
				if (edit) {
					// Reference keys are needed to mark unknown values.
					for (const c of data.columns) if (c.refTable) needOptions(c);
				}
				break;
			}
			case 'rows':
				data.rows = withIndex(msg.rows);
				data.effects = msg.effects;
				for (const i of [...selected]) if (i >= data.rows.length) selected.delete(i);
				if (msg.select) {
					selected.clear();
					for (const i of msg.select) selected.add(i);
				}
				break;
			case 'effects':
				data.effects = msg.effects;
				render(false);
				return;
			case 'refKeys': {
				refOptions.set(optionsKey({ refTable: msg.table, lookup: msg.lookup }), msg.error ? { error: msg.error } : { options: msg.options });
				if (msg.options) refKeys.set(msg.table, new Set(msg.options.map((/** @type {any} */ o) => o.key)));
				if (onOptions) onOptions();
				render(false);
				return;
			}
		}
		if (msg.filter !== undefined) /** @type {HTMLInputElement} */ ($('filter')).value = msg.filter;
		if (data) apply();
	});
	vscode.postMessage({ type: 'ready' });
})();

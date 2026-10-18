/**
 * LuaLS (`---@meta`) stubs for the game's script library, generated from CA's
 * own documentation comments in the game's Lua files:
 *
 *     --- @c campaign_manager Campaign Manager
 *     --- @a cm
 *     --- @function add_listener
 *     --- @desc Adds a listener ...
 *     --- @p string listener name
 *     --- @p [opt=false] boolean persistent
 *     --- @r boolean success
 *     --- @example cm:add_listener(...)
 *     function campaign_manager:add_listener(name, event, ...)
 *
 * The declaration after a doc block decides where the function lives
 * (`a:b` method, `a.b` field, or a global); the comments give the types and
 * descriptions. Without a declaration the block belongs to the current `@c`.
 */

export interface LuaSource {
	/** Path inside the packs, e.g. `script/_lib/lib_core.lua`. */
	path: string;
	text: string;
}

interface Param {
	name: string;
	type: string;
	optional: boolean;
	defaultValue?: string;
	desc: string;
}

interface Func {
	owner?: string;
	/** `:` for methods, `.` for fields of a table. */
	sep: ':' | '.';
	name: string;
	params: Param[];
	returns: { type: string; desc: string }[];
	desc: string[];
	examples: string[];
	source: string;
}

interface ClassDoc {
	name: string;
	title: string;
	aliases: string[];
	desc: string[];
	local: boolean;
}

/** Instances the script libraries create as globals, beyond `@a` aliases. */
const KNOWN_INSTANCES: Record<string, string> = {
	core: 'core_object',
	cm: 'campaign_manager',
	bm: 'battle_manager',
};

const BUILTIN_TYPES = new Set(['nil', 'any', 'boolean', 'string', 'number', 'integer', 'function', 'table', 'thread', 'userdata', 'lightuserdata']);
const TYPE_ALIASES: Record<string, string> = { bool: 'boolean', object: 'any', value: 'any', int: 'integer', float: 'number', func: 'function', str: 'string' };
const LUA_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

/** CA's HTML-ish doc text as Markdown. */
export function docToMarkdown(text: string): string {
	return text
		.replace(/<code>(.*?)<\/code>/gis, '`$1`')
		.replace(/<\/?(strong|b)>/gi, '**')
		.replace(/<\/?(em|i)>/gi, '*')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li>/gi, '\n- ')
		.replace(/<\/?(ul|ol|li|p|span|div|table|tr|td|th)[^>]*>/gi, ' ')
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
		// "@campaign_manager:foo" / "@string" links in CA's doc system
		.replace(/@([A-Za-z_][\w]*(?:[:.][A-Za-z_]\w*)?)/g, '`$1`')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** A doc type (`@string`, `string`, `faction`, `table of strings`) as a LuaLS type. */
export function luaType(raw: string, knownClasses?: Set<string>): string {
	const t = raw.replace(/^@/, '').trim();
	if (!t) {
		return 'any';
	}
	const lower = t.toLowerCase();
	if (TYPE_ALIASES[lower]) {
		return TYPE_ALIASES[lower];
	}
	if (BUILTIN_TYPES.has(lower)) {
		return lower;
	}
	if (/^[A-Za-z_]\w*$/.test(t)) {
		knownClasses?.add(t);
		return t;
	}
	return 'any';
}

function cleanName(raw: string, index: number): string {
	const n = raw.trim();
	if (n === '...') {
		return n;
	}
	if (/^[A-Za-z_]\w*$/.test(n) && !LUA_KEYWORDS.has(n)) {
		return n;
	}
	return `arg${index + 1}`;
}

/** `--- @p [opt=false] @boolean persistent flag` */
function parseParam(line: string, index: number): Param {
	let rest = line.trim();
	let optional = false;
	let defaultValue: string | undefined;
	const opt = /^\[opt(?:=((?:"[^"]*"|[^\]])*))?\]\s*/.exec(rest);
	if (opt) {
		optional = true;
		defaultValue = opt[1];
		rest = rest.slice(opt[0].length);
	}
	if (rest.startsWith('...')) {
		return { name: '...', type: 'any', optional: true, desc: docToMarkdown(rest.slice(3)) };
	}
	const [type = '', ...words] = rest.split(/\s+/);
	const desc = words.join(' ');
	// Without a declaration, name the parameter after its description.
	const guess = desc.split(/[,.(]/)[0].trim().replace(/\s+/g, '_').toLowerCase();
	return { name: cleanName(guess, index), type, optional, defaultValue, desc: docToMarkdown(desc) };
}

const DECL = /^\s*(?:local\s+)?function\s+([A-Za-z_][\w]*)(?:([:.])([A-Za-z_]\w*))?\s*\(([^)]*)\)/;
const DECL_ASSIGN = /^\s*([A-Za-z_][\w]*)([:.])([A-Za-z_]\w*)\s*=\s*function\s*\(([^)]*)\)/;

interface Parsed {
	classes: ClassDoc[];
	funcs: Func[];
	types: Set<string>;
}

function parseFile(src: LuaSource, out: Parsed): void {
	const lines = src.text.split(/\r?\n/);
	let current: ClassDoc | undefined;
	let block: { tag: string; text: string }[] = [];

	const flush = (declLine: string | undefined) => {
		const fnTag = block.find((b) => b.tag === 'function');
		if (fnTag) {
			const fn = makeFunc(block, declLine, current, src.path, out.types);
			if (fn) {
				out.funcs.push(fn);
			}
		}
		block = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const tag = /^\s*---\s*@(\w+)\s?(.*)$/.exec(line);
		if (tag) {
			const [, name, text] = tag;
			if (name === 'c' || name === 'data_interface') {
				flush(undefined);
				const [cls = '', ...title] = text.trim().split(/\s+/);
				if (/^[A-Za-z_]\w*$/.test(cls) && !BUILTIN_TYPES.has(cls)) {
					current = {
						name: cls,
						title: title.join(' '),
						aliases: [],
						desc: [],
						local: new RegExp(`^local\\s+${cls}\\s*=`, 'm').test(src.text),
					};
					out.classes.push(current);
				} else {
					current = undefined;
				}
				continue;
			}
			if (name === 'end_class') {
				flush(undefined);
				current = undefined;
				continue;
			}
			if (name === 'a' && current) {
				current.aliases.push(text.trim());
				continue;
			}
			if (name === 'function' && block.some((b) => b.tag === 'function')) {
				flush(undefined);
			}
			if (name === 'desc' && current && !block.length) {
				current.desc.push(docToMarkdown(text));
				continue;
			}
			if (name === 'section') {
				flush(undefined);
				continue;
			}
			block.push({ tag: name, text });
			continue;
		}
		if (!block.length) {
			continue;
		}
		if (/^\s*$/.test(line) || /^\s*--/.test(line)) {
			// a doc block may be followed by blank lines or plain comments before the declaration
			continue;
		}
		flush(DECL.test(line) || DECL_ASSIGN.test(line) ? line : undefined);
	}
	flush(undefined);
}

function makeFunc(block: { tag: string; text: string }[], declLine: string | undefined, current: ClassDoc | undefined, source: string, types: Set<string>): Func | undefined {
	const fnName = block.find((b) => b.tag === 'function')!.text.trim().split(/\s+/)[0];
	let owner = current?.name;
	let sep: ':' | '.' = ':';
	let name = fnName;
	let declParams: string[] | undefined;
	const m = declLine ? (DECL.exec(declLine) ?? DECL_ASSIGN.exec(declLine)) : null;
	if (m) {
		if (m[2]) {
			owner = m[1];
			sep = m[2] as ':' | '.';
			name = m[3];
		} else {
			owner = undefined;
			name = m[1];
		}
		declParams = m[4].split(',').map((p) => p.trim()).filter(Boolean);
	}
	if (!/^[A-Za-z_]\w*$/.test(name)) {
		return undefined;
	}

	const docParams = block.filter((b) => b.tag === 'p' || b.tag === 'param');
	const params: Param[] = [];
	const count = Math.max(declParams?.length ?? 0, docParams.length);
	for (let i = 0; i < count; i++) {
		const doc = docParams[i];
		let p: Param;
		if (doc?.tag === 'param') {
			// EmmyLua style: name type description
			const [pname = '', ptype = '', ...rest] = doc.text.trim().split(/\s+/);
			p = { name: cleanName(pname, i), type: ptype, optional: false, desc: docToMarkdown(rest.join(' ')) };
		} else if (doc) {
			p = parseParam(doc.text, i);
		} else {
			p = { name: '', type: 'any', optional: false, desc: '' };
		}
		const declared = declParams?.[i];
		if (declared) {
			p.name = cleanName(declared, i);
			if (declared === '...') {
				p.optional = true;
			}
		} else if (declParams && !docParams[i]) {
			continue;
		}
		if (!p.name) {
			p.name = `arg${i + 1}`;
		}
		p.type = p.name === '...' && !doc ? 'any' : luaType(p.type, types);
		params.push(p);
	}
	// A doc may describe more parameters than the declaration has (varargs in disguise): keep the declaration's.
	if (declParams && params.length > declParams.length && !declParams.includes('...')) {
		params.length = declParams.length;
	}
	// `function f(...)` documented with named parameters: name them, and keep `...` last.
	const varargs = params.filter((p) => p.name === '...');
	if (varargs.length > 1 || (varargs.length === 1 && params[params.length - 1].name !== '...')) {
		const named: Param[] = [];
		params.forEach((p, i) => {
			if (p.name !== '...') {
				named.push(p);
				return;
			}
			const doc = docParams[i];
			if (doc?.tag === 'p' && !doc.text.trim().replace(/^\[opt[^\]]*\]\s*/, '').startsWith('...')) {
				const n = parseParam(doc.text, i);
				n.type = luaType(n.type, types);
				named.push(n);
			}
		});
		const doc = varargs.find((v) => v.desc);
		params.splice(0, params.length, ...named, { name: '...', type: 'any', optional: true, desc: doc?.desc ?? '' });
	}

	const returns = block.filter((b) => b.tag === 'r' || b.tag === 'return').map((b) => {
		const [type = '', ...words] = b.text.trim().split(/\s+/);
		return { type: luaType(type, types), desc: docToMarkdown(words.join(' ')) };
	});

	const examples: string[] = [];
	let ex: string[] = [];
	for (const b of block) {
		if (b.tag === 'example') {
			ex.push(b.text.replace(/\s+$/, ''));
		} else if (ex.length) {
			examples.push(ex.join('\n'));
			ex = [];
		}
	}
	if (ex.length) {
		examples.push(ex.join('\n'));
	}

	return {
		owner,
		sep,
		name,
		params,
		returns,
		desc: block.filter((b) => b.tag === 'desc' || b.tag === 'p_long_desc').map((b) => docToMarkdown(b.text)).filter(Boolean),
		examples: examples.map((e) => docToMarkdown(e.replace(/<i>|<\/i>/g, ''))),
		source,
	};
}

function comment(text: string): string {
	return text.split('\n').map((l) => `--- ${l}`.trimEnd()).join('\n');
}

function renderFunc(f: Func): string {
	const out: string[] = [];
	if (f.desc.length) {
		out.push(comment(f.desc.join('\n\n')));
	}
	for (const e of f.examples) {
		out.push(comment('```lua\n' + e + '\n```'));
	}
	out.push(`--- *${f.source}*`);
	for (const p of f.params) {
		if (p.name === '...') {
			out.push(`---@param ... ${p.type}${p.desc ? ` ${p.desc}` : ''}`);
			continue;
		}
		const def = p.defaultValue !== undefined && p.defaultValue !== 'nil' ? ` (default ${p.defaultValue})` : '';
		out.push(`---@param ${p.name}${p.optional ? '?' : ''} ${p.type}${p.desc || def ? ` ${p.desc}${def}` : ''}`);
	}
	for (const r of f.returns) {
		out.push(`---@return ${r.type}${r.desc ? ` # ${r.desc}` : ''}`);
	}
	const args = f.params.map((p) => p.name).join(', ');
	out.push(f.owner ? `function ${f.owner}${f.sep}${f.name}(${args}) end` : `function ${f.name}(${args}) end`);
	return out.join('\n');
}

export interface GeneratedStubs {
	/** File name → contents, all `---@meta` files. */
	files: Map<string, string>;
	/** Global names of objects the library creates (`cm`, `core`, ...). */
	globals: string[];
	functionCount: number;
}

/**
 * Stubs for every documented function in `sources`, one file per source file
 * with docs, plus `_types.lua` (classes and instances) and `_events.lua`
 * (event names, from script/events.lua, for `core:add_listener`).
 */
export function generateStubs(sources: LuaSource[]): GeneratedStubs {
	const parsed: Parsed = { classes: [], funcs: [], types: new Set() };
	for (const src of sources) {
		if (src.text.includes('--- @')) {
			parseFile(src, parsed);
		}
	}

	const files = new Map<string, string>();
	const owners = new Set(parsed.funcs.map((f) => f.owner).filter((o): o is string => !!o));
	const classes = new Map<string, ClassDoc>();
	for (const c of parsed.classes) {
		const seen = classes.get(c.name);
		if (seen) {
			seen.aliases.push(...c.aliases);
			seen.desc.push(...c.desc);
		} else {
			classes.set(c.name, c);
		}
	}

	// Classes: each owner table and each documented class, and empty classes for
	// types the docs mention (model interfaces like faction, character, ...).
	const types: string[] = ['---@meta', '-- Generated by Total War Modding Tools from the game\'s script library. Do not edit.', ''];
	const declared = new Set<string>();
	const declare = (name: string, doc?: ClassDoc) => {
		if (declared.has(name) || BUILTIN_TYPES.has(name) || LUA_KEYWORDS.has(name)) {
			return;
		}
		declared.add(name);
		if (doc?.desc.length) {
			types.push(comment(`**${doc.title || name}**\n\n${doc.desc.join('\n\n')}`));
		}
		types.push(`---@class ${name}`);
		types.push(doc?.local || !owners.has(name) ? `local ${name} = {}` : `${name} = {}`);
		types.push('');
	};
	for (const c of classes.values()) {
		declare(c.name, c);
	}
	for (const o of owners) {
		declare(o);
	}
	for (const t of parsed.types) {
		declare(t);
	}

	const globals: string[] = [];
	const instances: Record<string, string> = { ...KNOWN_INSTANCES };
	for (const c of classes.values()) {
		for (const a of c.aliases) {
			// "@a cm" names the instance of the class
			if (/^[A-Za-z_]\w*$/.test(a)) {
				instances[a] = c.name;
			}
		}
	}
	for (const [name, cls] of Object.entries(instances)) {
		if (!declared.has(cls) && !owners.has(cls)) {
			continue;
		}
		types.push(`---@type ${cls}`);
		types.push(`${name} = nil`);
		types.push('');
		globals.push(name);
	}
	files.set('_types.lua', types.join('\n'));

	// Functions, grouped by the file they come from.
	const events = sources.find((s) => /(^|\/)script\/events\.lua$/i.test(s.path.replace(/\\/g, '/')));
	const eventNames = events ? parseEventNames(events.text) : [];

	const bySource = new Map<string, Func[]>();
	// _events.lua declares add_listener with typed event names.
	const seenFn = new Set<string>(['core_object:add_listener']);
	for (const f of parsed.funcs) {
		const key = `${f.owner ?? ''}${f.sep}${f.name}`;
		if (seenFn.has(key)) {
			continue;
		}
		seenFn.add(key);
		const list = bySource.get(f.source) ?? [];
		list.push(f);
		bySource.set(f.source, list);
	}
	for (const [source, funcs] of bySource) {
		const name = source.replace(/^script\//, '').replace(/[\\/]/g, '.');
		const body = ['---@meta', `-- Generated from ${source}. Do not edit.`, '', ...funcs.map((f) => renderFunc(f) + '\n')];
		files.set(name.endsWith('.lua') ? name : `${name}.lua`, body.join('\n'));
	}

	files.set('_events.lua', renderEvents(eventNames));
	files.set('_builtins.lua', BUILTINS);

	return { files, globals, functionCount: seenFn.size };
}

/** Event names from the game's script/events.lua (`AdviceCleared = {}` lines). */
export function parseEventNames(text: string): string[] {
	const names = new Set<string>();
	for (const m of text.matchAll(/^([A-Z][A-Za-z0-9_]*)\s*=\s*\{\s*\}/gm)) {
		names.add(m[1]);
	}
	return [...names].sort();
}

function renderEvents(names: string[]): string {
	const out = ['---@meta', '-- Script events the game triggers (from script/events.lua). Do not edit.', ''];
	out.push('--- The context passed to an event listener. Its methods depend on the event.');
	out.push('---@class TwEventContext');
	out.push('---@field string string? # set by some script events');
	out.push('');
	if (names.length) {
		out.push('---@alias TwEventName');
		for (const n of names) {
			out.push(`---| "${n}"`);
		}
		out.push('');
	} else {
		out.push('---@alias TwEventName string', '');
	}
	out.push('--- Adds a listener for a script event. See the game\'s script library for details.');
	out.push('---@param name string listener name, used to remove it');
	out.push('---@param event TwEventName|string event name');
	out.push('---@param condition (fun(context: TwEventContext): boolean)|true condition, or `true` to always pass');
	out.push('---@param callback fun(context: TwEventContext)');
	out.push('---@param persistent? boolean keep listening after the callback ran');
	out.push('function core_object:add_listener(name, event, condition, callback, persistent) end');
	out.push('');
	return out.join('\n');
}

/** What the game provides from code and the script library leaves undocumented. */
const BUILTINS = `---@meta
-- Game functions the script library does not document. Do not edit.

--- Writes to the script log (and the Debug Console while debugging).
--- \`out.<channel>(text)\` writes to a named channel's log instead.
---@class TwOut
---@overload fun(text: any)
---@field design fun(text: any)
---@field ui fun(text: any)
---@field savegame fun(text: any)
---@field interventions fun(text: any)
---@field invasions fun(text: any)
---@field narrative fun(text: any)
---@field traits fun(text: any)
---@field help_pages fun(text: any)
---@field scripted_tours fun(text: any)
---@field [string] fun(text: any)
---@field inc_tab fun(channel?: string) # indent later output
---@field dec_tab fun(channel?: string) # undo an inc_tab
---@field cache_tab fun(channel?: string)
---@field restore_tab fun(channel?: string)
out = nil

--- Debugger helpers (the Total War Modding Tools debugger mod).
---@class TwDebuggee
---@field print fun(category: "log"|"warning"|"error", ...: any) # print to the Debug Console
---@field breakHere fun(reason?: string) # stop in the debugger here
debuggee = nil
`;

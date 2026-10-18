import * as path from 'node:path';
import * as vscode from 'vscode';

import { CONNECTED_EVENT, SCRIPT_EVENT } from '../adapter/session';
import { DEBUG_TYPE } from '../debugConfig';
import { DbService } from '../db/DbService';
import { chunkNameFor, luaString, matchesName } from './helpers';
import { profileHtml, ProfileResult } from './profileView';

/**
 * The Total War debug session the game is connected to, and its environment
 * (frontend, campaign, battle). Sets the `twdev.gameEnv` context key.
 */
class GameConnection implements vscode.Disposable {
	private session: vscode.DebugSession | undefined;
	private envName: string | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];

	constructor(onScriptEvent: (body: ScriptEventBody) => void) {
		this.disposables.push(
			vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
				if (e.session.type !== DEBUG_TYPE) {
					return;
				}
				if (e.event === CONNECTED_EVENT) {
					this.session = e.session;
					this.envName = String(e.body?.env ?? 'unknown');
					void vscode.commands.executeCommand('setContext', 'twdev.gameEnv', this.envName);
					this.changed.fire();
				} else if (e.event === SCRIPT_EVENT) {
					onScriptEvent(e.body as ScriptEventBody);
				}
			}),
			vscode.debug.onDidTerminateDebugSession((s) => {
				if (s === this.session) {
					this.session = undefined;
					this.envName = undefined;
					void vscode.commands.executeCommand('setContext', 'twdev.gameEnv', undefined);
					this.changed.fire();
				}
			}),
		);
	}

	get env(): string | undefined {
		return this.envName;
	}

	/** Sends a custom request to the game; throws when no game is connected. */
	async request<T>(command: string, args: unknown = {}): Promise<T> {
		if (!this.session) {
			throw new Error('No game is connected. Start a Total War debug session first.');
		}
		return await this.session.customRequest(command, args) as T;
	}

	/** Runs Lua in the game; resolves with its (JSON-safe) first result. */
	async run<T>(code: string, chunk?: string): Promise<T> {
		return (await this.request<{ value: T }>('tw/run', { code, chunk })).value;
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}

interface ScriptEventBody {
	name: string;
	time: number;
	count?: number;
	context?: Record<string, unknown>;
}

// ---- campaign inspector ------------------------------------------------------

interface FactionInfo { name: string; label: string; human: boolean; treasury: number; regions: number; characters: number }
interface CharacterInfo { cqi: number; name: string; type: string; subtype: string; rank: number; region: string; x: number; y: number; units: number }
interface RegionInfo { name: string; label: string }

type Node =
	| { kind: 'faction'; faction: FactionInfo }
	| { kind: 'group'; faction: string; group: 'characters' | 'regions'; count: number }
	| { kind: 'character'; faction: string; character: CharacterInfo }
	| { kind: 'region'; faction: string; region: RegionInfo }
	| { kind: 'message'; text: string };

const LOC = `local function loc(key, fallback)
	local ok, text = pcall(function() return common.get_localised_string(key) end)
	if ok and type(text) == 'string' and text ~= '' then return text end
	return fallback
end`;

const FACTIONS_LUA = `${LOC}
if type(cm) ~= 'table' or not cm.model then error('Not in a campaign.') end
local out = {}
local list = cm:model():world():faction_list()
for i = 0, list:num_items() - 1 do
	local f = list:item_at(i)
	if not f:is_dead() then
		out[#out + 1] = {
			name = f:name(), label = loc('factions_screen_name_' .. f:name(), f:name()), human = f:is_human(),
			treasury = f:treasury(), regions = f:region_list():num_items(), characters = f:character_list():num_items(),
		}
	end
end
return out`;

const characterLua = (faction: string) => `${LOC}
local out = {}
local list = cm:get_faction(${luaString(faction)}):character_list()
for i = 0, list:num_items() - 1 do
	local c = list:item_at(i)
	local okf, forename = pcall(function() return c:get_forename() end)
	local oks, surname = pcall(function() return c:get_surname() end)
	local name = (okf and loc(forename, '') or '') .. ' ' .. (oks and loc(surname, '') or '')
	out[#out + 1] = {
		cqi = c:command_queue_index(), name = name:gsub('^%s+', ''):gsub('%s+$', ''),
		type = c:character_type_key(), subtype = c:character_subtype_key(), rank = c:rank(),
		region = c:has_region() and c:region():name() or '', x = c:logical_position_x(), y = c:logical_position_y(),
		units = c:has_military_force() and c:military_force():unit_list():num_items() or 0,
	}
end
return out`;

const regionLua = (faction: string) => `${LOC}
local out = {}
local list = cm:get_faction(${luaString(faction)}):region_list()
for i = 0, list:num_items() - 1 do
	local r = list:item_at(i)
	out[#out + 1] = { name = r:name(), label = loc('regions_onscreen_' .. r:name(), r:name()) }
end
return out`;

/** The "Campaign" view in Run and Debug: factions, their characters and regions, live from the game. */
class CampaignTreeProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly game: GameConnection) {
		game.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.changed.fire(undefined);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case 'faction': {
				const f = node.faction;
				const item = new vscode.TreeItem(f.label, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${f.human ? 'player · ' : ''}${f.treasury} gold · ${f.regions} regions`;
				item.tooltip = f.name;
				item.contextValue = 'faction';
				item.iconPath = new vscode.ThemeIcon(f.human ? 'account' : 'organization');
				return item;
			}
			case 'group': {
				const item = new vscode.TreeItem(node.group === 'characters' ? 'Characters' : 'Regions',
					node.count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.description = String(node.count);
				return item;
			}
			case 'character': {
				const c = node.character;
				const item = new vscode.TreeItem(c.name || c.subtype, vscode.TreeItemCollapsibleState.None);
				item.description = `${c.type} · rank ${c.rank}${c.units ? ` · ${c.units} units` : ''}${c.region ? ` · ${c.region}` : ''}`;
				item.tooltip = `cqi ${c.cqi}, ${c.subtype}, at ${c.x}, ${c.y}`;
				item.contextValue = 'character';
				item.iconPath = new vscode.ThemeIcon(c.units ? 'shield' : 'person');
				return item;
			}
			case 'region': {
				const item = new vscode.TreeItem(node.region.label, vscode.TreeItemCollapsibleState.None);
				item.description = node.region.name;
				item.contextValue = 'region';
				item.iconPath = new vscode.ThemeIcon('location');
				return item;
			}
			case 'message':
				return new vscode.TreeItem(node.text);
		}
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (this.game.env !== 'campaign') {
			return [{ kind: 'message', text: this.game.env ? `The game is in the ${this.game.env}.` : 'No game connected.' }];
		}
		try {
			if (!node) {
				const factions = await this.game.run<FactionInfo[]>(FACTIONS_LUA);
				return factions
					.sort((a, b) => Number(b.human) - Number(a.human) || a.label.localeCompare(b.label))
					.map((faction) => ({ kind: 'faction', faction }));
			}
			if (node.kind === 'faction') {
				return [
					{ kind: 'group', faction: node.faction.name, group: 'characters', count: node.faction.characters },
					{ kind: 'group', faction: node.faction.name, group: 'regions', count: node.faction.regions },
				];
			}
			if (node.kind === 'group' && node.group === 'characters') {
				const list = await this.game.run<CharacterInfo[]>(characterLua(node.faction));
				return list.sort((a, b) => b.units - a.units || b.rank - a.rank).map((character) => ({ kind: 'character', faction: node.faction, character }));
			}
			if (node.kind === 'group' && node.group === 'regions') {
				const list = await this.game.run<RegionInfo[]>(regionLua(node.faction));
				return list.sort((a, b) => a.label.localeCompare(b.label)).map((region) => ({ kind: 'region', faction: node.faction, region }));
			}
		} catch (e) {
			return [{ kind: 'message', text: (e as Error).message }];
		}
		return [];
	}
}

// ---- the tools ---------------------------------------------------------------

/** Event monitor, campaign inspector, running code, hot reload and the profiler. */
export class GameTools implements vscode.Disposable {
	private readonly game: GameConnection;
	private readonly events = vscode.window.createOutputChannel('TW Script Events');
	private monitoring = false;
	private readonly campaign: CampaignTreeProvider;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly db: DbService, private readonly extensionUri: vscode.Uri) {
		this.game = new GameConnection((e) => this.onScriptEvent(e));
		this.campaign = new CampaignTreeProvider(this.game);
		const view = vscode.window.createTreeView('twdev.campaignView', { treeDataProvider: this.campaign });
		const cmd = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, async (...args: never[]) => {
			try {
				await fn(...args);
			} catch (e) {
				void vscode.window.showErrorMessage((e as Error).message);
			}
		});
		this.disposables.push(
			this.game, this.events, view,
			this.game.onDidChange(() => {
				if (!this.game.env) {
					this.monitoring = false;
					void vscode.commands.executeCommand('setContext', 'twdev.monitoringEvents', false);
				}
			}),
			cmd('twdev.toggleEventMonitor', () => this.toggleMonitor()),
			cmd('twdev.refreshCampaign', () => this.campaign.refresh()),
			cmd('twdev.campaign.addMoney', (node: Node) => this.addMoney(node)),
			cmd('twdev.campaign.applyEffectBundle', (node: Node) => this.applyEffectBundle(node)),
			cmd('twdev.campaign.giveRegion', (node: Node) => this.giveRegion(node)),
			cmd('twdev.campaign.killCharacter', (node: Node) => this.killCharacter(node)),
			cmd('twdev.campaign.addLevels', (node: Node) => this.addLevels(node)),
			cmd('twdev.campaign.teleport', (node: Node) => this.teleport(node)),
			cmd('twdev.runFileInGame', (uri?: vscode.Uri) => this.runFile(uri)),
			cmd('twdev.runSelectionInGame', () => this.runSelection()),
			cmd('twdev.startProfiler', () => this.startProfiler()),
			cmd('twdev.stopProfiler', () => this.stopProfiler()),
			vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
		);
	}

	// ---- event monitor ----

	private async toggleMonitor(): Promise<void> {
		const on = !this.monitoring;
		const r = await this.game.request<{ on: boolean; available: boolean }>('tw/monitorEvents', { on });
		this.monitoring = r.on;
		void vscode.commands.executeCommand('setContext', 'twdev.monitoringEvents', r.on);
		if (on) {
			this.events.show(true);
			this.events.appendLine(r.available
				? `--- Monitoring script events (${this.game.env}). Filter with twdev.eventMonitor.exclude. ---`
				: '--- The game has no script core yet; events show once it has. ---');
		} else {
			this.events.appendLine('--- Stopped. ---');
		}
	}

	private onScriptEvent(e: ScriptEventBody): void {
		if (!this.monitoring) {
			return;
		}
		if (e.name === '(dropped)') {
			this.events.appendLine(`… ${e.count} more events in the last second not shown`);
			return;
		}
		const exclude = vscode.workspace.getConfiguration('twdev').get<string[]>('eventMonitor.exclude', []);
		if (exclude.some((p) => matchesName(p, e.name))) {
			return;
		}
		const context = Object.entries(e.context ?? {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
		this.events.appendLine(`${e.time.toFixed(3).padStart(10)}  ${e.name}${context ? `  ${context}` : ''}`);
	}

	// ---- campaign actions ----

	private async runAction(code: string, done: string): Promise<void> {
		await this.game.run(code);
		void vscode.window.setStatusBarMessage(done, 4000);
		setTimeout(() => this.campaign.refresh(), 300);
	}

	private async addMoney(node: Node): Promise<void> {
		if (node?.kind !== 'faction') {
			return;
		}
		const amount = await vscode.window.showInputBox({ prompt: `Gold to add to ${node.faction.label} (negative to take)`, value: '10000', validateInput: (v) => (/^-?\d+$/.test(v.trim()) ? undefined : 'A whole number') });
		if (amount) {
			await this.runAction(`cm:treasury_mod(${luaString(node.faction.name)}, ${Number(amount)})`, `${amount} gold for ${node.faction.label}`);
		}
	}

	private async applyEffectBundle(node: Node): Promise<void> {
		if (node?.kind !== 'faction') {
			return;
		}
		let bundles: string[] = [];
		try {
			bundles = (await this.db.table('effect_bundles_tables')).rows.map((r) => r.key);
		} catch {
			// type it instead
		}
		const bundle = bundles.length
			? await vscode.window.showQuickPick(bundles, { placeHolder: `Effect bundle for ${node.faction.label}` })
			: await vscode.window.showInputBox({ prompt: 'Effect bundle key' });
		if (!bundle) {
			return;
		}
		const turns = await vscode.window.showInputBox({ prompt: 'Turns (0: until removed)', value: '0', validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'A whole number') });
		if (turns !== undefined) {
			await this.runAction(`cm:apply_effect_bundle(${luaString(bundle)}, ${luaString(node.faction.name)}, ${Number(turns)})`, `${bundle} applied to ${node.faction.label}`);
		}
	}

	private async giveRegion(node: Node): Promise<void> {
		if (node?.kind !== 'region') {
			return;
		}
		const factions = await this.game.run<FactionInfo[]>(FACTIONS_LUA);
		const to = await vscode.window.showQuickPick(factions.map((f) => ({ label: f.label, description: f.name, f })), { placeHolder: `Give ${node.region.label} to` });
		if (to) {
			await this.runAction(`cm:transfer_region_to_faction(${luaString(node.region.name)}, ${luaString(to.f.name)})`, `${node.region.label} now belongs to ${to.label}`);
		}
	}

	private async killCharacter(node: Node): Promise<void> {
		if (node?.kind !== 'character') {
			return;
		}
		const c = node.character;
		const kill = 'Kill';
		if (await vscode.window.showWarningMessage(`Kill ${c.name || c.subtype}${c.units ? ' and destroy their army' : ''}?`, { modal: true }, kill) === kill) {
			await this.runAction(`cm:kill_character(cm:char_lookup_str(${c.cqi}), true)`, `${c.name || c.subtype} killed`);
		}
	}

	private async addLevels(node: Node): Promise<void> {
		if (node?.kind !== 'character') {
			return;
		}
		const levels = await vscode.window.showInputBox({ prompt: 'Levels to add', value: '5', validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'A whole number') });
		if (levels) {
			await this.runAction(`cm:add_agent_experience(cm:char_lookup_str(${node.character.cqi}), ${Number(levels)}, true)`, `+${levels} levels`);
		}
	}

	private async teleport(node: Node): Promise<void> {
		if (node?.kind !== 'character') {
			return;
		}
		const c = node.character;
		const to = await vscode.window.showInputBox({ prompt: 'Logical position "x, y"', value: `${c.x}, ${c.y}`, validateInput: (v) => (/^\s*\d+\s*,\s*\d+\s*$/.test(v) ? undefined : 'x, y') });
		if (to) {
			const [x, y] = to.split(',').map((n) => Number(n.trim()));
			await this.runAction(`cm:teleport_to(cm:char_lookup_str(${c.cqi}), ${x}, ${y})`, `Teleported to ${x}, ${y}`);
		}
	}

	// ---- running code ----

	private async runFile(uri?: vscode.Uri): Promise<void> {
		const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
		if (!doc || doc.languageId !== 'lua') {
			throw new Error('Open a Lua file to run.');
		}
		await this.runDocument(doc);
	}

	private async runDocument(doc: vscode.TextDocument): Promise<void> {
		const chunk = chunkNameFor(doc.uri.fsPath);
		const value = await this.game.run<unknown>(doc.getText(), chunk);
		vscode.debug.activeDebugConsole.appendLine(`Ran ${path.basename(doc.uri.fsPath)} in the game${value !== undefined && value !== null ? `: ${JSON.stringify(value)}` : '.'}`);
	}

	private async runSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const text = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).text : editor.document.getText(editor.selection);
		const value = await this.game.run<unknown>(text);
		vscode.debug.activeDebugConsole.appendLine(`> ${text.trim().split('\n')[0]}${value !== undefined && value !== null ? `\n${JSON.stringify(value, null, 2)}` : ''}`);
	}

	/** Hot reload: a saved mod script runs again in the game (`twdev.hotReload`). */
	private onSave(doc: vscode.TextDocument): void {
		if (doc.languageId !== 'lua' || doc.uri.scheme !== 'file' || !this.game.env
			|| !vscode.workspace.getConfiguration('twdev').get<boolean>('hotReload', false)
			|| !vscode.workspace.getWorkspaceFolder(doc.uri) || !chunkNameFor(doc.uri.fsPath)) {
			return;
		}
		this.runDocument(doc).catch((e: Error) => vscode.debug.activeDebugConsole.appendLine(`Hot reload of ${path.basename(doc.uri.fsPath)} failed: ${e.message}`));
	}

	// ---- profiler ----

	private async startProfiler(): Promise<void> {
		const r = await this.game.request<{ interval: number }>('tw/profileStart', {
			interval: vscode.workspace.getConfiguration('twdev').get<number>('profiler.interval', 5000),
		});
		void vscode.commands.executeCommand('setContext', 'twdev.profiling', true);
		void vscode.window.showInformationMessage(`Profiling the game's scripts (a sample every ${r.interval} Lua instructions). Run "TotalWar: Stop Profiler" to see where the time goes.`);
	}

	private async stopProfiler(): Promise<void> {
		const result = await this.game.request<ProfileResult>('tw/profileStop');
		void vscode.commands.executeCommand('setContext', 'twdev.profiling', false);
		const panel = vscode.window.createWebviewPanel('twdev.profile', `Lua profile (${result.total} samples)`, vscode.ViewColumn.Active, { enableScripts: true });
		panel.webview.html = profileHtml(panel.webview, result);
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}

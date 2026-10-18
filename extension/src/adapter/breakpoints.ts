import { BreakpointSpec } from './protocol';

export interface StoredBreakpoint extends BreakpointSpec {
	id: number;
}

/**
 * Breakpoints per source, keyed by pack relative path. The adapter owns them so
 * they can be re-sent whenever the game rebuilds its Lua state (frontend ->
 * campaign -> battle).
 */
export class BreakpointStore {
	private nextId = 1;
	private readonly byKey = new Map<string, StoredBreakpoint[]>();

	set(key: string, specs: BreakpointSpec[]): StoredBreakpoint[] {
		const stored = specs.map((s) => ({ ...s, id: this.nextId++ }));
		if (stored.length) {
			this.byKey.set(key, stored);
		} else {
			this.byKey.delete(key);
		}
		return stored;
	}

	get(key: string): StoredBreakpoint[] {
		return this.byKey.get(key) ?? [];
	}

	/** Snapshot in the shape the debuggee expects. */
	toWire(): { [key: string]: BreakpointSpec[] } {
		const out: { [key: string]: BreakpointSpec[] } = {};
		for (const [key, bps] of this.byKey) {
			out[key] = bps.map(toSpec);
		}
		return out;
	}

	static toSpec = toSpec;
}

function toSpec(bp: BreakpointSpec): BreakpointSpec {
	const spec: BreakpointSpec = { line: bp.line };
	if (bp.condition) {
		spec.condition = bp.condition;
	}
	if (bp.hitCondition) {
		spec.hitCondition = bp.hitCondition;
	}
	if (bp.logMessage) {
		spec.logMessage = bp.logMessage;
	}
	return spec;
}

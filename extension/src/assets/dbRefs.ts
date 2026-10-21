/**
 * DB keys in the JSON of structured binary files: a property whose string
 * value must be a value of a DB table column.
 */
export interface DbRefRule {
	/** JSON property name. */
	property: string;
	table: string;
	column: string;
}

/** Portrait settings: each entry is for an art set, each variant for a variant mesh. */
export const PORTRAIT_SETTINGS_RULES: DbRefRule[] = [
	{ property: 'id', table: 'campaign_character_art_sets_tables', column: 'art_set_id' },
	{ property: 'filename', table: 'variants_tables', column: 'variant_filename' },
];

/** The rules of a document by its path (`.../portrait_settings_x.bin.json`). */
export function dbRefRulesFor(path: string): DbRefRule[] {
	return /portrait_settings[^/\\]*\.bin\.json$/i.test(path) ? PORTRAIT_SETTINGS_RULES : [];
}

export interface DbRef {
	value: string;
	rule: DbRefRule;
	/** Offsets of the value (without quotes) in the text. */
	start: number;
	end: number;
}

/** The non-empty values of the rules' properties in a JSON text. */
export function findDbRefs(text: string, rules: DbRefRule[]): DbRef[] {
	if (!rules.length) {
		return [];
	}
	const byProperty = new Map(rules.map((r) => [r.property, r]));
	const refs: DbRef[] = [];
	for (const m of text.matchAll(/"(\w+)"\s*:\s*"([^"\\]*)"/g)) {
		const rule = byProperty.get(m[1]);
		if (rule && m[2]) {
			const start = m.index + m[0].length - m[2].length - 1;
			refs.push({ value: m[2], rule, start, end: start + m[2].length });
		}
	}
	return refs;
}

/** The property and the start of its string value being typed at `offset` in a line, for completion. */
export function dbRefValueAt(line: string, offset: number, rules: DbRefRule[]): { rule: DbRefRule; start: number; prefix: string } | undefined {
	const m = /"(\w+)"\s*:\s*"([^"\\]*)$/.exec(line.slice(0, offset));
	const rule = m && rules.find((r) => r.property === m[1]);
	return rule ? { rule, start: offset - m[2].length, prefix: m[2] } : undefined;
}

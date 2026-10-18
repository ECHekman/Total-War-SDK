/**
 * The rows of one DB table fragment being edited, and the edits that can be
 * applied to it and undone. No VS Code dependency (unit tested).
 */
import type { DbField, DbValue } from './effective';

export type Cell = DbValue | undefined;

export type DbEdit =
	| { type: 'set'; row: number; col: number; value: Cell; old: Cell }
	| { type: 'insert'; index: number; rows: Cell[][] }
	| { type: 'delete'; indices: number[]; rows: Cell[][] };

export class DbTableModel {
	constructor(
		readonly table: string,
		readonly version: number,
		readonly guid: string,
		readonly fields: DbField[],
		public rows: Cell[][],
	) {}

	apply(edit: DbEdit): void {
		switch (edit.type) {
			case 'set':
				this.rows[edit.row][edit.col] = edit.value;
				break;
			case 'insert':
				this.rows.splice(edit.index, 0, ...edit.rows.map((r) => [...r]));
				break;
			case 'delete':
				// Highest index first so the others stay valid.
				for (const i of [...edit.indices].sort((a, b) => b - a)) {
					this.rows.splice(i, 1);
				}
				break;
		}
	}

	revert(edit: DbEdit): void {
		switch (edit.type) {
			case 'set':
				this.rows[edit.row][edit.col] = edit.old;
				break;
			case 'insert':
				this.rows.splice(edit.index, edit.rows.length);
				break;
			case 'delete': {
				const order = edit.indices.map((index, i) => ({ index, row: edit.rows[i] })).sort((a, b) => a.index - b.index);
				for (const { index, row } of order) {
					this.rows.splice(index, 0, [...row]);
				}
				break;
			}
		}
	}

	/** An edit that deletes these rows (their contents are kept for undo). */
	deleteEdit(indices: number[]): DbEdit {
		const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.rows.length).sort((a, b) => a - b);
		return { type: 'delete', indices: sorted, rows: sorted.map((i) => [...this.rows[i]]) };
	}

	/** A row with the schema's defaults. */
	newRow(): Cell[] {
		return this.fields.map((f) => parseValue(f, f.defaultValue ?? '') ?? emptyValue(f));
	}

	/** Rows with every value present, for encoding. */
	completeRows(): DbValue[][] {
		return this.rows.map((r) => this.fields.map((f, i) => r[i] ?? parseValue(f, f.defaultValue ?? '') ?? emptyValue(f)));
	}
}

/** The value of a field type for empty input. */
export function emptyValue(field: DbField): DbValue {
	if (field.fieldType === 'Boolean') {
		return false;
	}
	return isNumeric(field) ? 0 : '';
}

export function isNumeric(field: DbField): boolean {
	return /^(Optional)?(I16|I32|I64|F32|F64)$/.test(field.fieldType);
}

/** Parses text typed for a field; undefined when it is not valid for its type. */
export function parseValue(field: DbField, text: string): DbValue | undefined {
	const t = text.trim();
	if (field.fieldType === 'Boolean') {
		return /^(true|1|yes)$/i.test(t) ? true : /^(false|0|no|)$/i.test(t) ? false : undefined;
	}
	if (/I16|I32|I64/.test(field.fieldType)) {
		if (!/^-?\d+$/.test(t)) {
			return undefined;
		}
		const n = Number(t);
		const limit = field.fieldType.endsWith('I16') ? 32767 : field.fieldType.endsWith('I32') ? 2147483647 : Number.MAX_SAFE_INTEGER;
		return Math.abs(n) <= limit ? n : undefined;
	}
	if (/F32|F64/.test(field.fieldType)) {
		const n = Number(t);
		return t !== '' && Number.isFinite(n) ? n : undefined;
	}
	if (/^Sequence/.test(field.fieldType)) {
		return undefined; // not editable
	}
	return text;
}

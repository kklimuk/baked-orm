import type { ColumnDefinition } from "../types";
import { quoteIdentifier } from "./utils";

/**
 * Rewrite bare quoted column names in a SQL fragment to be qualified by `alias`.
 *
 * Walks the fragment for tokens matching `"col"` and prefixes each known column
 * with `"alias".`. Tokens already qualified (preceded by a `.`) are left alone.
 *
 * Caveats:
 * - String literals containing escaped double-quote characters are not handled.
 *   Fragments produced by `where()` and `whereRaw()` parameterize values, so
 *   this is safe for internal callers. Users passing raw SQL with quoted
 *   identifiers inside string literals should pre-qualify their columns.
 */
export function requalifyFragment(
	fragment: string,
	alias: string,
	knownColumnNames: Set<string>,
): string {
	return fragment.replace(/(?<!\.)"(\w+)"/g, (match, columnName) => {
		if (!knownColumnNames.has(columnName)) return match;
		return `${quoteIdentifier(alias)}."${columnName}"`;
	});
}

/**
 * Renumber `$N` parameter placeholders in a SQL fragment by adding `offset` to
 * each. Used when concatenating fragments that each started numbering from $1.
 */
export function renumberParameters(fragment: string, offset: number): string {
	if (offset === 0) return fragment;
	return fragment.replace(/\$(\d+)/g, (_, num) => `$${Number(num) + offset}`);
}

/** Build a set of DB column names from a TableDefinition's columns map. */
export function buildKnownColumnNames(
	columns: Record<string, ColumnDefinition>,
): Set<string> {
	const result = new Set<string>();
	for (const definition of Object.values(columns)) {
		result.add(definition.columnName);
	}
	return result;
}

import type { OrderDirection } from "../model/types";

export type WhereClause = {
	fragment: string;
	values: unknown[];
	/**
	 * DB column names referenced by this clause, or `null` for opaque
	 * `whereRaw` fragments. Used by recursive CTE rendering to decide which
	 * predicates to omit from the recursive step.
	 */
	columnNames: string[] | null;
};

export type OrderClause = {
	column: string;
	direction: OrderDirection;
};

export type Projection =
	| { kind: "default" }
	| { kind: "columns"; dbColumns: string[] }
	| { kind: "count" }
	| { kind: "exists" };

export type RenderOptions = {
	fromClause: string;
	starColumn: string;
	paramOffset: number;
};

/**
 * Renumber `$N` parameter placeholders in a SQL fragment by adding `offset` to
 * each. Used when concatenating fragments that each started numbering from $1.
 */
export function renumberParameters(fragment: string, offset: number): string {
	if (offset === 0) return fragment;
	return fragment.replace(/\$(\d+)/g, (_, num) => `$${Number(num) + offset}`);
}

/**
 * Guard that throws if a QueryBuilder has a recursive CTE active.
 * Used by multiple plugins (recursive-cte, soft-delete, locking) to block
 * operations that are incompatible with recursive scopes.
 */
export function assertNoRecursiveCte(
	extensions: Record<string, unknown>,
	operation: string,
): void {
	if (extensions.recursiveCte) {
		throw new Error(
			`Cannot call ${operation}() on a recursive query. Run the recursive scope to a result set first.`,
		);
	}
}

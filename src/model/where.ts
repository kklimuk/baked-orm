import type { ColumnDefinition } from "../types";
import { renumberParameters } from "./recursive";
import { quoteIdentifier } from "./utils";

/** Symbol used by `QueryBuilder` to expose its SQL for subquery embedding. */
export const SUBQUERY = Symbol.for("baked-orm.subquery");

export type SubqueryDescriptor = {
	readonly sql: string;
	readonly values: readonly unknown[];
};

function resolveSubquery(value: unknown): SubqueryDescriptor | null {
	if (
		typeof value === "object" &&
		value !== null &&
		SUBQUERY in value &&
		typeof (value as Record<symbol, unknown>)[SUBQUERY] === "function"
	) {
		return (value as { [SUBQUERY](): SubqueryDescriptor })[SUBQUERY]();
	}
	return null;
}

/**
 * Operator object accepted by `where()` value positions. Multiple operators on
 * the same column AND together — e.g. `{ gte: 18, lte: 65 }` produces
 * `"col" >= $1 AND "col" <= $2`. Range and string operators are constrained
 * by `T` so e.g. `gt` is unavailable on boolean columns and `ilike` only on
 * string columns.
 */
export type WhereOperators<T> = {
	eq?: T | null;
	ne?: T | null;
	gt?: NonNullable<T>;
	gte?: NonNullable<T>;
	lt?: NonNullable<T>;
	lte?: NonNullable<T>;
	in?: ReadonlyArray<NonNullable<T>> | { [SUBQUERY](): SubqueryDescriptor };
	not_in?: ReadonlyArray<NonNullable<T>> | { [SUBQUERY](): SubqueryDescriptor };
} & ([Extract<T, string>] extends [never]
	? Record<never, never>
	: {
			like?: string;
			ilike?: string;
			contains?: string;
			starts_with?: string;
			ends_with?: string;
		});

/** A scalar (equality), an array (IN), an operator object, or a subquery. */
export type WhereValue<T> =
	| T
	| ReadonlyArray<NonNullable<T>>
	| WhereOperators<T>
	| { [SUBQUERY](): SubqueryDescriptor };

/**
 * Per-column conditions plus optional `or` / `and` groupings. Top-level keys
 * are AND-joined; nested groups can introduce arbitrary OR / AND nesting.
 *
 * Note: a column literally named `or` or `and` collides with the grouping
 * keys. Workaround: use `whereRaw` for those columns.
 */
export type WhereConditions<Row> = {
	[K in keyof Row]?: WhereValue<Row[K]>;
} & {
	or?: ReadonlyArray<WhereConditions<Row>>;
	and?: ReadonlyArray<WhereConditions<Row>>;
};

/** A compiled WHERE fragment with its parameter values and column refs. */
type CompiledWhereClause = {
	fragment: string;
	values: unknown[];
	/**
	 * DB column names referenced by this clause, or `null` for opaque
	 * (`whereRaw` or groups containing whereRaw) fragments. Recursive CTE
	 * rendering uses this to decide which predicates to omit from the
	 * recursive step.
	 */
	columnNames: string[] | null;
};

const KNOWN_OPERATORS = new Set([
	"eq",
	"ne",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"not_in",
	"like",
	"ilike",
	"contains",
	"starts_with",
	"ends_with",
]);

const COMPARISON_SQL: Record<string, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

const TIMESTAMP_TYPES = new Set([
	"timestamptz",
	"timestamp",
	"timestamp with time zone",
	"timestamp without time zone",
]);

/**
 * For timestamp columns, return a column expression truncated to millisecond
 * precision so JS Date values (ms-only) round-trip correctly against
 * PostgreSQL's microsecond-precision storage. Uses `date_trunc` rather than
 * a `::timestamptz(3)` cast because the cast rounds while JS `Date`
 * truncates. Used for equality operators (`=`, `!=`, `IN`, `NOT IN`). Range
 * operators (`>`, `>=`, `<`, `<=`) use the bare column to preserve
 * index-friendliness.
 */
function clampedColumnExpr(
	quotedColumn: string,
	definition: ColumnDefinition | undefined,
): string {
	if (!definition || !TIMESTAMP_TYPES.has(definition.type)) {
		return quotedColumn;
	}
	return `date_trunc('milliseconds', ${quotedColumn})`;
}

/**
 * True for plain object literals (`{}` or `Object.create(null)`); false for
 * arrays, Date, Buffer, RegExp, class instances, etc. Used to distinguish
 * operator objects from values like Date that should be bound literally.
 */
function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isOperatorObject(
	value: unknown,
	isJsonColumn: boolean,
): value is Record<string, unknown> {
	if (isJsonColumn) return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	// Empty plain object on a non-JSON column is treated as a no-op operator
	// object — produces no clause, which lets callers programmatically build
	// `{ ...optionalRangeFilters }` without special-casing the empty case.
	if (keys.length === 0) return true;
	return keys.every((key) => KNOWN_OPERATORS.has(key));
}

/**
 * Compile a `WhereConditions` object to a list of clauses joined by AND. Each
 * top-level key produces one clause (or zero, if a column maps to an empty
 * operator object). Nested `or` / `and` groups are compiled to a single
 * parenthesized clause whose `columnNames` is the union of referenced columns.
 */
export function compileConditions(
	conditions: Record<string, unknown>,
	columns: Record<string, ColumnDefinition>,
	startParamIndex: number,
): CompiledWhereClause[] {
	const clauses: CompiledWhereClause[] = [];
	let paramIndex = startParamIndex;
	for (const [key, value] of Object.entries(conditions)) {
		if (value === undefined) continue;
		if (key === "or" || key === "and") {
			const compiled = compileGroup(key, value, columns, paramIndex);
			clauses.push(compiled);
			paramIndex += compiled.values.length;
			continue;
		}
		const compiled = compileColumnPredicate(key, value, columns, paramIndex);
		if (compiled === null) continue;
		clauses.push(compiled);
		paramIndex += compiled.values.length;
	}
	return clauses;
}

function compileColumnPredicate(
	key: string,
	value: unknown,
	columns: Record<string, ColumnDefinition>,
	startParamIndex: number,
): CompiledWhereClause | null {
	const definition = columns[key];
	if (!definition) {
		throw new Error(
			`where() received unknown column "${key}". Known columns: ${Object.keys(columns).join(", ")}`,
		);
	}
	const dbColumn = definition.columnName;
	const quotedColumn = quoteIdentifier(dbColumn);
	const eqColumn = clampedColumnExpr(quotedColumn, definition);
	const isJson = definition?.type === "json" || definition?.type === "jsonb";

	if (value === null) {
		return {
			fragment: `${quotedColumn} IS NULL`,
			values: [],
			columnNames: [dbColumn],
		};
	}

	const subquery = resolveSubquery(value);
	if (subquery) {
		return buildSubqueryClause(
			quotedColumn,
			dbColumn,
			subquery,
			startParamIndex,
			false,
		);
	}

	if (Array.isArray(value)) {
		return buildInClause(eqColumn, dbColumn, value, startParamIndex, false);
	}

	if (isOperatorObject(value, isJson)) {
		return buildOperatorsClause(
			quotedColumn,
			eqColumn,
			dbColumn,
			value,
			startParamIndex,
		);
	}

	return {
		fragment: `${eqColumn} = $${startParamIndex}`,
		values: [value],
		columnNames: [dbColumn],
	};
}

function buildInClause(
	quotedColumn: string,
	dbColumn: string,
	values: readonly unknown[],
	startParamIndex: number,
	negated: boolean,
): CompiledWhereClause {
	if (values.length === 0) {
		return {
			fragment: negated ? "TRUE" : "FALSE",
			values: [],
			columnNames: [dbColumn],
		};
	}
	let paramIndex = startParamIndex;
	const placeholders = values.map(() => `$${paramIndex++}`);
	const operator = negated ? "NOT IN" : "IN";
	return {
		fragment: `${quotedColumn} ${operator} (${placeholders.join(", ")})`,
		values: [...values],
		columnNames: [dbColumn],
	};
}

function renderSubqueryFragment(
	quotedColumn: string,
	descriptor: SubqueryDescriptor,
	startParamIndex: number,
	negated: boolean,
): { fragment: string; values: unknown[] } {
	const renumbered = renumberParameters(descriptor.sql, startParamIndex - 1);
	const operator = negated ? "NOT IN" : "IN";
	return {
		fragment: `${quotedColumn} ${operator} (${renumbered})`,
		values: [...descriptor.values],
	};
}

function buildSubqueryClause(
	quotedColumn: string,
	dbColumn: string,
	descriptor: SubqueryDescriptor,
	startParamIndex: number,
	negated: boolean,
): CompiledWhereClause {
	return {
		...renderSubqueryFragment(
			quotedColumn,
			descriptor,
			startParamIndex,
			negated,
		),
		columnNames: [dbColumn],
	};
}

/**
 * Compile a `{eq, ne, gt, ...}` operator object on a single column. Multiple
 * operators AND together. Returns `null` for an empty operator object so the
 * caller can drop the column from the clause list entirely.
 *
 * @param quotedColumn — bare column expression (used for range/string ops)
 * @param eqColumn — clamped column expression (used for equality/IN ops)
 */
function buildOperatorsClause(
	quotedColumn: string,
	eqColumn: string,
	dbColumn: string,
	ops: Record<string, unknown>,
	startParamIndex: number,
): CompiledWhereClause | null {
	const fragments: string[] = [];
	const allValues: unknown[] = [];
	let paramIndex = startParamIndex;

	for (const [op, rawValue] of Object.entries(ops)) {
		const piece = buildSingleOperator(
			quotedColumn,
			eqColumn,
			op,
			rawValue,
			paramIndex,
		);
		fragments.push(piece.fragment);
		allValues.push(...piece.values);
		paramIndex += piece.values.length;
	}

	if (fragments.length === 0) return null;

	// Wrap multi-op fragments in parens so they're safe to drop into any
	// surrounding context (e.g. inside an OR group).
	const fragment =
		fragments.length === 1
			? (fragments[0] as string)
			: `(${fragments.join(" AND ")})`;

	return {
		fragment,
		values: allValues,
		columnNames: [dbColumn],
	};
}

function buildSingleOperator(
	quotedColumn: string,
	eqColumn: string,
	op: string,
	rawValue: unknown,
	startParamIndex: number,
): { fragment: string; values: unknown[] } {
	switch (op) {
		case "eq":
			if (rawValue === null) {
				return { fragment: `${quotedColumn} IS NULL`, values: [] };
			}
			return {
				fragment: `${eqColumn} = $${startParamIndex}`,
				values: [rawValue],
			};
		case "ne":
			if (rawValue === null) {
				return { fragment: `${quotedColumn} IS NOT NULL`, values: [] };
			}
			return {
				fragment: `${eqColumn} != $${startParamIndex}`,
				values: [rawValue],
			};
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				fragment: `${quotedColumn} ${COMPARISON_SQL[op]} $${startParamIndex}`,
				values: [rawValue],
			};
		case "in": {
			const inSubquery = resolveSubquery(rawValue);
			if (inSubquery) {
				return renderSubqueryFragment(
					quotedColumn,
					inSubquery,
					startParamIndex,
					false,
				);
			}
			if (!Array.isArray(rawValue)) {
				throw new Error(
					'where() operator "in" requires an array or subquery value',
				);
			}
			if (rawValue.length === 0) return { fragment: "FALSE", values: [] };
			let paramIndex = startParamIndex;
			const placeholders = rawValue.map(() => `$${paramIndex++}`);
			return {
				fragment: `${eqColumn} IN (${placeholders.join(", ")})`,
				values: [...rawValue],
			};
		}
		case "not_in": {
			const notInSubquery = resolveSubquery(rawValue);
			if (notInSubquery) {
				return renderSubqueryFragment(
					quotedColumn,
					notInSubquery,
					startParamIndex,
					true,
				);
			}
			if (!Array.isArray(rawValue)) {
				throw new Error(
					'where() operator "not_in" requires an array or subquery value',
				);
			}
			if (rawValue.length === 0) return { fragment: "TRUE", values: [] };
			let paramIndex = startParamIndex;
			const placeholders = rawValue.map(() => `$${paramIndex++}`);
			return {
				fragment: `${eqColumn} NOT IN (${placeholders.join(", ")})`,
				values: [...rawValue],
			};
		}
		case "like":
			return {
				fragment: `${quotedColumn} LIKE $${startParamIndex}`,
				values: [rawValue],
			};
		case "ilike":
			return {
				fragment: `${quotedColumn} ILIKE $${startParamIndex}`,
				values: [rawValue],
			};
		case "contains":
			return {
				fragment: `${quotedColumn} LIKE $${startParamIndex}`,
				values: [`%${rawValue}%`],
			};
		case "starts_with":
			return {
				fragment: `${quotedColumn} LIKE $${startParamIndex}`,
				values: [`${rawValue}%`],
			};
		case "ends_with":
			return {
				fragment: `${quotedColumn} LIKE $${startParamIndex}`,
				values: [`%${rawValue}`],
			};
		default:
			throw new Error(`Unknown where() operator: "${op}"`);
	}
}

function compileGroup(
	type: "or" | "and",
	groupValue: unknown,
	columns: Record<string, ColumnDefinition>,
	startParamIndex: number,
): CompiledWhereClause {
	if (!Array.isArray(groupValue)) {
		throw new Error(`where() "${type}" expects an array of condition objects`);
	}

	const childFragments: string[] = [];
	const childValues: unknown[] = [];
	const allColumnNames = new Set<string>();
	let hasOpaque = false;
	let paramIndex = startParamIndex;

	for (const child of groupValue) {
		if (typeof child !== "object" || child === null || Array.isArray(child)) {
			throw new Error(`where() "${type}" entries must be condition objects`);
		}
		const childClauses = compileConditions(
			child as Record<string, unknown>,
			columns,
			paramIndex,
		);
		if (childClauses.length === 0) continue;

		const fragments = childClauses.map((clause) => clause.fragment);
		const joined =
			fragments.length === 1
				? (fragments[0] as string)
				: `(${fragments.join(" AND ")})`;
		childFragments.push(joined);

		for (const clause of childClauses) {
			childValues.push(...clause.values);
			paramIndex += clause.values.length;
			if (clause.columnNames === null) {
				hasOpaque = true;
			} else {
				for (const columnName of clause.columnNames) {
					allColumnNames.add(columnName);
				}
			}
		}
	}

	if (childFragments.length === 0) {
		return {
			fragment: type === "or" ? "FALSE" : "TRUE",
			values: [],
			columnNames: [],
		};
	}

	const joiner = type === "or" ? " OR " : " AND ";
	const fragment =
		childFragments.length === 1
			? (childFragments[0] as string)
			: `(${childFragments.join(joiner)})`;

	return {
		fragment,
		values: childValues,
		columnNames: hasOpaque ? null : Array.from(allColumnNames),
	};
}

import { type RenderOptions, renumberParameters } from "../common/query";
import { getModelConnection } from "../model/connection";
import { QueryBuilder } from "../model/query";
import type { OrderDirection } from "../model/types";
import {
	executeQuery,
	quoteIdentifier,
	resolveColumnName,
} from "../model/utils";
import { SUBQUERY } from "../model/where";
import type { ColumnDefinition } from "../types";
import { definePlugin } from "./index";

type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

type AggregatesState = {
	groupColumns: string[];
	havingClauses: { fragment: string; values: unknown[] }[];
};

type AggregateTerminal =
	| { kind: "fn"; fn: AggregateFn; column: string | null }
	| { kind: "raw"; expressions: { sql: string; alias: string }[] };

const NUMERIC_PG_TYPES = new Set([
	"int2",
	"int4",
	"int8",
	"smallint",
	"integer",
	"bigint",
	"float4",
	"float8",
	"real",
	"double precision",
	"numeric",
	"decimal",
	"money",
]);

// biome-ignore lint/suspicious/noExplicitAny: plugin methods are generic across all model types
type AnyQB = QueryBuilder<any>;

definePlugin({
	name: "aggregates",
	queryBuilder: {
		group(this: AnyQB, ...columns: string[]): AnyQB {
			if (columns.length === 0) {
				throw new Error("group() requires at least one column");
			}
			const tableColumns = this._tableDefinition.columns;
			const dbColumns = columns.map((column) =>
				resolveColumnName(column, tableColumns),
			);
			const existing = readAggregatesState(this);
			return this._clone({
				extensions: {
					aggregates: {
						groupColumns: [...existing.groupColumns, ...dbColumns],
						havingClauses: existing.havingClauses,
					},
				},
			});
		},

		havingRaw(this: AnyQB, fragment: string, values?: unknown[]): AnyQB {
			const existing = readAggregatesState(this);
			if (existing.groupColumns.length === 0) {
				throw new Error(
					"havingRaw() requires group() — HAVING without GROUP BY is invalid SQL",
				);
			}
			return this._clone({
				extensions: {
					aggregates: {
						groupColumns: existing.groupColumns,
						havingClauses: [
							...existing.havingClauses,
							{ fragment, values: values ?? [] },
						],
					},
				},
			});
		},

		async sum(this: AnyQB, column: string): Promise<unknown> {
			return executeAggregateFn(this, "sum", column);
		},

		async avg(this: AnyQB, column: string): Promise<unknown> {
			return executeAggregateFn(this, "avg", column);
		},

		async min(this: AnyQB, column: string): Promise<unknown> {
			return executeAggregateFn(this, "min", column);
		},

		async max(this: AnyQB, column: string): Promise<unknown> {
			return executeAggregateFn(this, "max", column);
		},

		async aggregate(
			this: AnyQB,
			fragments: Record<string, string>,
		): Promise<unknown> {
			const aggState = readAggregatesState(this);
			if (aggState.groupColumns.length === 0) {
				throw new Error(
					"aggregate({ ... }) requires group() — only the grouped form is supported in v1",
				);
			}
			const entries = Object.entries(fragments);
			if (entries.length === 0) {
				throw new Error("aggregate({ ... }) requires at least one expression");
			}
			const expressions = entries.map(([alias, sql]) => ({ alias, sql }));
			assertCompatible(this, "aggregate");
			const terminal: AggregateTerminal = { kind: "raw", expressions };
			return runGroupedTerminal(this, aggState, terminal);
		},
	},
	static: {
		sum(this: Record<string, unknown>, column: string): Promise<unknown> {
			return getModelQueryBuilder(this, "sum").sum(column);
		},
		avg(this: Record<string, unknown>, column: string): Promise<unknown> {
			return getModelQueryBuilder(this, "avg").avg(column);
		},
		min(this: Record<string, unknown>, column: string): Promise<unknown> {
			return getModelQueryBuilder(this, "min").min(column);
		},
		max(this: Record<string, unknown>, column: string): Promise<unknown> {
			return getModelQueryBuilder(this, "max").max(column);
		},
		group(this: Record<string, unknown>, ...columns: string[]): unknown {
			return getModelQueryBuilder(this, "group").group(...(columns as never[]));
		},
	},
});

const originalRenderSelect = QueryBuilder.prototype._renderSelect;

QueryBuilder.prototype._renderSelect = function _renderSelect(
	this: AnyQB,
	projection,
	options,
) {
	const aggState = this._extensions.aggregates as AggregatesState | undefined;
	const aggTerminal = this._extensions.aggregateTerminal as
		| AggregateTerminal
		| undefined;

	const grouped = !!(aggState && aggState.groupColumns.length > 0);
	if (!aggTerminal && !grouped) {
		return originalRenderSelect.call(this, projection, options);
	}

	return renderAggregateSelect(this, aggState, aggTerminal, options);
};

const originalCount = QueryBuilder.prototype.count;

QueryBuilder.prototype.count = async function count(
	this: AnyQB,
): Promise<number> {
	const aggState = this._extensions.aggregates as AggregatesState | undefined;
	if (aggState && aggState.groupColumns.length > 0) {
		const terminal: AggregateTerminal = {
			kind: "fn",
			fn: "count",
			column: null,
		};
		// Grouped count() returns an array via the GroupedQueryBuilder type at the
		// caller; the prototype-level signature stays Promise<number> for the scalar
		// path, so we cast through unknown.
		return runGroupedTerminal(this, aggState, terminal) as unknown as number;
	}
	return originalCount.call(this);
};

const originalSubquery = QueryBuilder.prototype[SUBQUERY];

QueryBuilder.prototype[SUBQUERY] = function (this: AnyQB) {
	const aggState = this._extensions.aggregates as AggregatesState | undefined;
	if (aggState && aggState.groupColumns.length > 0) {
		throw new Error(
			"An aggregate-active query cannot be used as a subquery — " +
				"materialize the result with await first, or call pluck() on a non-aggregate variant",
		);
	}
	return originalSubquery.call(this);
};

declare module "../model/query" {
	interface QueryBuilder<Row> {
		group<K extends keyof Row & string>(
			...columns: K[]
		): GroupedQueryBuilder<Row, K>;
		sum<K extends keyof Row & string>(column: K): Promise<number | null>;
		avg<K extends keyof Row & string>(column: K): Promise<number | null>;
		min<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
		max<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
		havingRaw(fragment: string, values?: unknown[]): QueryBuilder<Row>;
		aggregate<T extends Record<string, string>>(
			fragments: T,
		): Promise<Array<Record<keyof T, unknown>>>;
	}
}

declare module "../model/types" {
	interface ModelStatic<Row> {
		sum<K extends keyof Row & string>(column: K): Promise<number | null>;
		avg<K extends keyof Row & string>(column: K): Promise<number | null>;
		min<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
		max<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
		group<Self extends ModelStatic<Row>, K extends keyof Row & string>(
			this: Self,
			...columns: K[]
		): GroupedQueryBuilder<InstanceType<Self>, K>;
	}
}

/**
 * Static view returned by `group(...)`. The underlying runtime instance is
 * still a `QueryBuilder<Row>` — this type narrows the chainable + terminal
 * signatures so the grouped result shape is reflected in TS.
 */
export interface GroupedQueryBuilder<
	Row,
	GroupCols extends keyof Row & string,
> {
	where(
		conditions: import("../model/where").WhereConditions<Row>,
	): GroupedQueryBuilder<Row, GroupCols>;
	whereRaw(
		fragment: string,
		values?: unknown[],
	): GroupedQueryBuilder<Row, GroupCols>;
	havingRaw(
		fragment: string,
		values?: unknown[],
	): GroupedQueryBuilder<Row, GroupCols>;
	order(
		clause: Partial<Record<keyof Row & string, OrderDirection>>,
	): GroupedQueryBuilder<Row, GroupCols>;
	limit(count: number): GroupedQueryBuilder<Row, GroupCols>;
	offset(count: number): GroupedQueryBuilder<Row, GroupCols>;
	count(): Promise<Array<Pick<Row, GroupCols> & { count: number }>>;
	sum<K extends keyof Row & string>(
		column: K,
	): Promise<Array<Pick<Row, GroupCols> & { sum: number }>>;
	avg<K extends keyof Row & string>(
		column: K,
	): Promise<Array<Pick<Row, GroupCols> & { avg: number }>>;
	min<K extends keyof Row & string>(
		column: K,
	): Promise<Array<Pick<Row, GroupCols> & { min: Row[K] }>>;
	max<K extends keyof Row & string>(
		column: K,
	): Promise<Array<Pick<Row, GroupCols> & { max: Row[K] }>>;
	aggregate<T extends Record<string, string>>(
		fragments: T,
	): Promise<Array<Pick<Row, GroupCols> & Record<keyof T, unknown>>>;
	toSQL(): { text: string; values: unknown[] };
}

function readAggregatesState(query: AnyQB): AggregatesState {
	const existing = query._extensions.aggregates as AggregatesState | undefined;
	return existing ?? { groupColumns: [], havingClauses: [] };
}

function getModelQueryBuilder(
	modelClass: Record<string, unknown>,
	method: string,
): AnyQB {
	const all = modelClass.all as unknown;
	if (typeof all !== "function") {
		throw new Error(
			`Cannot call ${method}() — model is missing the .all() static method`,
		);
	}
	return (all as () => AnyQB).call(modelClass);
}

async function executeAggregateFn(
	query: AnyQB,
	fn: AggregateFn,
	column: string,
): Promise<unknown> {
	const tableColumns = query._tableDefinition.columns;
	const definition = tableColumns[column];
	const dbColumn = resolveColumnName(column, tableColumns);
	if (fn === "sum" || fn === "avg") {
		assertNumeric(definition, column, fn);
	}
	assertCompatible(query, fn);

	const terminal: AggregateTerminal = { kind: "fn", fn, column: dbColumn };
	const aggState = readAggregatesState(query);

	if (aggState.groupColumns.length > 0) {
		return runGroupedTerminal(query, aggState, terminal);
	}
	return runScalarTerminal(query, terminal);
}

function assertNumeric(
	definition: ColumnDefinition | undefined,
	column: string,
	fn: AggregateFn,
): void {
	if (!definition) return; // unknown column — fall through to runtime SQL error
	if (!NUMERIC_PG_TYPES.has(definition.type)) {
		throw new Error(
			`${fn}("${column}") requires a numeric column, got type "${definition.type}"`,
		);
	}
}

function assertCompatible(query: AnyQB, op: string): void {
	if (query._extensions.recursiveCte) {
		// Recursive CTE composes with aggregates by design — outer SELECT runs the
		// aggregation over __traversal. So we deliberately allow it.
	}
	if (query._extensions.lockClause) {
		throw new Error(
			`Cannot call ${op}() with lock() — Postgres does not allow FOR UPDATE on aggregate queries`,
		);
	}
	if (query._distinctValue) {
		throw new Error(
			`Cannot call ${op}() with distinct() — combine COUNT/SUM with DISTINCT inside an aggregate({ ... }) raw expression instead`,
		);
	}
	if (query._includedAssociations.length > 0) {
		throw new Error(
			`Cannot call ${op}() with includes() — eager loading on aggregated rows is meaningless`,
		);
	}
}

async function runScalarTerminal(
	query: AnyQB,
	terminal: AggregateTerminal,
): Promise<unknown> {
	const cloned = query._clone({
		extensions: { aggregateTerminal: terminal },
	});
	const { text, values } = cloned._buildSql({ kind: "default" });
	const connection = getModelConnection();
	const rows = await executeQuery(
		connection,
		text,
		values,
		cloned._sensitiveColumns,
	);
	const row = rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	if (terminal.kind === "fn") {
		const value = row[terminal.fn];
		if (value === null || value === undefined) return null;
		return coerceAggregateValue(value, terminal, query);
	}
	return row;
}

async function runGroupedTerminal(
	query: AnyQB,
	aggState: AggregatesState,
	terminal: AggregateTerminal,
): Promise<unknown[]> {
	assertCompatible(query, terminalLabel(terminal));
	const cloned = query._clone({
		extensions: { aggregateTerminal: terminal },
	});
	const { text, values } = cloned._buildSql({ kind: "default" });
	const connection = getModelConnection();
	const rows = await executeQuery(
		connection,
		text,
		values,
		cloned._sensitiveColumns,
	);
	return mapGroupedRows(rows, query, aggState, terminal);
}

function terminalLabel(terminal: AggregateTerminal): string {
	if (terminal.kind === "fn") return terminal.fn;
	return "aggregate";
}

function mapGroupedRows(
	rows: unknown[],
	query: AnyQB,
	aggState: AggregatesState,
	terminal: AggregateTerminal,
): Record<string, unknown>[] {
	const reverseMap = query._reverseMap;
	return (rows as Record<string, unknown>[]).map((row) => {
		const result: Record<string, unknown> = {};
		for (const dbColumn of aggState.groupColumns) {
			const camelKey = reverseMap.get(dbColumn) ?? dbColumn;
			result[camelKey] = row[dbColumn];
		}
		if (terminal.kind === "fn") {
			const value = row[terminal.fn];
			result[terminal.fn] =
				value === null || value === undefined
					? null
					: coerceAggregateValue(value, terminal, query);
		} else {
			for (const expression of terminal.expressions) {
				result[expression.alias] = row[expression.alias];
			}
		}
		return result;
	});
}

/**
 * Postgres returns `numeric` (and aggregates over int8 in some configurations)
 * as a string. Coerce to `number` for sum/avg/count always (their declared
 * return type is `number | null`), and for min/max only when the source column
 * is a numeric type — otherwise we'd corrupt non-numeric column values.
 */
function coerceAggregateValue(
	value: unknown,
	terminal: { kind: "fn"; fn: AggregateFn; column: string | null },
	query: AnyQB,
): unknown {
	if (
		terminal.fn === "sum" ||
		terminal.fn === "avg" ||
		terminal.fn === "count"
	) {
		return Number(value);
	}
	// min/max — convert iff the column type is numeric
	if (terminal.column) {
		const reverseMap = query._reverseMap;
		const camelKey = reverseMap.get(terminal.column) ?? terminal.column;
		const definition = query._tableDefinition.columns[camelKey] as
			| ColumnDefinition
			| undefined;
		if (definition && NUMERIC_PG_TYPES.has(definition.type)) {
			return Number(value);
		}
	}
	return value;
}

function renderAggregateSelect(
	query: AnyQB,
	aggState: AggregatesState | undefined,
	terminal: AggregateTerminal | undefined,
	options: RenderOptions,
): { text: string; values: unknown[] } {
	const groupColumns = aggState?.groupColumns ?? [];
	const havingClauses = aggState?.havingClauses ?? [];

	const selectParts: string[] = [];
	for (const dbColumn of groupColumns) {
		selectParts.push(quoteIdentifier(dbColumn));
	}
	if (terminal) {
		if (terminal.kind === "fn") {
			selectParts.push(buildFnExpression(terminal));
		} else {
			for (const expression of terminal.expressions) {
				selectParts.push(
					`${expression.sql} AS ${quoteIdentifier(expression.alias)}`,
				);
			}
		}
	}

	if (selectParts.length === 0) {
		// Defensive — should not happen because callers always set at least one.
		selectParts.push("1");
	}

	let text = `SELECT ${selectParts.join(", ")} FROM ${options.fromClause}`;
	text = query._appendJoins(text);
	const { text: withWhere, values } = query._appendWhere(
		text,
		options.paramOffset,
	);
	text = withWhere;

	if (groupColumns.length > 0) {
		text += ` GROUP BY ${groupColumns.map(quoteIdentifier).join(", ")}`;
	}

	if (havingClauses.length > 0) {
		const havingParts: string[] = [];
		let havingOffset = options.paramOffset + values.length;
		for (const clause of havingClauses) {
			havingParts.push(renumberParameters(clause.fragment, havingOffset));
			values.push(...clause.values);
			havingOffset += clause.values.length;
		}
		text += ` HAVING ${havingParts.join(" AND ")}`;
	}

	if (query._orderClauses.length > 0) {
		const orderParts = query._orderClauses.map(
			(clause) => `${quoteIdentifier(clause.column)} ${clause.direction}`,
		);
		text += ` ORDER BY ${orderParts.join(", ")}`;
	}

	if (query._limitValue !== null) {
		text += ` LIMIT ${query._limitValue}`;
	}

	if (query._offsetValue !== null) {
		text += ` OFFSET ${query._offsetValue}`;
	}

	return { text, values };
}

function buildFnExpression(terminal: {
	kind: "fn";
	fn: AggregateFn;
	column: string | null;
}): string {
	if (terminal.fn === "count") {
		return `COUNT(*) AS ${quoteIdentifier("count")}`;
	}
	if (!terminal.column) {
		throw new Error(`${terminal.fn}() requires a column argument`);
	}
	const fnSql = terminal.fn.toUpperCase();
	return `${fnSql}(${quoteIdentifier(terminal.column)}) AS ${quoteIdentifier(terminal.fn)}`;
}

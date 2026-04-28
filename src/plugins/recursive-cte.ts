import {
	assertNoRecursiveCte,
	type Projection,
	type WhereClause,
} from "../common/query";
import { QueryBuilder } from "../model/query";
import { quoteIdentifier, resolveColumnName } from "../model/utils";
import type { ColumnDefinition, TableDefinition } from "../types";
import { definePlugin } from "./index";

definePlugin({
	name: "recursiveCte",
	queryBuilder: {
		recursiveOn(
			this: QueryBuilder<Record<string, unknown>>,
			options: {
				from: string;
				to: string;
				setSemantics?: boolean;
			},
		): QueryBuilder<Record<string, unknown>> {
			if (this._extensions.recursiveCte) {
				throw new Error(
					"recursiveOn() cannot be nested — this query already has a recursive CTE applied",
				);
			}
			if (this._joinClauses.length > 0) {
				throw new Error(
					"recursiveOn() cannot be combined with joins() — apply joins after the recursive scope",
				);
			}
			if (
				this._orderClauses.length > 0 ||
				this._limitValue !== null ||
				this._offsetValue !== null
			) {
				throw new Error(
					"recursiveOn() cannot be combined with order/limit/offset on the seed scope — apply ordering after the recursive scope",
				);
			}

			const columns = this._tableDefinition.columns;
			const fromDbColumn = resolveColumnName(options.from, columns);
			const toDbColumn = resolveColumnName(options.to, columns);

			const captured: CapturedRecursive = {
				whereClauses: this._whereClauses,
				fromDbColumn,
				toDbColumn,
				setSemantics: options.setSemantics ?? true,
			};

			return new QueryBuilder<Record<string, unknown>>(this._tableDefinition, {
				whereClauses: [],
				orderClauses: [],
				limitValue: null,
				offsetValue: null,
				selectColumns: this._selectColumns,
				joinClauses: [],
				includedAssociations: this._includedAssociations,
				includeOverrides: this._includeOverrides,
				modelClass: this._modelClass,
				reverseMap: this._reverseMap,
				distinctValue: this._distinctValue,
				extensions: { recursiveCte: captured },
			});
		},

		descendants(
			this: QueryBuilder<Record<string, unknown>>,
			options: { via: string },
		): QueryBuilder<Record<string, unknown>> {
			const primaryKey = this._tableDefinition.primaryKey;
			if (primaryKey.length !== 1) {
				throw new Error(
					"descendants() requires a single-column primary key on the table",
				);
			}
			return this.recursiveOn({
				from: options.via,
				to: primaryKey[0] as string,
			});
		},

		ancestors(
			this: QueryBuilder<Record<string, unknown>>,
			options: { via: string },
		): QueryBuilder<Record<string, unknown>> {
			const primaryKey = this._tableDefinition.primaryKey;
			if (primaryKey.length !== 1) {
				throw new Error(
					"ancestors() requires a single-column primary key on the table",
				);
			}
			return this.recursiveOn({
				from: primaryKey[0] as string,
				to: options.via,
			});
		},
	},
});

const originalBuildSql = QueryBuilder.prototype._buildSql;

QueryBuilder.prototype._buildSql = function _buildSql(
	this: QueryBuilder<unknown>,
	projection: Projection,
): { text: string; values: unknown[] } {
	const captured = this._extensions.recursiveCte as
		| CapturedRecursive
		| undefined;
	if (!captured) {
		return originalBuildSql.call(this, projection);
	}
	const cte = buildCte(captured, this._tableDefinition);
	const outer = this._renderSelect(projection, {
		fromClause: "__traversal",
		starColumn: "__traversal.*",
		paramOffset: cte.values.length,
	});
	return {
		text: `${cte.text} ${outer.text}`,
		values: [...cte.values, ...outer.values],
	};
};

const originalUpdateAll = QueryBuilder.prototype.updateAll;
QueryBuilder.prototype.updateAll = async function updateAll(
	this: QueryBuilder<unknown>,
	attributes: Record<string, unknown>,
): Promise<number> {
	assertNoRecursiveCte(this._extensions, "updateAll");
	return originalUpdateAll.call(this, attributes);
};

const originalDeleteAll = QueryBuilder.prototype.deleteAll;
QueryBuilder.prototype.deleteAll = async function deleteAll(
	this: QueryBuilder<unknown>,
): Promise<number> {
	assertNoRecursiveCte(this._extensions, "deleteAll");
	return originalDeleteAll.call(this);
};

declare module "../model/query" {
	interface QueryBuilder<Row> {
		recursiveOn(options: {
			from: keyof Row & string;
			to: keyof Row & string;
			setSemantics?: boolean;
		}): QueryBuilder<Row>;
		descendants(options: { via: keyof Row & string }): QueryBuilder<Row>;
		ancestors(options: { via: keyof Row & string }): QueryBuilder<Row>;
	}
}

type CapturedRecursive = {
	whereClauses: WhereClause[];
	fromDbColumn: string;
	toDbColumn: string;
	setSemantics: boolean;
};

function buildCte(
	captured: CapturedRecursive,
	tableDefinition: TableDefinition,
): { text: string; values: unknown[] } {
	const tableName = tableDefinition.tableName;
	const knownColumns = buildKnownColumnNames(tableDefinition.columns);
	const joinColumns = new Set([captured.fromDbColumn, captured.toDbColumn]);

	let anchorText = `SELECT ${quoteIdentifier(tableName)}.* FROM ${quoteIdentifier(tableName)}`;
	const anchorValues: unknown[] = [];
	if (captured.whereClauses.length > 0) {
		const joined = captured.whereClauses
			.map((clause) => clause.fragment)
			.join(" AND ");
		anchorText += ` WHERE ${joined}`;
		for (const clause of captured.whereClauses) {
			anchorValues.push(...clause.values);
		}
	}

	const childAlias = "child";
	const parentAlias = "parent";
	let stepText = `SELECT ${quoteIdentifier(childAlias)}.* FROM ${quoteIdentifier(tableName)} ${quoteIdentifier(childAlias)} INNER JOIN __traversal ${quoteIdentifier(parentAlias)} ON ${quoteIdentifier(childAlias)}.${quoteIdentifier(captured.fromDbColumn)} = ${quoteIdentifier(parentAlias)}.${quoteIdentifier(captured.toDbColumn)}`;
	const stepValues: unknown[] = [];
	const stepFragments: string[] = [];
	let originalParamIndex = 1;
	let stepParamIndex = anchorValues.length + 1;

	for (const clause of captured.whereClauses) {
		const clauseLength = clause.values.length;
		const referencesJoinColumn =
			clause.columnNames?.some((column) => joinColumns.has(column)) ?? false;

		if (!referencesJoinColumn) {
			const shift = stepParamIndex - originalParamIndex;
			const renumbered =
				shift === 0
					? clause.fragment
					: clause.fragment.replace(
							/\$(\d+)/g,
							(_, num) => `$${Number(num) + shift}`,
						);
			const requalified = requalifyFragment(
				renumbered,
				childAlias,
				knownColumns,
			);
			stepFragments.push(requalified);
			stepValues.push(...clause.values);
			stepParamIndex += clauseLength;
		}

		originalParamIndex += clauseLength;
	}

	if (stepFragments.length > 0) {
		stepText += ` WHERE ${stepFragments.join(" AND ")}`;
	}

	const setOperator = captured.setSemantics ? "UNION" : "UNION ALL";
	const text = `WITH RECURSIVE __traversal AS (${anchorText} ${setOperator} ${stepText})`;
	return { text, values: [...anchorValues, ...stepValues] };
}

/**
 * Rewrite bare quoted column names in a SQL fragment to be qualified by `alias`.
 *
 * Walks the fragment for tokens matching `"col"` and prefixes each known column
 * with `"alias".`. Tokens already qualified (preceded by a `.`) are left alone.
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

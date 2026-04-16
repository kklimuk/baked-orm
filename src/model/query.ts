import {
	type OrderClause,
	type Projection,
	type RenderOptions,
	renumberParameters,
	type WhereClause,
} from "../common/query";
import type { TableDefinition } from "../types";
import { getModelConnection } from "./connection";
import type { OrderDirection } from "./types";
import {
	buildReverseColumnMap,
	buildSensitiveColumns,
	executeQuery,
	hydrateInstance,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "./utils";
import {
	compileConditions,
	SUBQUERY,
	type SubqueryDescriptor,
	type WhereConditions,
} from "./where";

export class QueryBuilder<Row> {
	/** @internal */
	readonly _tableDefinition: TableDefinition<Row>;
	/** @internal */
	readonly _reverseMap: Map<string, string>;
	/** @internal */
	readonly _whereClauses: WhereClause[];
	/** @internal */
	readonly _orderClauses: OrderClause[];
	/** @internal */
	readonly _limitValue: number | null;
	/** @internal */
	readonly _offsetValue: number | null;
	/** @internal */
	readonly _selectColumns: string[];
	/** @internal */
	readonly _joinClauses: string[];
	/** @internal */
	readonly _includedAssociations: string[];
	/** @internal */
	readonly _modelClass: (new (attributes?: Partial<Row>) => Row) | null;
	/** @internal */
	readonly _sensitiveColumns: Set<string>;
	/** @internal */
	readonly _distinctValue: boolean;
	/** @internal — plugin state bag, automatically shallow-copied by _clone() */
	readonly _extensions: Record<string, unknown>;

	constructor(
		tableDefinition: TableDefinition<Row>,
		options?: {
			whereClauses?: WhereClause[];
			orderClauses?: OrderClause[];
			limitValue?: number | null;
			offsetValue?: number | null;
			selectColumns?: string[];
			joinClauses?: string[];
			includedAssociations?: string[];
			modelClass?: (new (attributes?: Partial<Row>) => Row) | null;
			reverseMap?: Map<string, string>;
			distinctValue?: boolean;
			extensions?: Record<string, unknown>;
		},
	) {
		this._tableDefinition = tableDefinition;
		this._reverseMap =
			options?.reverseMap ?? buildReverseColumnMap(tableDefinition.columns);
		this._whereClauses = options?.whereClauses ?? [];
		this._orderClauses = options?.orderClauses ?? [];
		this._limitValue = options?.limitValue ?? null;
		this._offsetValue = options?.offsetValue ?? null;
		this._selectColumns = options?.selectColumns ?? [];
		this._joinClauses = options?.joinClauses ?? [];
		this._includedAssociations = options?.includedAssociations ?? [];
		this._modelClass = options?.modelClass ?? null;
		this._sensitiveColumns = options?.modelClass
			? buildSensitiveColumns(options.modelClass, tableDefinition.columns)
			: new Set();
		this._distinctValue = options?.distinctValue ?? false;
		this._extensions = options?.extensions ?? {};
	}

	/** @internal */
	_clone(overrides: {
		whereClauses?: WhereClause[];
		orderClauses?: OrderClause[];
		limitValue?: number | null;
		offsetValue?: number | null;
		selectColumns?: string[];
		joinClauses?: string[];
		includedAssociations?: string[];
		distinctValue?: boolean;
		extensions?: Record<string, unknown>;
	}): QueryBuilder<Row> {
		return new QueryBuilder(this._tableDefinition, {
			whereClauses: overrides.whereClauses ?? this._whereClauses,
			orderClauses: overrides.orderClauses ?? this._orderClauses,
			limitValue:
				"limitValue" in overrides ? overrides.limitValue : this._limitValue,
			offsetValue:
				"offsetValue" in overrides ? overrides.offsetValue : this._offsetValue,
			selectColumns: overrides.selectColumns ?? this._selectColumns,
			joinClauses: overrides.joinClauses ?? this._joinClauses,
			includedAssociations:
				overrides.includedAssociations ?? this._includedAssociations,
			modelClass: this._modelClass,
			reverseMap: this._reverseMap,
			distinctValue:
				"distinctValue" in overrides
					? overrides.distinctValue
					: this._distinctValue,
			extensions: overrides.extensions
				? { ...this._extensions, ...overrides.extensions }
				: this._extensions,
		});
	}

	where(conditions: WhereConditions<Row>): QueryBuilder<Row> {
		const startParamIndex =
			this._whereClauses.reduce(
				(count, clause) => count + clause.values.length,
				0,
			) + 1;
		const newClauses = compileConditions(
			conditions as Record<string, unknown>,
			this._tableDefinition.columns,
			startParamIndex,
		);
		return this._clone({
			whereClauses: [...this._whereClauses, ...newClauses],
		});
	}

	whereRaw(fragment: string, values?: unknown[]): QueryBuilder<Row> {
		const paramOffset = this._whereClauses.reduce(
			(count, clause) => count + clause.values.length,
			0,
		);

		let renumberedFragment = fragment;
		if (paramOffset > 0 && values && values.length > 0) {
			renumberedFragment = fragment.replace(
				/\$(\d+)/g,
				(_, num) => `$${Number(num) + paramOffset}`,
			);
		}

		return this._clone({
			whereClauses: [
				...this._whereClauses,
				{
					fragment: renumberedFragment,
					values: values ?? [],
					columnNames: null,
				},
			],
		});
	}

	order(
		clause: Partial<Record<keyof Row & string, OrderDirection>>,
	): QueryBuilder<Row> {
		const columns = this._tableDefinition.columns;
		const newClauses: OrderClause[] = [];
		for (const [key, direction] of Object.entries(clause) as [
			string,
			OrderDirection,
		][]) {
			const dbColumn = resolveColumnName(key, columns);
			newClauses.push({ column: dbColumn, direction });
		}
		return this._clone({
			orderClauses: [...this._orderClauses, ...newClauses],
		});
	}

	limit(count: number): QueryBuilder<Row> {
		return this._clone({ limitValue: count });
	}

	offset(count: number): QueryBuilder<Row> {
		return this._clone({ offsetValue: count });
	}

	select(...selectColumns: (keyof Row & string)[]): QueryBuilder<Row> {
		const columns = this._tableDefinition.columns;
		const dbColumns = selectColumns.map((key) =>
			resolveColumnName(key, columns),
		);
		return this._clone({ selectColumns: dbColumns });
	}

	joins(joinClause: string): QueryBuilder<Row> {
		return this._clone({
			joinClauses: [...this._joinClauses, joinClause],
		});
	}

	includes(...associationNames: string[]): QueryBuilder<Row> {
		return this._clone({
			includedAssociations: [
				...this._includedAssociations,
				...associationNames,
			],
		});
	}

	distinct(): QueryBuilder<Row> {
		return this._clone({ distinctValue: true });
	}

	/** @internal */
	_appendJoins(text: string): string {
		for (const joinClause of this._joinClauses) {
			text += ` ${joinClause}`;
		}
		return text;
	}

	/** @internal */
	_appendWhere(
		text: string,
		paramOffset: number,
	): { text: string; values: unknown[] } {
		const values: unknown[] = [];
		if (this._whereClauses.length > 0) {
			const joined = this._whereClauses
				.map((clause) => clause.fragment)
				.join(" AND ");
			const renumbered = renumberParameters(joined, paramOffset);
			text += ` WHERE ${renumbered}`;
			for (const clause of this._whereClauses) {
				values.push(...clause.values);
			}
		}
		return { text, values };
	}

	/** @internal */
	_renderSelect(
		projection: Projection,
		options: RenderOptions,
	): { text: string; values: unknown[] } {
		let columnsClause: string;
		switch (projection.kind) {
			case "default":
				columnsClause =
					this._selectColumns.length > 0
						? this._selectColumns.map(quoteIdentifier).join(", ")
						: options.starColumn;
				break;
			case "columns":
				columnsClause = projection.dbColumns.map(quoteIdentifier).join(", ");
				break;
			case "count":
				columnsClause = "COUNT(*) AS count";
				break;
			case "exists":
				columnsClause = "1";
				break;
		}

		const supportsDistinct =
			projection.kind === "default" || projection.kind === "columns";
		const distinctClause =
			this._distinctValue && supportsDistinct ? "DISTINCT " : "";

		let text = `SELECT ${distinctClause}${columnsClause} FROM ${options.fromClause}`;
		text = this._appendJoins(text);
		const { text: withWhere, values } = this._appendWhere(
			text,
			options.paramOffset,
		);
		text = withWhere;

		const supportsOrdering =
			projection.kind === "default" || projection.kind === "columns";

		if (supportsOrdering && this._orderClauses.length > 0) {
			const orderParts = this._orderClauses.map(
				(clause) => `${quoteIdentifier(clause.column)} ${clause.direction}`,
			);
			text += ` ORDER BY ${orderParts.join(", ")}`;
		}

		if (supportsOrdering && this._limitValue !== null) {
			text += ` LIMIT ${this._limitValue}`;
		}

		if (supportsOrdering && this._offsetValue !== null) {
			text += ` OFFSET ${this._offsetValue}`;
		}

		if (projection.kind === "exists") {
			text += " LIMIT 1";
		}

		return { text, values };
	}

	/** @internal */
	_buildSql(projection: Projection): { text: string; values: unknown[] } {
		const tableName = this._tableDefinition.tableName;
		return this._renderSelect(projection, {
			fromClause: quoteIdentifier(tableName),
			starColumn: `${quoteIdentifier(tableName)}.*`,
			paramOffset: 0,
		});
	}

	toSQL(): { text: string; values: unknown[] } {
		return this._buildSql({ kind: "default" });
	}

	async toArray(): Promise<Row[]> {
		const { text, values } = this.toSQL();
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this._sensitiveColumns,
		);
		const ModelClass = this._modelClass ?? this._tableDefinition.rowClass;

		const results: Row[] = [];
		for (const row of rows) {
			const mapped = mapRowToModel(
				row as Record<string, unknown>,
				this._reverseMap,
			);
			results.push(
				hydrateInstance(ModelClass as new () => object, mapped) as Row,
			);
		}

		if (this._includedAssociations.length > 0 && results.length > 0) {
			const { preloadAssociations } = await import("./associations");
			const firstResult = results[0] as object;
			await preloadAssociations(
				results,
				this._includedAssociations,
				firstResult.constructor,
				this._tableDefinition,
			);
		}

		return results;
	}

	async first(): Promise<Row | null> {
		const limited = this.limit(1);
		const results = await limited.toArray();
		return results[0] ?? null;
	}

	async last(): Promise<Row | null> {
		const primaryKey = this._tableDefinition.primaryKey[0];
		if (!primaryKey) {
			throw new Error("Cannot call last() on a table without a primary key");
		}
		const dbColumn = resolveColumnName(
			primaryKey,
			this._tableDefinition.columns,
		);
		const reordered = this._clone({
			orderClauses: [{ column: dbColumn, direction: "DESC" }],
		}).limit(1);
		const results = await reordered.toArray();
		return results[0] ?? null;
	}

	async count(): Promise<number> {
		const { text, values } = this._buildSql({ kind: "count" });
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this._sensitiveColumns,
		);
		const row = rows[0] as { count: number | string } | undefined;
		return row ? Number(row.count) : 0;
	}

	async exists(): Promise<boolean> {
		const { text, values } = this._buildSql({ kind: "exists" });
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this._sensitiveColumns,
		);
		return rows.length > 0;
	}

	async pluck<Column extends keyof Row & string>(
		column: Column,
	): Promise<Row[Column][]>;
	async pluck<Columns extends readonly (keyof Row & string)[]>(
		...columns: Columns
	): Promise<
		{
			[Index in keyof Columns]: Columns[Index] extends keyof Row
				? Row[Columns[Index]]
				: never;
		}[]
	>;
	async pluck(...columns: (keyof Row & string)[]): Promise<unknown[]> {
		if (columns.length === 0) {
			throw new Error("pluck() requires at least one column");
		}
		const tableColumns = this._tableDefinition.columns;
		const dbColumns = columns.map((column) =>
			resolveColumnName(column, tableColumns),
		);
		const { text, values } = this._buildSql({
			kind: "columns",
			dbColumns,
		});
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this._sensitiveColumns,
		);

		if (columns.length === 1) {
			const dbColumn = dbColumns[0] as string;
			return (rows as Record<string, unknown>[]).map((row) => row[dbColumn]);
		}
		return (rows as Record<string, unknown>[]).map((row) =>
			dbColumns.map((dbColumn) => row[dbColumn]),
		);
	}

	async updateAll(attributes: Partial<Row>): Promise<number> {
		const columns = this._tableDefinition.columns;
		const tableName = this._tableDefinition.tableName;
		const setClauses: string[] = [];
		const setValues: unknown[] = [];
		let paramIndex = 1;

		for (const [key, value] of Object.entries(
			attributes as Record<string, unknown>,
		)) {
			const dbColumn = resolveColumnName(key, columns);
			setClauses.push(`${quoteIdentifier(dbColumn)} = $${paramIndex++}`);
			setValues.push(value);
		}

		let text = `UPDATE ${quoteIdentifier(tableName)} SET ${setClauses.join(", ")}`;

		if (this._whereClauses.length > 0) {
			const whereFragments: string[] = [];
			for (const clause of this._whereClauses) {
				const renumbered = clause.fragment.replace(
					/\$(\d+)/g,
					(_, num) => `$${Number(num) + paramIndex - 1}`,
				);
				whereFragments.push(renumbered);
				setValues.push(...clause.values);
			}
			text += ` WHERE ${whereFragments.join(" AND ")}`;
		}

		const connection = getModelConnection();
		const result = await executeQuery(
			connection,
			text,
			setValues,
			this._sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	async deleteAll(): Promise<number> {
		const tableName = this._tableDefinition.tableName;
		const deleteText = `DELETE FROM ${quoteIdentifier(tableName)}`;
		const { text, values } = this._appendWhere(deleteText, 0);

		const connection = getModelConnection();
		const result = await executeQuery(
			connection,
			text,
			values,
			this._sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	// biome-ignore lint/suspicious/noThenProperty: intentionally thenable so `await User.where(...)` works
	then<TResult1 = Row[], TResult2 = never>(
		onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.toArray().then(onfulfilled, onrejected);
	}

	[SUBQUERY](): SubqueryDescriptor {
		if (this._extensions.recursiveCte) {
			throw new Error(
				"A recursive query cannot be used as a subquery — " +
					"use pluck() to materialize the result, then pass the array to where()",
			);
		}

		let dbColumns: string[];
		if (this._selectColumns.length === 0) {
			const primaryKey = this._tableDefinition.primaryKey;
			if (primaryKey.length !== 1) {
				throw new Error(
					"Cannot use a query as a subquery without select() on a table " +
						"with a composite primary key — call .select(column) first",
				);
			}
			dbColumns = [
				resolveColumnName(
					primaryKey[0] as keyof Row & string,
					this._tableDefinition.columns,
				),
			];
		} else if (this._selectColumns.length === 1) {
			dbColumns = this._selectColumns;
		} else {
			throw new Error(
				"A subquery must project exactly one column — " +
					"call .select() with a single column",
			);
		}

		const { text, values } = this._buildSql({
			kind: "columns",
			dbColumns,
		});
		return { sql: text, values };
	}

	get tableDefinition(): TableDefinition<Row> {
		return this._tableDefinition;
	}

	get includedAssociationNames(): string[] {
		return this._includedAssociations;
	}
}

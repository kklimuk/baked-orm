import type { TableDefinition } from "../types";
import { getModelConnection, isInTransaction } from "./connection";
import {
	buildKnownColumnNames,
	renumberParameters,
	requalifyFragment,
} from "./recursive";
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

type WhereClause = {
	fragment: string;
	values: unknown[];
	/**
	 * DB column names referenced by this clause, or `null` for opaque
	 * `whereRaw` fragments. Used by recursive CTE rendering to decide which
	 * predicates to omit from the recursive step.
	 */
	columnNames: string[] | null;
};

type OrderClause = {
	column: string;
	direction: OrderDirection;
};

type Projection =
	| { kind: "default" }
	| { kind: "columns"; dbColumns: string[] }
	| { kind: "count" }
	| { kind: "exists" };

type CapturedRecursive = {
	whereClauses: WhereClause[];
	fromDbColumn: string;
	toDbColumn: string;
	setSemantics: boolean;
};

type RenderOptions = {
	fromClause: string;
	starColumn: string;
	paramOffset: number;
};

export class QueryBuilder<Row> {
	readonly #tableDefinition: TableDefinition<Row>;
	readonly #reverseMap: Map<string, string>;
	readonly #whereClauses: WhereClause[];
	readonly #orderClauses: OrderClause[];
	readonly #limitValue: number | null;
	readonly #offsetValue: number | null;
	readonly #selectColumns: string[];
	readonly #joinClauses: string[];
	readonly #includedAssociations: string[];
	readonly #modelClass: (new (attributes?: Partial<Row>) => Row) | null;
	readonly #sensitiveColumns: Set<string>;
	readonly #distinctValue: boolean;
	readonly #recursiveCte: CapturedRecursive | null;
	readonly #lockClause: string | null;

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
			recursiveCte?: CapturedRecursive | null;
			lockClause?: string | null;
		},
	) {
		this.#tableDefinition = tableDefinition;
		this.#reverseMap =
			options?.reverseMap ?? buildReverseColumnMap(tableDefinition.columns);
		this.#whereClauses = options?.whereClauses ?? [];
		this.#orderClauses = options?.orderClauses ?? [];
		this.#limitValue = options?.limitValue ?? null;
		this.#offsetValue = options?.offsetValue ?? null;
		this.#selectColumns = options?.selectColumns ?? [];
		this.#joinClauses = options?.joinClauses ?? [];
		this.#includedAssociations = options?.includedAssociations ?? [];
		this.#modelClass = options?.modelClass ?? null;
		this.#sensitiveColumns = options?.modelClass
			? buildSensitiveColumns(options.modelClass, tableDefinition.columns)
			: new Set();
		this.#distinctValue = options?.distinctValue ?? false;
		this.#recursiveCte = options?.recursiveCte ?? null;
		this.#lockClause = options?.lockClause ?? null;
	}

	#clone(overrides: {
		whereClauses?: WhereClause[];
		orderClauses?: OrderClause[];
		limitValue?: number | null;
		offsetValue?: number | null;
		selectColumns?: string[];
		joinClauses?: string[];
		includedAssociations?: string[];
		distinctValue?: boolean;
		recursiveCte?: CapturedRecursive | null;
		lockClause?: string | null;
	}): QueryBuilder<Row> {
		return new QueryBuilder(this.#tableDefinition, {
			whereClauses: overrides.whereClauses ?? this.#whereClauses,
			orderClauses: overrides.orderClauses ?? this.#orderClauses,
			limitValue:
				"limitValue" in overrides ? overrides.limitValue : this.#limitValue,
			offsetValue:
				"offsetValue" in overrides ? overrides.offsetValue : this.#offsetValue,
			selectColumns: overrides.selectColumns ?? this.#selectColumns,
			joinClauses: overrides.joinClauses ?? this.#joinClauses,
			includedAssociations:
				overrides.includedAssociations ?? this.#includedAssociations,
			modelClass: this.#modelClass,
			reverseMap: this.#reverseMap,
			distinctValue:
				"distinctValue" in overrides
					? overrides.distinctValue
					: this.#distinctValue,
			recursiveCte:
				"recursiveCte" in overrides
					? overrides.recursiveCte
					: this.#recursiveCte,
			lockClause:
				"lockClause" in overrides ? overrides.lockClause : this.#lockClause,
		});
	}

	where(conditions: WhereConditions<Row>): QueryBuilder<Row> {
		const startParamIndex =
			this.#whereClauses.reduce(
				(count, clause) => count + clause.values.length,
				0,
			) + 1;
		const newClauses = compileConditions(
			conditions as Record<string, unknown>,
			this.#tableDefinition.columns,
			startParamIndex,
		);
		return this.#clone({
			whereClauses: [...this.#whereClauses, ...newClauses],
		});
	}

	whereRaw(fragment: string, values?: unknown[]): QueryBuilder<Row> {
		const paramOffset = this.#whereClauses.reduce(
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

		return this.#clone({
			whereClauses: [
				...this.#whereClauses,
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
		const columns = this.#tableDefinition.columns;
		const newClauses: OrderClause[] = [];
		for (const [key, direction] of Object.entries(clause) as [
			string,
			OrderDirection,
		][]) {
			const dbColumn = resolveColumnName(key, columns);
			newClauses.push({ column: dbColumn, direction });
		}
		return this.#clone({
			orderClauses: [...this.#orderClauses, ...newClauses],
		});
	}

	limit(count: number): QueryBuilder<Row> {
		return this.#clone({ limitValue: count });
	}

	offset(count: number): QueryBuilder<Row> {
		return this.#clone({ offsetValue: count });
	}

	select(...selectColumns: (keyof Row & string)[]): QueryBuilder<Row> {
		const columns = this.#tableDefinition.columns;
		const dbColumns = selectColumns.map((key) =>
			resolveColumnName(key, columns),
		);
		return this.#clone({ selectColumns: dbColumns });
	}

	joins(joinClause: string): QueryBuilder<Row> {
		return this.#clone({
			joinClauses: [...this.#joinClauses, joinClause],
		});
	}

	includes(...associationNames: string[]): QueryBuilder<Row> {
		return this.#clone({
			includedAssociations: [
				...this.#includedAssociations,
				...associationNames,
			],
		});
	}

	distinct(): QueryBuilder<Row> {
		return this.#clone({ distinctValue: true });
	}

	lock(mode?: string): QueryBuilder<Row> {
		if (this.#recursiveCte) {
			throw new Error(
				"Cannot use lock() on a recursive query — PostgreSQL does not allow FOR UPDATE on CTEs",
			);
		}
		return this.#clone({ lockClause: mode ?? "FOR UPDATE" });
	}

	#assertNoRecursiveCte(operation: string): void {
		if (this.#recursiveCte) {
			throw new Error(
				`Cannot call ${operation}() on a recursive query. Run the recursive scope to a result set first.`,
			);
		}
	}

	recursiveOn(options: {
		from: keyof Row & string;
		to: keyof Row & string;
		setSemantics?: boolean;
	}): QueryBuilder<Row> {
		if (this.#recursiveCte) {
			throw new Error(
				"recursiveOn() cannot be nested — this query already has a recursive CTE applied",
			);
		}
		if (this.#joinClauses.length > 0) {
			throw new Error(
				"recursiveOn() cannot be combined with joins() — apply joins after the recursive scope",
			);
		}
		if (
			this.#orderClauses.length > 0 ||
			this.#limitValue !== null ||
			this.#offsetValue !== null
		) {
			throw new Error(
				"recursiveOn() cannot be combined with order/limit/offset on the seed scope — apply ordering after the recursive scope",
			);
		}

		const columns = this.#tableDefinition.columns;
		const fromDbColumn = resolveColumnName(options.from, columns);
		const toDbColumn = resolveColumnName(options.to, columns);

		const captured: CapturedRecursive = {
			whereClauses: this.#whereClauses,
			fromDbColumn,
			toDbColumn,
			setSemantics: options.setSemantics ?? true,
		};

		return new QueryBuilder<Row>(this.#tableDefinition, {
			whereClauses: [],
			orderClauses: [],
			limitValue: null,
			offsetValue: null,
			selectColumns: this.#selectColumns,
			joinClauses: [],
			includedAssociations: this.#includedAssociations,
			modelClass: this.#modelClass,
			reverseMap: this.#reverseMap,
			distinctValue: this.#distinctValue,
			recursiveCte: captured,
		});
	}

	descendants(options: { via: keyof Row & string }): QueryBuilder<Row> {
		const primaryKey = this.#tableDefinition.primaryKey;
		if (primaryKey.length !== 1) {
			throw new Error(
				"descendants() requires a single-column primary key on the table",
			);
		}
		return this.recursiveOn({
			from: options.via,
			to: primaryKey[0] as keyof Row & string,
		});
	}

	ancestors(options: { via: keyof Row & string }): QueryBuilder<Row> {
		const primaryKey = this.#tableDefinition.primaryKey;
		if (primaryKey.length !== 1) {
			throw new Error(
				"ancestors() requires a single-column primary key on the table",
			);
		}
		return this.recursiveOn({
			from: primaryKey[0] as keyof Row & string,
			to: options.via,
		});
	}

	#appendJoins(text: string): string {
		for (const joinClause of this.#joinClauses) {
			text += ` ${joinClause}`;
		}
		return text;
	}

	#appendWhere(
		text: string,
		paramOffset: number,
	): { text: string; values: unknown[] } {
		const values: unknown[] = [];
		if (this.#whereClauses.length > 0) {
			const joined = this.#whereClauses
				.map((clause) => clause.fragment)
				.join(" AND ");
			const renumbered = renumberParameters(joined, paramOffset);
			text += ` WHERE ${renumbered}`;
			for (const clause of this.#whereClauses) {
				values.push(...clause.values);
			}
		}
		return { text, values };
	}

	#renderSelect(
		projection: Projection,
		options: RenderOptions,
	): { text: string; values: unknown[] } {
		let columnsClause: string;
		switch (projection.kind) {
			case "default":
				columnsClause =
					this.#selectColumns.length > 0
						? this.#selectColumns.map(quoteIdentifier).join(", ")
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
			this.#distinctValue && supportsDistinct ? "DISTINCT " : "";

		let text = `SELECT ${distinctClause}${columnsClause} FROM ${options.fromClause}`;
		text = this.#appendJoins(text);
		const { text: withWhere, values } = this.#appendWhere(
			text,
			options.paramOffset,
		);
		text = withWhere;

		const supportsOrdering =
			projection.kind === "default" || projection.kind === "columns";

		if (supportsOrdering && this.#orderClauses.length > 0) {
			const orderParts = this.#orderClauses.map(
				(clause) => `${quoteIdentifier(clause.column)} ${clause.direction}`,
			);
			text += ` ORDER BY ${orderParts.join(", ")}`;
		}

		if (supportsOrdering && this.#limitValue !== null) {
			text += ` LIMIT ${this.#limitValue}`;
		}

		if (supportsOrdering && this.#offsetValue !== null) {
			text += ` OFFSET ${this.#offsetValue}`;
		}

		if (projection.kind === "exists") {
			text += " LIMIT 1";
		}

		if (
			this.#lockClause &&
			(projection.kind === "default" || projection.kind === "columns")
		) {
			text += ` ${this.#lockClause}`;
		}

		return { text, values };
	}

	#buildCte(captured: CapturedRecursive): {
		text: string;
		values: unknown[];
	} {
		const tableName = this.#tableDefinition.tableName;
		const knownColumns = buildKnownColumnNames(this.#tableDefinition.columns);
		const joinColumns = new Set([captured.fromDbColumn, captured.toDbColumn]);

		// Anchor: SELECT "<table>".* FROM "<table>" [WHERE all_captured_where]
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

		// Step: SELECT "child".* FROM "<table>" "child"
		//       INNER JOIN __traversal "parent" ON "child"."<from>" = "parent"."<to>"
		//       [WHERE propagating_where_clauses requalified+renumbered]
		//
		// We omit clauses that filter on the join columns themselves — those
		// only seed the anchor; if propagated to the step they would prune the
		// recursion. `whereRaw` clauses (columnNames === null) always propagate.
		const childAlias = "child";
		const parentAlias = "parent";
		let stepText = `SELECT ${quoteIdentifier(childAlias)}.* FROM ${quoteIdentifier(tableName)} ${quoteIdentifier(childAlias)} INNER JOIN __traversal ${quoteIdentifier(parentAlias)} ON ${quoteIdentifier(childAlias)}.${quoteIdentifier(captured.fromDbColumn)} = ${quoteIdentifier(parentAlias)}.${quoteIdentifier(captured.toDbColumn)}`;
		const stepValues: unknown[] = [];
		const stepFragments: string[] = [];
		let originalParamIndex = 1; // position in anchor (full) numbering
		let stepParamIndex = anchorValues.length + 1; // position in combined values

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

	#buildSql(projection: Projection): { text: string; values: unknown[] } {
		const tableName = this.#tableDefinition.tableName;
		if (!this.#recursiveCte) {
			return this.#renderSelect(projection, {
				fromClause: quoteIdentifier(tableName),
				starColumn: `${quoteIdentifier(tableName)}.*`,
				paramOffset: 0,
			});
		}
		const cte = this.#buildCte(this.#recursiveCte);
		const outer = this.#renderSelect(projection, {
			fromClause: "__traversal",
			starColumn: "__traversal.*",
			paramOffset: cte.values.length,
		});
		return {
			text: `${cte.text} ${outer.text}`,
			values: [...cte.values, ...outer.values],
		};
	}

	toSQL(): { text: string; values: unknown[] } {
		return this.#buildSql({ kind: "default" });
	}

	#assertLockInTransaction(): void {
		if (this.#lockClause && !isInTransaction()) {
			throw new Error(
				"lock() requires a transaction — a locked row without a transaction boundary releases immediately. Wrap your query in transaction()",
			);
		}
	}

	async toArray(): Promise<Row[]> {
		this.#assertLockInTransaction();
		const { text, values } = this.toSQL();
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
		);
		const ModelClass = this.#modelClass ?? this.#tableDefinition.rowClass;

		const results: Row[] = [];
		for (const row of rows) {
			const mapped = mapRowToModel(
				row as Record<string, unknown>,
				this.#reverseMap,
			);
			results.push(
				hydrateInstance(ModelClass as new () => object, mapped) as Row,
			);
		}

		if (this.#includedAssociations.length > 0 && results.length > 0) {
			const { preloadAssociations } = await import("./associations");
			const firstResult = results[0] as object;
			await preloadAssociations(
				results,
				this.#includedAssociations,
				firstResult.constructor,
				this.#tableDefinition,
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
		const primaryKey = this.#tableDefinition.primaryKey[0];
		if (!primaryKey) {
			throw new Error("Cannot call last() on a table without a primary key");
		}
		const dbColumn = resolveColumnName(
			primaryKey,
			this.#tableDefinition.columns,
		);
		const reordered = this.#clone({
			orderClauses: [{ column: dbColumn, direction: "DESC" }],
		}).limit(1);
		const results = await reordered.toArray();
		return results[0] ?? null;
	}

	async count(): Promise<number> {
		const { text, values } = this.#buildSql({ kind: "count" });
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
		);
		const row = rows[0] as { count: number | string } | undefined;
		return row ? Number(row.count) : 0;
	}

	async exists(): Promise<boolean> {
		const { text, values } = this.#buildSql({ kind: "exists" });
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
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
		const tableColumns = this.#tableDefinition.columns;
		const dbColumns = columns.map((column) =>
			resolveColumnName(column, tableColumns),
		);
		const { text, values } = this.#buildSql({
			kind: "columns",
			dbColumns,
		});
		const connection = getModelConnection();
		const rows = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
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
		this.#assertNoRecursiveCte("updateAll");
		const columns = this.#tableDefinition.columns;
		const tableName = this.#tableDefinition.tableName;
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

		if (this.#whereClauses.length > 0) {
			const whereFragments: string[] = [];
			for (const clause of this.#whereClauses) {
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
			this.#sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	async deleteAll(): Promise<number> {
		this.#assertNoRecursiveCte("deleteAll");
		const tableName = this.#tableDefinition.tableName;
		const deleteText = `DELETE FROM ${quoteIdentifier(tableName)}`;
		const { text, values } = this.#appendWhere(deleteText, 0);

		const connection = getModelConnection();
		const result = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	#resolveDiscardedAtColumn(): string {
		const entry = Object.entries(this.#tableDefinition.columns).find(
			([, definition]) => definition.columnName === "discarded_at",
		);
		if (!entry) {
			throw new Error(
				`Cannot call discardAll()/undiscardAll(): table "${this.#tableDefinition.tableName}" does not have a "discarded_at" column`,
			);
		}
		return entry[1].columnName;
	}

	async discardAll(): Promise<number> {
		this.#assertNoRecursiveCte("discardAll");
		const columnName = this.#resolveDiscardedAtColumn();
		const tableName = this.#tableDefinition.tableName;
		const updateText = `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = now()`;
		const { text, values } = this.#appendWhere(updateText, 0);

		const connection = getModelConnection();
		const result = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	async undiscardAll(): Promise<number> {
		this.#assertNoRecursiveCte("undiscardAll");
		const columnName = this.#resolveDiscardedAtColumn();
		const tableName = this.#tableDefinition.tableName;
		const updateText = `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = NULL`;
		const { text, values } = this.#appendWhere(updateText, 0);

		const connection = getModelConnection();
		const result = await executeQuery(
			connection,
			text,
			values,
			this.#sensitiveColumns,
		);
		return (result as unknown as { count: number }).count;
	}

	async findEach(
		callback: (record: Row) => void | Promise<void>,
		options?: { batchSize?: number },
	): Promise<void> {
		const batchSize = options?.batchSize ?? 1000;
		const primaryKey = this.#tableDefinition.primaryKey[0];
		if (!primaryKey) {
			throw new Error(
				"Cannot call findEach() on a table without a primary key",
			);
		}
		const dbColumn = resolveColumnName(
			primaryKey,
			this.#tableDefinition.columns,
		);

		let cursor: unknown = null;
		for (;;) {
			let batch = this.order({
				[primaryKey]: "ASC",
			} as Partial<Record<keyof Row & string, OrderDirection>>).limit(
				batchSize,
			);
			if (cursor !== null) {
				batch = batch.whereRaw(`${quoteIdentifier(dbColumn)} > $1`, [cursor]);
			}
			const records = await batch.toArray();
			if (records.length === 0) break;

			for (const record of records) {
				await callback(record);
			}

			const lastRecord = records[records.length - 1] as Record<string, unknown>;
			cursor = lastRecord[primaryKey];
		}
	}

	async findInBatches(
		callback: (batch: Row[]) => void | Promise<void>,
		options?: { batchSize?: number },
	): Promise<void> {
		const batchSize = options?.batchSize ?? 1000;
		const primaryKey = this.#tableDefinition.primaryKey[0];
		if (!primaryKey) {
			throw new Error(
				"Cannot call findInBatches() on a table without a primary key",
			);
		}
		const dbColumn = resolveColumnName(
			primaryKey,
			this.#tableDefinition.columns,
		);

		let cursor: unknown = null;
		for (;;) {
			let batch = this.order({
				[primaryKey]: "ASC",
			} as Partial<Record<keyof Row & string, OrderDirection>>).limit(
				batchSize,
			);
			if (cursor !== null) {
				batch = batch.whereRaw(`${quoteIdentifier(dbColumn)} > $1`, [cursor]);
			}
			const records = await batch.toArray();
			if (records.length === 0) break;

			await callback(records);

			const lastRecord = records[records.length - 1] as Record<string, unknown>;
			cursor = lastRecord[primaryKey];
		}
	}

	// biome-ignore lint/suspicious/noThenProperty: intentionally thenable so `await User.where(...)` works
	then<TResult1 = Row[], TResult2 = never>(
		onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.toArray().then(onfulfilled, onrejected);
	}

	[SUBQUERY](): SubqueryDescriptor {
		if (this.#recursiveCte) {
			throw new Error(
				"A recursive query cannot be used as a subquery — " +
					"use pluck() to materialize the result, then pass the array to where()",
			);
		}

		let dbColumns: string[];
		if (this.#selectColumns.length === 0) {
			const primaryKey = this.#tableDefinition.primaryKey;
			if (primaryKey.length !== 1) {
				throw new Error(
					"Cannot use a query as a subquery without select() on a table " +
						"with a composite primary key — call .select(column) first",
				);
			}
			dbColumns = [
				resolveColumnName(
					primaryKey[0] as keyof Row & string,
					this.#tableDefinition.columns,
				),
			];
		} else if (this.#selectColumns.length === 1) {
			dbColumns = this.#selectColumns;
		} else {
			throw new Error(
				"A subquery must project exactly one column — " +
					"call .select() with a single column",
			);
		}

		const { text, values } = this.#buildSql({
			kind: "columns",
			dbColumns,
		});
		return { sql: text, values };
	}

	get tableDefinition(): TableDefinition<Row> {
		return this.#tableDefinition;
	}

	get includedAssociationNames(): string[] {
		return this.#includedAssociations;
	}
}

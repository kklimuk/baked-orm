import type { TableDefinition } from "../types";
import { getModelConnection } from "./connection";
import type { OrderDirection } from "./types";
import {
	buildReverseColumnMap,
	executeQuery,
	hydrateInstance,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "./utils";

type WhereClause = {
	fragment: string;
	values: unknown[];
};

type OrderClause = {
	column: string;
	direction: OrderDirection;
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
	}

	#clone(overrides: {
		whereClauses?: WhereClause[];
		orderClauses?: OrderClause[];
		limitValue?: number | null;
		offsetValue?: number | null;
		selectColumns?: string[];
		joinClauses?: string[];
		includedAssociations?: string[];
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
		});
	}

	where(conditions: Partial<Row>): QueryBuilder<Row> {
		const columns = this.#tableDefinition.columns;
		const fragments: string[] = [];
		const values: unknown[] = [];
		let paramIndex =
			this.#whereClauses.reduce(
				(count, clause) => count + clause.values.length,
				0,
			) + 1;

		for (const [key, value] of Object.entries(
			conditions as Record<string, unknown>,
		)) {
			const dbColumn = resolveColumnName(key, columns);
			if (value === null || value === undefined) {
				fragments.push(`${quoteIdentifier(dbColumn)} IS NULL`);
			} else if (Array.isArray(value)) {
				const placeholders = value.map(() => `$${paramIndex++}`);
				fragments.push(
					`${quoteIdentifier(dbColumn)} IN (${placeholders.join(", ")})`,
				);
				values.push(...value);
			} else {
				fragments.push(`${quoteIdentifier(dbColumn)} = $${paramIndex++}`);
				values.push(value);
			}
		}

		const clause: WhereClause = {
			fragment: fragments.join(" AND "),
			values,
		};

		return this.#clone({
			whereClauses: [...this.#whereClauses, clause],
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
				{ fragment: renumberedFragment, values: values ?? [] },
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

	toSQL(): { text: string; values: unknown[] } {
		const tableName = this.#tableDefinition.tableName;
		const columns =
			this.#selectColumns.length > 0
				? this.#selectColumns.map(quoteIdentifier).join(", ")
				: `${quoteIdentifier(tableName)}.*`;

		let text = `SELECT ${columns} FROM ${quoteIdentifier(tableName)}`;

		for (const joinClause of this.#joinClauses) {
			text += ` ${joinClause}`;
		}

		const allValues: unknown[] = [];
		if (this.#whereClauses.length > 0) {
			const whereFragments = this.#whereClauses.map(
				(clause) => clause.fragment,
			);
			text += ` WHERE ${whereFragments.join(" AND ")}`;
			for (const clause of this.#whereClauses) {
				allValues.push(...clause.values);
			}
		}

		if (this.#orderClauses.length > 0) {
			const orderParts = this.#orderClauses.map(
				(clause) => `${quoteIdentifier(clause.column)} ${clause.direction}`,
			);
			text += ` ORDER BY ${orderParts.join(", ")}`;
		}

		if (this.#limitValue !== null) {
			text += ` LIMIT ${this.#limitValue}`;
		}

		if (this.#offsetValue !== null) {
			text += ` OFFSET ${this.#offsetValue}`;
		}

		return { text, values: allValues };
	}

	async toArray(): Promise<Row[]> {
		const { text, values } = this.toSQL();
		const connection = getModelConnection();
		const rows = await executeQuery(connection, text, values);
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
		const { values } = this.toSQL();
		const tableName = this.#tableDefinition.tableName;

		let text = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

		for (const joinClause of this.#joinClauses) {
			text += ` ${joinClause}`;
		}

		if (this.#whereClauses.length > 0) {
			const whereFragments = this.#whereClauses.map(
				(clause) => clause.fragment,
			);
			text += ` WHERE ${whereFragments.join(" AND ")}`;
		}

		const connection = getModelConnection();
		const rows = await executeQuery(connection, text, values);
		const row = rows[0] as { count: number | string } | undefined;
		return row ? Number(row.count) : 0;
	}

	async exists(): Promise<boolean> {
		const { values } = this.toSQL();
		const tableName = this.#tableDefinition.tableName;

		let text = `SELECT 1 FROM ${quoteIdentifier(tableName)}`;

		for (const joinClause of this.#joinClauses) {
			text += ` ${joinClause}`;
		}

		if (this.#whereClauses.length > 0) {
			const whereFragments = this.#whereClauses.map(
				(clause) => clause.fragment,
			);
			text += ` WHERE ${whereFragments.join(" AND ")}`;
		}

		text += " LIMIT 1";

		const connection = getModelConnection();
		const rows = await executeQuery(connection, text, values);
		return rows.length > 0;
	}

	async updateAll(attributes: Partial<Row>): Promise<number> {
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
		const result = await executeQuery(connection, text, setValues);
		return (result as unknown as { count: number }).count;
	}

	async deleteAll(): Promise<number> {
		const tableName = this.#tableDefinition.tableName;
		let text = `DELETE FROM ${quoteIdentifier(tableName)}`;
		const allValues: unknown[] = [];

		if (this.#whereClauses.length > 0) {
			const whereFragments = this.#whereClauses.map(
				(clause) => clause.fragment,
			);
			text += ` WHERE ${whereFragments.join(" AND ")}`;
			for (const clause of this.#whereClauses) {
				allValues.push(...clause.values);
			}
		}

		const connection = getModelConnection();
		const result = await executeQuery(connection, text, allValues);
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

	get tableDefinition(): TableDefinition<Row> {
		return this.#tableDefinition;
	}

	get includedAssociationNames(): string[] {
		return this.#includedAssociations;
	}
}

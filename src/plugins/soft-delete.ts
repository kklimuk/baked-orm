import { assertNoRecursiveCte } from "../common/query";
import { runCallbacks } from "../model/callbacks";
import { getModelConnection } from "../model/connection";
import type { QueryBuilder } from "../model/query";
import {
	buildReverseColumnMap,
	buildSensitiveColumns,
	executeQuery,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "../model/utils";
import type { TableDefinition } from "../types";
import { definePlugin } from "./index";

definePlugin({
	name: "softDelete",
	instance: {
		async discard(this: Record<string, unknown>): Promise<void> {
			await runDiscardLifecycle(this, "discard", "now()");
		},

		async undiscard(this: Record<string, unknown>): Promise<void> {
			await runDiscardLifecycle(this, "undiscard", "NULL");
		},

		isDiscarded: {
			get(this: Record<string, unknown>): boolean {
				return (
					(this as unknown as { discardedAt: unknown }).discardedAt != null
				);
			},
			configurable: true,
			enumerable: false,
		} satisfies PropertyDescriptor,

		isKept: {
			get(this: Record<string, unknown>): boolean {
				return (
					(this as unknown as { discardedAt: unknown }).discardedAt == null
				);
			},
			configurable: true,
			enumerable: false,
		} satisfies PropertyDescriptor,
	},
	static: {
		kept(this: Record<string, unknown>): unknown {
			requireSoftDeleteOnModel(this, "kept");
			return (this as unknown as { all: () => { kept: () => unknown } })
				.all()
				.kept();
		},

		discarded(this: Record<string, unknown>): unknown {
			requireSoftDeleteOnModel(this, "discarded");
			return (this as unknown as { all: () => { discarded: () => unknown } })
				.all()
				.discarded();
		},
	},
	queryBuilder: {
		kept(
			this: QueryBuilder<Record<string, unknown>>,
		): QueryBuilder<Record<string, unknown>> {
			requireSoftDeleteOnQuery(this, "kept");
			const columnName = getDiscardedAtDbColumn(
				this._tableDefinition.columns,
				this._tableDefinition.tableName,
			);
			return this.whereRaw(`${quoteIdentifier(columnName)} IS NULL`);
		},

		discarded(
			this: QueryBuilder<Record<string, unknown>>,
		): QueryBuilder<Record<string, unknown>> {
			requireSoftDeleteOnQuery(this, "discarded");
			const columnName = getDiscardedAtDbColumn(
				this._tableDefinition.columns,
				this._tableDefinition.tableName,
			);
			return this.whereRaw(`${quoteIdentifier(columnName)} IS NOT NULL`);
		},

		async discardAll(
			this: QueryBuilder<Record<string, unknown>>,
		): Promise<number> {
			assertNoRecursiveCte(this._extensions, "discardAll");
			const columnName = resolveDiscardedAtColumn(this._tableDefinition);
			const tableName = this._tableDefinition.tableName;
			const updateText = `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = now()`;
			const { text, values } = this._appendWhere(updateText, 0);

			const connection = getModelConnection();
			const result = await executeQuery(
				connection,
				text,
				values,
				this._sensitiveColumns,
			);
			return (result as unknown as { count: number }).count;
		},

		async undiscardAll(
			this: QueryBuilder<Record<string, unknown>>,
		): Promise<number> {
			assertNoRecursiveCte(this._extensions, "undiscardAll");
			const columnName = resolveDiscardedAtColumn(this._tableDefinition);
			const tableName = this._tableDefinition.tableName;
			const updateText = `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = NULL`;
			const { text, values } = this._appendWhere(updateText, 0);

			const connection = getModelConnection();
			const result = await executeQuery(
				connection,
				text,
				values,
				this._sensitiveColumns,
			);
			return (result as unknown as { count: number }).count;
		},
	},
});

function requireSoftDeleteOnQuery(
	query: QueryBuilder<Record<string, unknown>>,
	method: string,
): void {
	const modelClass = query._modelClass as unknown as {
		softDelete?: boolean;
		name?: string;
	} | null;
	if (!modelClass?.softDelete) {
		throw new Error(
			`Cannot call ${method}() on a query builder for ${modelClass?.name ?? "this model"}: softDelete is not enabled`,
		);
	}
}

function requireSoftDeleteOnModel(
	modelClass: Record<string, unknown>,
	method: string,
): void {
	if (!modelClass.softDelete) {
		throw new Error(
			`Cannot call ${method}() on ${(modelClass as { name: string }).name}: softDelete is not enabled on this model`,
		);
	}
}

declare module "../model/types" {
	interface BaseModel {
		discard(): Promise<void>;
		undiscard(): Promise<void>;
		readonly isDiscarded: boolean;
		readonly isKept: boolean;
	}

	interface ModelStatic<Row> {
		kept<Self extends ModelStatic<Row>>(
			this: Self,
		): QueryBuilder<InstanceType<Self>>;
		discarded<Self extends ModelStatic<Row>>(
			this: Self,
		): QueryBuilder<InstanceType<Self>>;
	}
}

declare module "../model/query" {
	interface QueryBuilder<Row> {
		kept(): QueryBuilder<Row>;
		discarded(): QueryBuilder<Row>;
		discardAll(): Promise<number>;
		undiscardAll(): Promise<number>;
	}
}

async function runDiscardLifecycle(
	instance: Record<string, unknown>,
	method: "discard" | "undiscard",
	setValue: string,
): Promise<void> {
	const modelClass = instance.constructor as unknown as Record<string, unknown>;
	requireSoftDelete(
		modelClass,
		(instance as { isNewRecord: boolean }).isNewRecord,
		(instance.constructor as { name: string }).name,
		method,
	);
	const tableDefinition = (
		modelClass as unknown as { tableDefinition: TableDefinition }
	).tableDefinition;
	const beforeHook = method === "discard" ? "beforeDiscard" : "beforeUndiscard";
	const afterHook = method === "discard" ? "afterDiscard" : "afterUndiscard";
	await runCallbacks(beforeHook, instance, modelClass);
	await performDiscard(instance, setValue, tableDefinition);
	(instance as { _captureSnapshot: () => void })._captureSnapshot();
	await runCallbacks(afterHook, instance, modelClass);
}

const discardedAtColumnCache = new Map<string, string>();

function getDiscardedAtDbColumn(
	columns: Record<string, { columnName: string }>,
	tableName: string,
): string {
	const cached = discardedAtColumnCache.get(tableName);
	if (cached) return cached;
	const definition = (
		columns as Record<string, { columnName: string } | undefined>
	).discardedAt;
	if (!definition) {
		throw new Error(
			`softDelete is enabled but table "${tableName}" does not have a "discarded_at" column. Run: bun bake db generate soft_delete_${tableName}`,
		);
	}
	discardedAtColumnCache.set(tableName, definition.columnName);
	return definition.columnName;
}

function requireSoftDelete(
	modelClass: Record<string, unknown>,
	isNewRecord: boolean,
	constructorName: string,
	method: string,
): void {
	if (!modelClass.softDelete) {
		throw new Error(
			`Cannot ${method} ${constructorName}: softDelete is not enabled on this model`,
		);
	}
	if (isNewRecord) {
		throw new Error(`Cannot ${method} a new record. Save it first.`);
	}
}

function resolveDiscardedAtColumn(tableDefinition: TableDefinition): string {
	const entry = Object.entries(tableDefinition.columns).find(
		([, definition]) => definition.columnName === "discarded_at",
	);
	if (!entry) {
		throw new Error(
			`Cannot call discardAll()/undiscardAll(): table "${tableDefinition.tableName}" does not have a "discarded_at" column`,
		);
	}
	return entry[1].columnName;
}

async function performDiscard(
	instance: Record<string, unknown>,
	setValue: string,
	tableDefinition: TableDefinition,
): Promise<void> {
	const columns = tableDefinition.columns;
	const tableName = tableDefinition.tableName;
	const primaryKeyField = tableDefinition.primaryKey[0] ?? "id";
	const connection = getModelConnection();
	const sensitiveDbColumns = buildSensitiveColumns(
		instance.constructor,
		columns,
	);
	const reverseMap = buildReverseColumnMap(columns);
	const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
	const discardedAtDbColumn = getDiscardedAtDbColumn(columns, tableName);
	const text = `UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(discardedAtDbColumn)} = ${setValue} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1 RETURNING *`;
	const rows = await executeQuery(
		connection,
		text,
		[instance[primaryKeyField]],
		sensitiveDbColumns,
	);
	const row = rows[0] as Record<string, unknown> | undefined;
	if (row) {
		Object.assign(instance, mapRowToModel(row, reverseMap));
	}
}

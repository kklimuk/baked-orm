import {
	assertNoRecursiveCte,
	type Projection,
	type RenderOptions,
} from "../common/query";
import {
	getModelConnection,
	isInTransaction,
	transaction,
} from "../model/connection";
import { QueryBuilder } from "../model/query";
import type { LockMode } from "../model/types";
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
	name: "locking",
	queryBuilder: {
		lock(
			this: QueryBuilder<Record<string, unknown>>,
			mode?: string,
		): QueryBuilder<Record<string, unknown>> {
			assertNoRecursiveCte(this._extensions, "lock");
			return this._clone({
				extensions: { lockClause: mode ?? "FOR UPDATE" },
			});
		},
	},
	instance: {
		async lock(this: Record<string, unknown>, mode?: string): Promise<void> {
			if ((this as { isNewRecord: boolean }).isNewRecord) {
				throw new Error("Cannot lock a new record. Save it first.");
			}
			if (!isInTransaction()) {
				throw new Error(
					"lock() requires a transaction — a locked row without a transaction boundary releases immediately. Wrap your call in transaction()",
				);
			}
			const modelClass = this.constructor as unknown as {
				tableDefinition: TableDefinition;
			};
			const tableDefinition = modelClass.tableDefinition;
			const columns = tableDefinition.columns;
			const tableName = tableDefinition.tableName;
			const primaryKeyField = tableDefinition.primaryKey[0] ?? "id";
			const connection = getModelConnection();
			const sensitiveDbColumns = buildSensitiveColumns(
				this.constructor,
				columns,
			);
			const reverseMap = buildReverseColumnMap(columns);
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const lockClause = mode ?? "FOR UPDATE";
			const text = `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1 ${lockClause}`;
			const rows = await executeQuery(
				connection,
				text,
				[this[primaryKeyField]],
				sensitiveDbColumns,
			);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			(this as { _captureSnapshot: () => void })._captureSnapshot();
		},

		async withLock(
			this: Record<string, unknown>,
			callback: (record: unknown) => Promise<unknown>,
			mode?: string,
		): Promise<unknown> {
			if ((this as { isNewRecord: boolean }).isNewRecord) {
				throw new Error("Cannot lock a new record. Save it first.");
			}
			return transaction(async () => {
				await (this as { lock: (mode?: string) => Promise<void> }).lock(mode);
				return callback(this);
			});
		},
	},
});

const originalRenderSelect = QueryBuilder.prototype._renderSelect;

QueryBuilder.prototype._renderSelect = function _renderSelect(
	this: QueryBuilder<unknown>,
	projection: Projection,
	options: RenderOptions,
): { text: string; values: unknown[] } {
	const result = originalRenderSelect.call(this, projection, options);
	const lockClause = this._extensions.lockClause as string | undefined;
	if (
		lockClause &&
		(projection.kind === "default" || projection.kind === "columns")
	) {
		result.text += ` ${lockClause}`;
	}
	return result;
};

const originalToArray = QueryBuilder.prototype.toArray;

QueryBuilder.prototype.toArray = async function toArray(
	this: QueryBuilder<unknown>,
): Promise<unknown[]> {
	const lockClause = this._extensions.lockClause as string | undefined;
	if (lockClause && !isInTransaction()) {
		throw new Error(
			"lock() requires a transaction — a locked row without a transaction boundary releases immediately. Wrap your query in transaction()",
		);
	}
	return originalToArray.call(this);
};

declare module "../model/types" {
	interface BaseModel {
		lock(mode?: LockMode): Promise<void>;
		withLock<Result>(
			callback: (record: this) => Promise<Result>,
			mode?: LockMode,
		): Promise<Result>;
	}
}

declare module "../model/query" {
	interface QueryBuilder<Row> {
		lock(mode?: string): QueryBuilder<Row>;
	}
}

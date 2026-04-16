import type { QueryBuilder } from "../model/query";
import type { OrderDirection } from "../model/types";
import { quoteIdentifier, resolveColumnName } from "../model/utils";
import type { TableDefinition } from "../types";
import { definePlugin } from "./index";

definePlugin({
	name: "batchIteration",
	queryBuilder: {
		async *findEach(
			this: QueryBuilder<Record<string, unknown>>,
			options?: BatchOptions<Record<string, unknown>>,
		): AsyncIterableIterator<Record<string, unknown>> {
			for await (const batch of batchCursor(this, options)) {
				for (const record of batch) {
					yield record;
				}
			}
		},

		async *findInBatches(
			this: QueryBuilder<Record<string, unknown>>,
			options?: BatchOptions<Record<string, unknown>>,
		): AsyncIterableIterator<Record<string, unknown>[]> {
			yield* batchCursor(this, options);
		},
	},
});

declare module "../model/query" {
	interface QueryBuilder<Row> {
		findEach(options?: {
			batchSize?: number;
			order?: Partial<Record<keyof Row & string, OrderDirection>>;
		}): AsyncIterableIterator<Row>;
		findInBatches(options?: {
			batchSize?: number;
			order?: Partial<Record<keyof Row & string, OrderDirection>>;
		}): AsyncIterableIterator<Row[]>;
	}
}

type BatchOptions<Row> = {
	batchSize?: number;
	order?: Partial<Record<keyof Row & string, OrderDirection>>;
};

async function* batchCursor(
	queryBuilder: QueryBuilder<Record<string, unknown>>,
	options?: BatchOptions<Record<string, unknown>>,
): AsyncIterableIterator<Record<string, unknown>[]> {
	const config = resolveCursorConfig(queryBuilder._tableDefinition, options);

	let cursor: unknown = null;
	while (true) {
		const records = await buildBatchQuery(
			queryBuilder,
			config,
			cursor,
		).toArray();
		if (records.length === 0) break;

		yield records;

		const lastRecord = records[records.length - 1] as Record<string, unknown>;
		cursor = lastRecord[config.cursorColumn];
	}
}

type CursorConfig = {
	batchSize: number;
	cursorColumn: string;
	dbColumn: string;
	comparator: ">" | "<";
	orderClause: Partial<Record<string, OrderDirection>>;
};

function resolveCursorConfig(
	tableDefinition: TableDefinition,
	options?: BatchOptions<Record<string, unknown>>,
): CursorConfig {
	const batchSize = options?.batchSize ?? 1000;
	const orderEntries = options?.order ? Object.entries(options.order) : null;

	if (orderEntries && orderEntries.length > 0) {
		const [cursorColumn, direction] = orderEntries[0] as [
			string,
			OrderDirection,
		];
		return {
			batchSize,
			cursorColumn,
			dbColumn: resolveColumnName(cursorColumn, tableDefinition.columns),
			comparator: direction === "ASC" ? ">" : "<",
			orderClause: options?.order as Partial<Record<string, OrderDirection>>,
		};
	}

	const primaryKey = tableDefinition.primaryKey[0];
	if (!primaryKey) {
		throw new Error(
			"Cannot call findEach()/findInBatches() on a table without a primary key. Provide an explicit order option.",
		);
	}
	return {
		batchSize,
		cursorColumn: primaryKey,
		dbColumn: resolveColumnName(primaryKey, tableDefinition.columns),
		comparator: ">",
		orderClause: { [primaryKey]: "ASC" as OrderDirection },
	};
}

function buildBatchQuery(
	queryBuilder: QueryBuilder<Record<string, unknown>>,
	config: CursorConfig,
	cursor: unknown,
): QueryBuilder<Record<string, unknown>> {
	const batch = queryBuilder.order(config.orderClause).limit(config.batchSize);
	if (cursor === null) return batch;
	return batch.whereRaw(
		`${quoteIdentifier(config.dbColumn)} ${config.comparator} $1`,
		[cursor],
	);
}

import type { SQL } from "bun";
import type { ColumnDefinition } from "../types";
import { getQueryLogger } from "./connection";

/** Executes a SQL query with optional logging. Returns the raw Bun.sql result (array-like with .count). */
export async function executeQuery(
	connection: SQL,
	text: string,
	values?: unknown[],
	// biome-ignore lint/suspicious/noExplicitAny: Bun.sql result is both array-like and has metadata properties
): Promise<any[]> {
	const logger = getQueryLogger();
	if (logger) {
		const start = performance.now();
		const result = await connection.unsafe(text, values);
		const durationMs = performance.now() - start;
		logger({ text, values, durationMs });
		return result;
	}
	return connection.unsafe(text, values);
}

export function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export function resolveColumnName(
	camelKey: string,
	columns: Record<string, ColumnDefinition>,
): string {
	const definition = columns[camelKey];
	if (definition) return definition.columnName;
	return camelKey;
}

export function buildReverseColumnMap(
	columns: Record<string, ColumnDefinition>,
): Map<string, string> {
	const reverseMap = new Map<string, string>();
	for (const [camelKey, definition] of Object.entries(columns)) {
		reverseMap.set(definition.columnName, camelKey);
	}
	return reverseMap;
}

export function mapRowToModel(
	row: Record<string, unknown>,
	reverseMap: Map<string, string>,
): Record<string, unknown> {
	const mapped: Record<string, unknown> = {};
	for (const [dbColumn, value] of Object.entries(row)) {
		const camelKey = reverseMap.get(dbColumn) ?? dbColumn;
		mapped[camelKey] = value;
	}
	return mapped;
}

export function buildConflictClause(
	dbColumns: string[],
	conflictColumnsCamel: string[],
	columns: Record<string, ColumnDefinition>,
): { conflictClause: string; updateSet: string } {
	const conflictDbColumns = conflictColumnsCamel.map((key) =>
		resolveColumnName(key, columns),
	);
	const updateClauses = dbColumns
		.filter((dbColumn) => !conflictDbColumns.includes(dbColumn))
		.map(
			(dbColumn) =>
				`${quoteIdentifier(dbColumn)} = EXCLUDED.${quoteIdentifier(dbColumn)}`,
		);
	return {
		conflictClause: conflictDbColumns.map(quoteIdentifier).join(", "),
		updateSet: updateClauses.join(", "),
	};
}

export function hydrateInstance<ModelClass extends new () => object>(
	Klass: ModelClass,
	mapped: Record<string, unknown>,
): InstanceType<ModelClass> {
	const instance = Object.assign(new Klass(), mapped);
	if (
		typeof (instance as Record<string, unknown>).markPersisted === "function"
	) {
		(
			instance as Record<string, unknown> & { markPersisted: () => void }
		).markPersisted();
	}
	return instance as InstanceType<ModelClass>;
}

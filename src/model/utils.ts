import type { SQL } from "bun";
import type { ColumnDefinition } from "../types";
import { getQueryLogger } from "./connection";

/** Match "col_name" = $N patterns in UPDATE SET and WHERE clauses. */
const ASSIGN_PATTERN = /"(\w+)"\s*=\s*\$(\d+)/g;

/** Match INSERT INTO "table" (col_list) VALUES ... */
const INSERT_PATTERN = /INSERT\s+INTO\s+"?\w+"?\s*\(([^)]+)\)\s*VALUES/i;

export function redactSensitiveValues(
	text: string,
	values: unknown[],
	sensitiveColumns: Set<string>,
): unknown[] {
	if (values.length === 0 || sensitiveColumns.size === 0) return values;

	const redactedIndices = new Set<number>();

	// UPDATE SET and WHERE: "col" = $N
	ASSIGN_PATTERN.lastIndex = 0;
	let assignMatch = ASSIGN_PATTERN.exec(text);
	while (assignMatch !== null) {
		const columnName = assignMatch[1];
		const paramIndex = Number.parseInt(assignMatch[2] as string, 10) - 1;
		if (columnName && sensitiveColumns.has(columnName)) {
			redactedIndices.add(paramIndex);
		}
		assignMatch = ASSIGN_PATTERN.exec(text);
	}

	// INSERT: column positions map to $1, $2, ... (repeating for batch inserts)
	const insertMatch = INSERT_PATTERN.exec(text);
	if (insertMatch?.[1]) {
		const insertColumns = insertMatch[1]
			.split(",")
			.map((column) => column.trim().replace(/"/g, ""));
		const columnCount = insertColumns.length;
		const sensitivePositions: number[] = [];
		for (let index = 0; index < columnCount; index++) {
			if (sensitiveColumns.has(insertColumns[index] as string)) {
				sensitivePositions.push(index);
			}
		}
		if (sensitivePositions.length > 0) {
			const rowCount = Math.ceil(values.length / columnCount);
			for (let row = 0; row < rowCount; row++) {
				for (const position of sensitivePositions) {
					redactedIndices.add(row * columnCount + position);
				}
			}
		}
	}

	if (redactedIndices.size === 0) return values;

	return values.map((value, index) =>
		redactedIndices.has(index) ? "[REDACTED]" : value,
	);
}

/** Executes a SQL query with optional logging. Pass `sensitiveColumns` (DB column names) to redact their values from logs. */
export async function executeQuery(
	connection: SQL,
	text: string,
	values?: unknown[],
	sensitiveColumns?: Set<string>,
	// biome-ignore lint/suspicious/noExplicitAny: Bun.sql result is both array-like and has metadata properties
): Promise<any[]> {
	const logger = getQueryLogger();
	if (logger) {
		const start = performance.now();
		const result = await connection.unsafe(text, values);
		const durationMs = performance.now() - start;
		const logValues =
			values && sensitiveColumns && sensitiveColumns.size > 0
				? redactSensitiveValues(text, values, sensitiveColumns)
				: values;
		logger({ text, values: logValues, durationMs });
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

const sensitiveColumnsCache = new WeakMap<object, Set<string>>();

/** Build a Set of sensitive DB column names from a model class's static sensitiveFields. Cached per model class. */
export function buildSensitiveColumns(
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	modelClass: Function,
	columns: Record<string, ColumnDefinition>,
): Set<string> {
	const cached = sensitiveColumnsCache.get(modelClass);
	if (cached !== undefined) return cached;

	const sensitiveFields = (modelClass as unknown as Record<string, unknown>)
		.sensitiveFields as string[] | undefined;
	const result = new Set<string>();
	if (sensitiveFields) {
		for (const field of sensitiveFields) {
			result.add(resolveColumnName(field, columns));
		}
	}
	sensitiveColumnsCache.set(modelClass, result);
	return result;
}

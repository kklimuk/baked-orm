import { toCamelCase } from "../introspect";
import type { TableDefinition } from "../types";
import { getModelRegistry } from "./base";
import { getModelConnection } from "./connection";
import type { AnyModelStatic, AssociationDefinition } from "./types";
import {
	buildReverseColumnMap,
	executeQuery,
	hydrateInstance,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "./utils";

function findAssociationDefinition(
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	associationName: string,
): AssociationDefinition | null {
	const definition = modelClass[associationName];
	if (
		definition &&
		typeof definition === "object" &&
		"associationType" in definition
	) {
		return definition as AssociationDefinition;
	}
	return null;
}

/** Infer foreign key from table name. Override with `foreignKey` option for non-standard names. */
function inferForeignKey(tableName: string): string {
	const singular = tableName.endsWith("s") ? tableName.slice(0, -1) : tableName;
	return `${singular}Id`;
}

function resolveModel(definition: AssociationDefinition): AnyModelStatic {
	if (!definition.model) {
		throw new Error("Association definition is missing a model reference");
	}
	return definition.model();
}

export async function loadAssociation(
	instance: Record<string, unknown>,
	associationName: string,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition,
): Promise<unknown> {
	const definition = findAssociationDefinition(modelClass, associationName);
	if (!definition) {
		throw new Error(
			`Association "${associationName}" not found on ${modelClass.name}`,
		);
	}

	const connection = getModelConnection();

	switch (definition.associationType) {
		case "belongsTo": {
			if (definition.polymorphic) {
				return loadPolymorphicBelongsTo(instance, associationName, connection);
			}

			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);
			const foreignKey =
				definition.foreignKey ?? inferForeignKey(targetDef.tableName);
			const foreignKeyValue = instance[foreignKey];

			if (foreignKeyValue === null || foreignKeyValue === undefined) {
				return null;
			}

			const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
			const targetPrimaryKeyDb = resolveColumnName(
				targetPrimaryKey,
				targetDef.columns,
			);

			const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(targetPrimaryKeyDb)} = $1 LIMIT 1`;
			const rows = await executeQuery(connection, text, [foreignKeyValue]);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (!row) return null;

			const mapped = mapRowToModel(row, targetReverseMap);
			const result = hydrateInstance(targetModel, mapped);
			return result;
		}

		case "hasOne": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);

			if (definition.as) {
				const typeColumn = resolveColumnName(
					`${definition.as}Type`,
					targetDef.columns,
				);
				const idColumn = resolveColumnName(
					`${definition.as}Id`,
					targetDef.columns,
				);
				const primaryKey = tableDefinition.primaryKey[0] ?? "id";

				const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(typeColumn)} = $1 AND ${quoteIdentifier(idColumn)} = $2 LIMIT 1`;
				const rows = await executeQuery(connection, text, [
					modelClass.name,
					instance[primaryKey],
				]);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (!row) return null;

				const mapped = mapRowToModel(row, targetReverseMap);
				const result = hydrateInstance(targetModel, mapped);
				return result;
			}

			const foreignKey =
				definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
			const whereColumn = resolveColumnName(foreignKey, targetDef.columns);
			const primaryKey = tableDefinition.primaryKey[0] ?? "id";
			const whereValues = [instance[primaryKey]];

			const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(whereColumn)} = $1 LIMIT 1`;
			const rows = await executeQuery(connection, text, whereValues);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (!row) return null;

			const mapped = mapRowToModel(row, targetReverseMap);
			const result = hydrateInstance(targetModel, mapped);
			return result;
		}

		case "hasMany": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);
			const primaryKey = tableDefinition.primaryKey[0] ?? "id";

			let text: string;
			let values: unknown[];

			if (definition.as) {
				const typeColumn = resolveColumnName(
					`${definition.as}Type`,
					targetDef.columns,
				);
				const idColumn = resolveColumnName(
					`${definition.as}Id`,
					targetDef.columns,
				);
				text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(typeColumn)} = $1 AND ${quoteIdentifier(idColumn)} = $2`;
				values = [modelClass.name, instance[primaryKey]];
			} else {
				const foreignKey =
					definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
				const whereColumn = resolveColumnName(foreignKey, targetDef.columns);
				text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(whereColumn)} = $1`;
				values = [instance[primaryKey]];
			}

			const rows = await executeQuery(connection, text, values);
			const results = [];
			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					targetReverseMap,
				);
				const resultInstance = hydrateInstance(targetModel, mapped);
				results.push(resultInstance);
			}
			return results;
		}

		case "hasManyThrough": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);

			const throughName = definition.through ?? "";
			const throughDefinition = findAssociationDefinition(
				modelClass,
				throughName,
			);
			if (!throughDefinition) {
				throw new Error(
					`Through association "${throughName}" not found on ${modelClass.name}`,
				);
			}

			const throughModel = resolveModel(throughDefinition);
			const throughDef = throughModel.tableDefinition as TableDefinition;

			const primaryKey = tableDefinition.primaryKey[0] ?? "id";

			const throughForeignKey =
				throughDefinition.foreignKey ??
				inferForeignKey(tableDefinition.tableName);
			const throughForeignKeyDb = resolveColumnName(
				throughForeignKey,
				throughDef.columns,
			);

			const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
			const targetPrimaryKeyDb = resolveColumnName(
				targetPrimaryKey,
				targetDef.columns,
			);

			const sourceForeignKey =
				definition.source ?? inferForeignKey(targetDef.tableName);
			const sourceForeignKeyDb = resolveColumnName(
				sourceForeignKey,
				throughDef.columns,
			);

			const text = `SELECT ${quoteIdentifier(targetDef.tableName)}.* FROM ${quoteIdentifier(targetDef.tableName)} INNER JOIN ${quoteIdentifier(throughDef.tableName)} ON ${quoteIdentifier(throughDef.tableName)}.${quoteIdentifier(sourceForeignKeyDb)} = ${quoteIdentifier(targetDef.tableName)}.${quoteIdentifier(targetPrimaryKeyDb)} WHERE ${quoteIdentifier(throughDef.tableName)}.${quoteIdentifier(throughForeignKeyDb)} = $1`;
			const rows = await executeQuery(connection, text, [instance[primaryKey]]);

			const results = [];
			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					targetReverseMap,
				);
				const resultInstance = hydrateInstance(targetModel, mapped);
				results.push(resultInstance);
			}
			return results;
		}

		default:
			throw new Error(
				`Unknown association type: ${definition.associationType}`,
			);
	}
}

async function loadPolymorphicBelongsTo(
	instance: Record<string, unknown>,
	associationName: string,
	connection: ReturnType<typeof getModelConnection>,
): Promise<unknown> {
	const typeValue = instance[`${associationName}Type`] as string | undefined;
	const idValue = instance[`${associationName}Id`];

	if (!typeValue || idValue === null || idValue === undefined) {
		return null;
	}

	const registry = getModelRegistry();
	const targetModel = registry.get(typeValue);
	if (!targetModel) {
		throw new Error(
			`Polymorphic type "${typeValue}" not found in model registry. Make sure the model class is defined.`,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic model access
	const targetDef = (targetModel as any).tableDefinition as TableDefinition;
	const targetReverseMap = buildReverseColumnMap(targetDef.columns);
	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
	const targetPrimaryKeyDb = resolveColumnName(
		targetPrimaryKey,
		targetDef.columns,
	);

	const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(targetPrimaryKeyDb)} = $1 LIMIT 1`;
	const rows = await executeQuery(connection, text, [idValue]);
	const row = rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;

	const mapped = mapRowToModel(row, targetReverseMap);
	return hydrateInstance(targetModel, mapped);
}

type AssociationTree = Map<string, AssociationTree>;

function parseIncludesPaths(paths: string[]): AssociationTree {
	const tree: AssociationTree = new Map();
	for (const path of paths) {
		const segments = path.split(".");
		let currentLevel = tree;
		for (const segment of segments) {
			if (!currentLevel.has(segment)) {
				currentLevel.set(segment, new Map());
			}
			currentLevel = currentLevel.get(segment) as AssociationTree;
		}
	}
	return tree;
}

function collectLoadedRecords(
	parentRecords: Record<string, unknown>[],
	associationName: string,
): Record<string, unknown>[] {
	const collected: Record<string, unknown>[] = [];
	for (const parent of parentRecords) {
		const loaded = parent[associationName];
		if (loaded === null || loaded === undefined) continue;
		if (Array.isArray(loaded)) {
			for (const item of loaded) {
				collected.push(item as Record<string, unknown>);
			}
		} else {
			collected.push(loaded as Record<string, unknown>);
		}
	}
	return collected;
}

export async function preloadAssociations<Row>(
	records: Row[],
	associationNames: string[],
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition<Row>,
): Promise<void> {
	const tree = parseIncludesPaths(associationNames);
	await preloadAssociationTree(records, tree, modelClass, tableDefinition);
}

async function preloadAssociationTree<Row>(
	records: Row[],
	tree: AssociationTree,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition<Row>,
): Promise<void> {
	if (records.length === 0 || tree.size === 0) return;

	const connection = getModelConnection();
	const primaryKey = (tableDefinition.primaryKey[0] ?? "id") as keyof Row &
		string;

	await Promise.all(
		Array.from(tree.entries()).map(async ([associationName, childTree]) => {
			const definition = findAssociationDefinition(modelClass, associationName);
			if (!definition) {
				throw new Error(
					`Association "${associationName}" not found on ${modelClass.name}`,
				);
			}

			await preloadSingleAssociation(
				records,
				associationName,
				definition,
				modelClass,
				tableDefinition,
				primaryKey,
				connection,
			);

			if (childTree.size > 0) {
				const targetModel = resolveModel(definition);
				const targetDef = targetModel.tableDefinition as TableDefinition;
				const childRecords = collectLoadedRecords(
					records as unknown as Record<string, unknown>[],
					associationName,
				);

				if (childRecords.length > 0) {
					await preloadAssociationTree(
						childRecords,
						childTree,
						targetModel,
						targetDef,
					);
				}
			}
		}),
	);
}

async function preloadSingleAssociation<Row>(
	records: Row[],
	associationName: string,
	definition: AssociationDefinition,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition<Row>,
	primaryKey: keyof Row & string,
	connection: ReturnType<typeof getModelConnection>,
): Promise<void> {
	switch (definition.associationType) {
		case "belongsTo": {
			if (definition.polymorphic) {
				await preloadPolymorphicBelongsTo(
					records as Record<string, unknown>[],
					associationName,
					connection,
				);
				break;
			}

			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);
			const foreignKey =
				definition.foreignKey ?? inferForeignKey(targetDef.tableName);
			const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
			const targetPrimaryKeyDb = resolveColumnName(
				targetPrimaryKey,
				targetDef.columns,
			);

			const foreignKeyValues = records
				.map((record) => (record as Record<string, unknown>)[foreignKey])
				.filter((value) => value !== null && value !== undefined);

			if (foreignKeyValues.length === 0) {
				for (const record of records) {
					(record as Record<string, unknown>)[associationName] = null;
				}
				break;
			}

			const uniqueValues = [...new Set(foreignKeyValues)];
			const placeholders = uniqueValues.map((_, index) => `$${index + 1}`);
			const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(targetPrimaryKeyDb)} IN (${placeholders.join(", ")})`;
			const rows = await executeQuery(connection, text, uniqueValues);

			const resultMap = new Map<unknown, unknown>();
			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					targetReverseMap,
				);
				const instance = hydrateInstance(targetModel, mapped);
				resultMap.set(mapped[targetPrimaryKey], instance);
			}

			for (const record of records) {
				const fkValue = (record as Record<string, unknown>)[foreignKey];
				(record as Record<string, unknown>)[associationName] =
					resultMap.get(fkValue) ?? null;
			}
			break;
		}

		case "hasOne": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);

			const parentIds = records.map(
				(record) => (record as Record<string, unknown>)[primaryKey],
			);

			if (definition.as) {
				const typeColumn = resolveColumnName(
					`${definition.as}Type`,
					targetDef.columns,
				);
				const idColumn = resolveColumnName(
					`${definition.as}Id`,
					targetDef.columns,
				);
				const placeholders = parentIds.map((_, index) => `$${index + 2}`);
				const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(typeColumn)} = $1 AND ${quoteIdentifier(idColumn)} IN (${placeholders.join(", ")})`;
				const rows = await executeQuery(connection, text, [
					modelClass.name,
					...parentIds,
				]);

				const resultMap = new Map<unknown, unknown>();
				const camelIdKey = toCamelCase(`${definition.as}_id`);
				for (const row of rows) {
					const mapped = mapRowToModel(
						row as Record<string, unknown>,
						targetReverseMap,
					);
					const instance = hydrateInstance(targetModel, mapped);
					resultMap.set(mapped[camelIdKey], instance);
				}

				for (const record of records) {
					const parentId = (record as Record<string, unknown>)[primaryKey];
					(record as Record<string, unknown>)[associationName] =
						resultMap.get(parentId) ?? null;
				}
			} else {
				const foreignKey =
					definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
				const whereColumn = resolveColumnName(foreignKey, targetDef.columns);
				const placeholders = parentIds.map((_, index) => `$${index + 1}`);
				const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(whereColumn)} IN (${placeholders.join(", ")})`;
				const rows = await executeQuery(connection, text, parentIds);

				const resultMap = new Map<unknown, unknown>();
				for (const row of rows) {
					const mapped = mapRowToModel(
						row as Record<string, unknown>,
						targetReverseMap,
					);
					const instance = hydrateInstance(targetModel, mapped);
					resultMap.set(mapped[foreignKey], instance);
				}

				for (const record of records) {
					const parentId = (record as Record<string, unknown>)[primaryKey];
					(record as Record<string, unknown>)[associationName] =
						resultMap.get(parentId) ?? null;
				}
			}
			break;
		}

		case "hasMany": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);

			const parentIds = records.map(
				(record) => (record as Record<string, unknown>)[primaryKey],
			);

			let text: string;
			let values: unknown[];
			let groupByKey: string;

			if (definition.as) {
				const typeColumn = resolveColumnName(
					`${definition.as}Type`,
					targetDef.columns,
				);
				const idColumn = resolveColumnName(
					`${definition.as}Id`,
					targetDef.columns,
				);
				const placeholders = parentIds.map((_, index) => `$${index + 2}`);
				text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(typeColumn)} = $1 AND ${quoteIdentifier(idColumn)} IN (${placeholders.join(", ")})`;
				values = [modelClass.name, ...parentIds];
				groupByKey = `${definition.as}Id`;
			} else {
				const foreignKey =
					definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
				const whereColumn = resolveColumnName(foreignKey, targetDef.columns);
				const placeholders = parentIds.map((_, index) => `$${index + 1}`);
				text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(whereColumn)} IN (${placeholders.join(", ")})`;
				values = parentIds;
				groupByKey = foreignKey;
			}

			const rows = await executeQuery(connection, text, values);
			const resultMap = new Map<unknown, unknown[]>();

			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					targetReverseMap,
				);
				const instance = hydrateInstance(targetModel, mapped);
				const groupValue = mapped[groupByKey];
				const existing = resultMap.get(groupValue) ?? [];
				existing.push(instance);
				resultMap.set(groupValue, existing);
			}

			for (const record of records) {
				const parentId = (record as Record<string, unknown>)[primaryKey];
				(record as Record<string, unknown>)[associationName] =
					resultMap.get(parentId) ?? [];
			}
			break;
		}

		case "hasManyThrough": {
			const targetModel = resolveModel(definition);
			const targetDef = targetModel.tableDefinition as TableDefinition;
			const targetReverseMap = buildReverseColumnMap(targetDef.columns);

			const throughName = definition.through ?? "";
			const throughDefinition = findAssociationDefinition(
				modelClass,
				throughName,
			);
			if (!throughDefinition) {
				throw new Error(
					`Through association "${throughName}" not found on ${modelClass.name}`,
				);
			}

			const throughModel = resolveModel(throughDefinition);
			const throughDef = throughModel.tableDefinition as TableDefinition;

			const throughForeignKey =
				throughDefinition.foreignKey ??
				inferForeignKey(tableDefinition.tableName);
			const throughForeignKeyDb = resolveColumnName(
				throughForeignKey,
				throughDef.columns,
			);

			const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
			const targetPrimaryKeyDb = resolveColumnName(
				targetPrimaryKey,
				targetDef.columns,
			);

			const sourceForeignKey =
				definition.source ?? inferForeignKey(targetDef.tableName);
			const sourceForeignKeyDb = resolveColumnName(
				sourceForeignKey,
				throughDef.columns,
			);

			const parentIds = records.map(
				(record) => (record as Record<string, unknown>)[primaryKey],
			);
			const placeholders = parentIds.map((_, index) => `$${index + 1}`);

			const text = `SELECT ${quoteIdentifier(targetDef.tableName)}.*, ${quoteIdentifier(throughDef.tableName)}.${quoteIdentifier(throughForeignKeyDb)} AS __through_fk FROM ${quoteIdentifier(targetDef.tableName)} INNER JOIN ${quoteIdentifier(throughDef.tableName)} ON ${quoteIdentifier(throughDef.tableName)}.${quoteIdentifier(sourceForeignKeyDb)} = ${quoteIdentifier(targetDef.tableName)}.${quoteIdentifier(targetPrimaryKeyDb)} WHERE ${quoteIdentifier(throughDef.tableName)}.${quoteIdentifier(throughForeignKeyDb)} IN (${placeholders.join(", ")})`;
			const rows = await executeQuery(connection, text, parentIds);

			const resultMap = new Map<unknown, unknown[]>();
			for (const row of rows) {
				const rowData = row as Record<string, unknown>;
				const throughFkValue = rowData.__through_fk;
				const mapped = mapRowToModel(rowData, targetReverseMap);
				delete mapped.__through_fk;
				const instance = hydrateInstance(targetModel, mapped);
				const existing = resultMap.get(throughFkValue) ?? [];
				existing.push(instance);
				resultMap.set(throughFkValue, existing);
			}

			for (const record of records) {
				const parentId = (record as Record<string, unknown>)[primaryKey];
				(record as Record<string, unknown>)[associationName] =
					resultMap.get(parentId) ?? [];
			}
			break;
		}
	}
}

async function preloadPolymorphicBelongsTo(
	records: Record<string, unknown>[],
	associationName: string,
	connection: ReturnType<typeof getModelConnection>,
): Promise<void> {
	const registry = getModelRegistry();
	const grouped = new Map<
		string,
		{ record: Record<string, unknown>; idValue: unknown }[]
	>();

	for (const record of records) {
		const typeValue = record[`${associationName}Type`] as string | undefined;
		const idValue = record[`${associationName}Id`];

		if (!typeValue || idValue === null || idValue === undefined) {
			record[associationName] = null;
			continue;
		}

		const existing = grouped.get(typeValue) ?? [];
		existing.push({ record, idValue });
		grouped.set(typeValue, existing);
	}

	for (const [typeName, entries] of grouped) {
		const targetModel = registry.get(typeName);
		if (!targetModel) {
			throw new Error(
				`Polymorphic type "${typeName}" not found in model registry.`,
			);
		}

		// biome-ignore lint/suspicious/noExplicitAny: dynamic model access
		const targetDef = (targetModel as any).tableDefinition as TableDefinition;
		const targetReverseMap = buildReverseColumnMap(targetDef.columns);
		const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
		const targetPrimaryKeyDb = resolveColumnName(
			targetPrimaryKey,
			targetDef.columns,
		);

		const idValues = entries.map((entry) => entry.idValue);
		const uniqueIds = [...new Set(idValues)];
		const placeholders = uniqueIds.map((_, index) => `$${index + 1}`);
		const text = `SELECT * FROM ${quoteIdentifier(targetDef.tableName)} WHERE ${quoteIdentifier(targetPrimaryKeyDb)} IN (${placeholders.join(", ")})`;
		const rows = await executeQuery(connection, text, uniqueIds);

		const resultMap = new Map<unknown, unknown>();
		for (const row of rows) {
			const mapped = mapRowToModel(
				row as Record<string, unknown>,
				targetReverseMap,
			);
			const instance = hydrateInstance(targetModel, mapped);
			resultMap.set(mapped[targetPrimaryKey], instance);
		}

		for (const entry of entries) {
			entry.record[associationName] = resultMap.get(entry.idValue) ?? null;
		}
	}
}

import type { TableDefinition } from "../../types";
import type { AssociationDefinition, AssociationScope } from "../types";
import { resolveColumnName } from "../utils";
import {
	applyScope,
	buildTargetQuery,
	executeAssociationQuery,
	findAssociationDefinition,
	inferForeignKey,
	resolveModel,
} from "./shared";

export async function loadHasManyThrough(
	instance: Record<string, unknown>,
	definition: AssociationDefinition,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition,
): Promise<unknown> {
	const targetModel = resolveModel(definition);
	const targetDef = targetModel.tableDefinition as TableDefinition;
	const primaryKey = tableDefinition.primaryKey[0] ?? "id";

	const throughName = definition.through ?? "";
	const throughDefinition = findAssociationDefinition(modelClass, throughName);
	if (!throughDefinition) {
		throw new Error(
			`Through association "${throughName}" not found on ${modelClass.name}`,
		);
	}

	const throughModel = resolveModel(throughDefinition);
	const throughForeignKey =
		throughDefinition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
	const sourceForeignKey =
		definition.source ?? inferForeignKey(targetDef.tableName);

	let throughQuery = buildTargetQuery(throughModel).where({
		[throughForeignKey]: instance[primaryKey],
	});
	throughQuery = applyScope(
		throughQuery,
		definition.defaultThroughScope,
		throughModel,
	);
	const throughRows = (await throughQuery.toArray()) as Record<
		string,
		unknown
	>[];

	const targetIds = throughRows
		.map((row) => row[sourceForeignKey])
		.filter((value) => value !== null && value !== undefined);
	if (targetIds.length === 0) return [];

	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
	let targetQuery = buildTargetQuery(targetModel).where({
		[targetPrimaryKey]: [...new Set(targetIds)],
	});
	targetQuery = applyScope(targetQuery, definition.defaultScope, targetModel);
	const targetRows = (await targetQuery.toArray()) as Record<string, unknown>[];

	const targetById = new Map<unknown, Record<string, unknown>>();
	for (const target of targetRows) {
		targetById.set(target[targetPrimaryKey], target);
	}

	const results: unknown[] = [];
	for (const through of throughRows) {
		const target = targetById.get(through[sourceForeignKey]);
		if (target) results.push(target);
	}
	return results;
}

export async function preloadHasManyThrough(
	records: Record<string, unknown>[],
	associationName: string,
	definition: AssociationDefinition,
	scope: AssociationScope | undefined,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition,
	primaryKey: string,
): Promise<void> {
	const targetModel = resolveModel(definition);
	const targetDef = targetModel.tableDefinition as TableDefinition;

	const throughName = definition.through ?? "";
	const throughDefinition = findAssociationDefinition(modelClass, throughName);
	if (!throughDefinition) {
		throw new Error(
			`Through association "${throughName}" not found on ${modelClass.name}`,
		);
	}

	const throughModel = resolveModel(throughDefinition);
	const throughDef = throughModel.tableDefinition as TableDefinition;

	const throughForeignKey =
		throughDefinition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
	const sourceForeignKey =
		definition.source ?? inferForeignKey(targetDef.tableName);
	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";

	const parentIds = records.map((record) => record[primaryKey]);

	let throughQuery = buildTargetQuery(throughModel).where({
		[throughForeignKey]: parentIds,
	});
	const throughPartition = resolveColumnName(
		throughForeignKey,
		throughDef.columns,
	);
	throughQuery = applyScope(
		throughQuery,
		definition.defaultThroughScope,
		throughModel,
	);

	const throughRows = await executeAssociationQuery(
		throughQuery,
		throughPartition,
	);

	const targetIdSet = new Set<unknown>();
	for (const through of throughRows) {
		const value = through[sourceForeignKey];
		if (value !== null && value !== undefined) targetIdSet.add(value);
	}

	let targetById = new Map<unknown, Record<string, unknown>>();
	if (targetIdSet.size > 0) {
		let targetQuery = buildTargetQuery(targetModel).where({
			[targetPrimaryKey]: [...targetIdSet],
		});
		targetQuery = applyScope(targetQuery, scope, targetModel);
		const targetRows = (await targetQuery.toArray()) as Record<
			string,
			unknown
		>[];
		targetById = new Map(targetRows.map((row) => [row[targetPrimaryKey], row]));
	}

	const resultMap = new Map<unknown, unknown[]>();
	for (const through of throughRows) {
		const parentId = through[throughForeignKey];
		const target = targetById.get(through[sourceForeignKey]);
		if (!target) continue;
		const existing = resultMap.get(parentId) ?? [];
		existing.push(target);
		resultMap.set(parentId, existing);
	}

	for (const record of records) {
		const parentId = record[primaryKey];
		record[associationName] = resultMap.get(parentId) ?? [];
	}
}

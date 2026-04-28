import type { TableDefinition } from "../../types";
import { getModelRegistry } from "../base";
import type { AssociationDefinition, AssociationScope } from "../types";
import {
	applyScope,
	buildTargetQuery,
	inferForeignKey,
	resolveModel,
} from "./shared";

export async function loadBelongsTo(
	instance: Record<string, unknown>,
	definition: AssociationDefinition,
): Promise<unknown> {
	const targetModel = resolveModel(definition);
	const targetDef = targetModel.tableDefinition as TableDefinition;
	const foreignKey =
		definition.foreignKey ?? inferForeignKey(targetDef.tableName);
	const foreignKeyValue = instance[foreignKey];

	if (foreignKeyValue === null || foreignKeyValue === undefined) {
		return null;
	}

	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";
	let query = buildTargetQuery(targetModel).where({
		[targetPrimaryKey]: foreignKeyValue,
	});
	query = applyScope(query, definition.defaultScope, targetModel);
	return query.first();
}

export async function loadPolymorphicBelongsTo(
	instance: Record<string, unknown>,
	associationName: string,
	definition: AssociationDefinition,
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

	const targetDef = targetModel.tableDefinition as TableDefinition;
	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";

	let query = buildTargetQuery(targetModel).where({
		[targetPrimaryKey]: idValue,
	});
	query = applyScope(query, definition.defaultScope, targetModel);
	return query.first();
}

export async function preloadBelongsTo(
	records: Record<string, unknown>[],
	associationName: string,
	definition: AssociationDefinition,
	scope: AssociationScope | undefined,
): Promise<void> {
	const targetModel = resolveModel(definition);
	const targetDef = targetModel.tableDefinition as TableDefinition;
	const foreignKey =
		definition.foreignKey ?? inferForeignKey(targetDef.tableName);
	const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";

	const foreignKeyValues = records
		.map((record) => record[foreignKey])
		.filter((value) => value !== null && value !== undefined);

	if (foreignKeyValues.length === 0) {
		for (const record of records) {
			record[associationName] = null;
		}
		return;
	}

	const uniqueValues = [...new Set(foreignKeyValues)];
	let query = buildTargetQuery(targetModel).where({
		[targetPrimaryKey]: uniqueValues,
	});
	query = applyScope(query, scope, targetModel);
	const rows = (await query.toArray()) as Record<string, unknown>[];

	const resultMap = new Map<unknown, unknown>();
	for (const row of rows) {
		resultMap.set(row[targetPrimaryKey], row);
	}

	for (const record of records) {
		const fkValue = record[foreignKey];
		record[associationName] = resultMap.get(fkValue) ?? null;
	}
}

export async function preloadPolymorphicBelongsTo(
	records: Record<string, unknown>[],
	associationName: string,
	scope: AssociationScope | undefined,
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

		const targetDef = targetModel.tableDefinition as TableDefinition;
		const targetPrimaryKey = targetDef.primaryKey[0] ?? "id";

		const idValues = entries.map((entry) => entry.idValue);
		const uniqueIds = [...new Set(idValues)];

		let query = buildTargetQuery(targetModel).where({
			[targetPrimaryKey]: uniqueIds,
		});
		query = applyScope(query, scope, targetModel);
		const rows = (await query.toArray()) as Record<string, unknown>[];

		const resultMap = new Map<unknown, unknown>();
		for (const row of rows) {
			resultMap.set(row[targetPrimaryKey], row);
		}

		for (const entry of entries) {
			entry.record[associationName] = resultMap.get(entry.idValue) ?? null;
		}
	}
}

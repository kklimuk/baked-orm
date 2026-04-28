import { toCamelCase } from "../../introspect";
import type { TableDefinition } from "../../types";
import type { AssociationDefinition, AssociationScope } from "../types";
import { resolveColumnName } from "../utils";
import {
	applyScope,
	buildTargetQuery,
	executeAssociationQuery,
	inferForeignKey,
	resolveModel,
} from "./shared";

export async function loadHasMany(
	instance: Record<string, unknown>,
	definition: AssociationDefinition,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition,
): Promise<unknown> {
	const targetModel = resolveModel(definition);
	const primaryKey = tableDefinition.primaryKey[0] ?? "id";

	let query = buildTargetQuery(targetModel);
	if (definition.as) {
		query = query.where({
			[`${definition.as}Type`]: modelClass.name,
			[`${definition.as}Id`]: instance[primaryKey],
		});
	} else {
		const foreignKey =
			definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
		query = query.where({ [foreignKey]: instance[primaryKey] });
	}
	query = applyScope(query, definition.defaultScope, targetModel);
	return query.toArray();
}

export async function preloadHasMany(
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

	const parentIds = records.map((record) => record[primaryKey]);

	let groupKey: string;
	let query = buildTargetQuery(targetModel);
	if (definition.as) {
		query = query.where({
			[`${definition.as}Type`]: modelClass.name,
			[`${definition.as}Id`]: parentIds,
		});
		groupKey = toCamelCase(`${definition.as}_id`);
	} else {
		const foreignKey =
			definition.foreignKey ?? inferForeignKey(tableDefinition.tableName);
		query = query.where({ [foreignKey]: parentIds });
		groupKey = foreignKey;
	}

	const partitionColumn = resolveColumnName(groupKey, targetDef.columns);
	query = applyScope(query, scope, targetModel);

	const rows = await executeAssociationQuery(query, partitionColumn);

	const resultMap = new Map<unknown, unknown[]>();
	for (const row of rows) {
		const groupValue = row[groupKey];
		const existing = resultMap.get(groupValue) ?? [];
		existing.push(row);
		resultMap.set(groupValue, existing);
	}

	for (const record of records) {
		const parentId = record[primaryKey];
		record[associationName] = resultMap.get(parentId) ?? [];
	}
}

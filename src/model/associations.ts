import type { TableDefinition } from "../types";
import {
	loadBelongsTo,
	loadPolymorphicBelongsTo,
	preloadBelongsTo,
	preloadPolymorphicBelongsTo,
} from "./associations/belongs-to";
import { loadHasMany, preloadHasMany } from "./associations/has-many";
import {
	loadHasManyThrough,
	preloadHasManyThrough,
} from "./associations/has-many-through";
import { loadHasOne, preloadHasOne } from "./associations/has-one";
import {
	findAssociationDefinition,
	resolveModel,
	resolveScope,
} from "./associations/shared";
import type { AssociationDefinition, AssociationScope } from "./types";

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

	switch (definition.associationType) {
		case "belongsTo":
			return definition.polymorphic
				? loadPolymorphicBelongsTo(instance, associationName, definition)
				: loadBelongsTo(instance, definition);
		case "hasOne":
			return loadHasOne(instance, definition, modelClass, tableDefinition);
		case "hasMany":
			return loadHasMany(instance, definition, modelClass, tableDefinition);
		case "hasManyThrough":
			return loadHasManyThrough(
				instance,
				definition,
				modelClass,
				tableDefinition,
			);
		default:
			throw new Error(
				`Unknown association type: ${definition.associationType}`,
			);
	}
}

export async function preloadAssociations<Row>(
	records: Row[],
	associationNames: string[],
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition<Row>,
	overrides?: Map<string, false | AssociationScope>,
): Promise<void> {
	const tree = parseIncludesPaths(associationNames);
	await preloadAssociationTree(
		records,
		tree,
		modelClass,
		tableDefinition,
		0,
		overrides,
	);
}

async function preloadAssociationTree<Row>(
	records: Row[],
	tree: AssociationTree,
	// biome-ignore lint/suspicious/noExplicitAny: model classes have dynamic static properties
	modelClass: any,
	tableDefinition: TableDefinition<Row>,
	depth: number,
	overrides?: Map<string, false | AssociationScope>,
): Promise<void> {
	if (records.length === 0 || tree.size === 0) return;
	if (depth >= MAX_EAGER_DEPTH) {
		throw new Error(
			`Eager loading exceeded maximum depth of ${MAX_EAGER_DEPTH}. Check for circular includes.`,
		);
	}

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

			// Overrides apply only at the top level of a `.includes()` call —
			// nested levels keep their declared `defaultScope`. To override a
			// nested level, declare a separate association without the scope.
			const override =
				depth === 0 ? overrides?.get(associationName) : undefined;

			await preloadSingleAssociation(
				records,
				associationName,
				definition,
				modelClass,
				tableDefinition,
				primaryKey,
				override,
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
						depth + 1,
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
	override?: false | AssociationScope,
): Promise<void> {
	const scope = resolveScope(definition.defaultScope, override);
	const recordsRecord = records as unknown as Record<string, unknown>[];
	switch (definition.associationType) {
		case "belongsTo":
			if (definition.polymorphic) {
				await preloadPolymorphicBelongsTo(
					recordsRecord,
					associationName,
					scope,
				);
			} else {
				await preloadBelongsTo(
					recordsRecord,
					associationName,
					definition,
					scope,
				);
			}
			return;
		case "hasOne":
			await preloadHasOne(
				recordsRecord,
				associationName,
				definition,
				scope,
				modelClass,
				tableDefinition,
				primaryKey as string,
			);
			return;
		case "hasMany":
			await preloadHasMany(
				recordsRecord,
				associationName,
				definition,
				scope,
				modelClass,
				tableDefinition,
				primaryKey as string,
			);
			return;
		case "hasManyThrough":
			await preloadHasManyThrough(
				recordsRecord,
				associationName,
				definition,
				scope,
				modelClass,
				tableDefinition,
				primaryKey as string,
			);
			return;
	}
}

type AssociationTree = Map<string, AssociationTree>;

const MAX_EAGER_DEPTH = 10;

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

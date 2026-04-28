import type { TableDefinition } from "../../types";
import { getModelRegistry } from "../base";
import { QueryBuilder } from "../query";
import type {
	AnyModelStatic,
	AssociationDefinition,
	AssociationScope,
} from "../types";

// biome-ignore lint/suspicious/noExplicitAny: associations operate on dynamic model rows
type AnyQueryBuilder = QueryBuilder<any>;

export function buildTargetQuery(targetModel: AnyModelStatic): AnyQueryBuilder {
	return new QueryBuilder(
		targetModel.tableDefinition as TableDefinition<Record<string, unknown>>,
		{
			modelClass: targetModel as unknown as new (
				attributes?: Partial<Record<string, unknown>>,
			) => Record<string, unknown>,
		},
	);
}

export function applyScope(
	query: AnyQueryBuilder,
	scope: AssociationScope | undefined,
	target: AnyModelStatic,
): AnyQueryBuilder {
	if (!scope) return query;
	return scope(query, target);
}

/**
 * Resolve the effective scope for an association, given a declared default
 * scope and an optional per-call override (from `.includes(path, { scope })`).
 * `false` bypasses the declared scope; a function replaces it; `undefined`
 * keeps the declared scope.
 */
export function resolveScope(
	declared: AssociationScope | undefined,
	override: false | AssociationScope | undefined,
): AssociationScope | undefined {
	if (override === false) return undefined;
	if (typeof override === "function") return override;
	return declared;
}

/**
 * Ensure the query has at least one ORDER BY so the eager `hasOne` "first row
 * per parent" pick (and any other first-wins iteration) is deterministic. If
 * the scope already declares an order, leave it alone; otherwise fall back to
 * primary key ASC.
 */
export function ensureDeterministicOrder(
	query: AnyQueryBuilder,
	target: AnyModelStatic,
): AnyQueryBuilder {
	if (query._orderClauses.length > 0) return query;
	const targetDef = target.tableDefinition as TableDefinition;
	const primaryKey = targetDef.primaryKey[0];
	if (!primaryKey) return query;
	return query.order({ [primaryKey]: "ASC" });
}

/**
 * Execute an association query, using the windowed SQL path when a
 * `defaultScope` set `_limitValue` / `_offsetValue` (so per-parent limits work
 * across batched queries). Both paths route through `_executeAndHydrate` so
 * any future post-fetch behavior applies uniformly.
 */
export async function executeAssociationQuery(
	query: AnyQueryBuilder,
	partitionColumn: string,
): Promise<Record<string, unknown>[]> {
	if (query._limitValue === null && query._offsetValue === null) {
		return (await query.toArray()) as Record<string, unknown>[];
	}
	const { text, values } = query._buildWindowedSql(partitionColumn);
	return (await query._executeAndHydrate(text, values)) as Record<
		string,
		unknown
	>[];
}

export function findAssociationDefinition(
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

export function resolveModel(
	definition: AssociationDefinition,
): AnyModelStatic {
	if (definition.model) {
		return definition.model();
	}
	if (definition.modelName) {
		const registry = getModelRegistry();
		const model = registry.get(definition.modelName);
		if (!model) {
			throw new Error(
				`Model "${definition.modelName}" not found in registry. Make sure the model class is defined and imported.`,
			);
		}
		return model;
	}
	throw new Error("Association definition is missing a model reference");
}

/** Infer foreign key from table name. Override with `foreignKey` option for non-standard names. */
export function inferForeignKey(tableName: string): string {
	const singular = tableName.endsWith("s") ? tableName.slice(0, -1) : tableName;
	return `${singular}Id`;
}

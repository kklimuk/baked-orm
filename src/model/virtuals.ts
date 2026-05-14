import { getPluginVirtuals } from "../plugins";
import type { ColumnDefinition, TableDefinition } from "../types";

const computedCache = new WeakMap<object, Set<string>>();

/**
 * Names of getters defined directly on the user's subclass prototype that
 * aren't columns, associations, or underscore-prefixed. Cached per class.
 *
 * Stops at the user's subclass prototype — does NOT walk to ancestor prototypes,
 * so plugin-added getters (on the Model factory's inner class prototype) are
 * naturally excluded. This also means virtual getters declared on a parent
 * user class are not detected for derived user classes (a v1 limitation).
 */
export function getComputedVirtuals(
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	modelClass: Function,
): Set<string> {
	const cached = computedCache.get(modelClass);
	if (cached !== undefined) return cached;

	const prototype = (modelClass as unknown as { prototype: object | null })
		.prototype;
	const result = new Set<string>();
	if (!prototype) {
		computedCache.set(modelClass, result);
		return result;
	}

	const columns = getColumns(modelClass);
	for (const name of Object.getOwnPropertyNames(prototype)) {
		if (!isVirtualName(name)) continue;
		if (name in columns) continue;
		if (isAssociationName(modelClass, name)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor && typeof descriptor.get === "function") {
			result.add(name);
		}
	}

	// Union in plugin-contributed virtuals. User-declared getters above take
	// precedence on name conflict (Set already contains them); plugin names are
	// added only if not already present.
	for (const name of getPluginVirtuals(modelClass)) {
		if (result.has(name)) continue;
		if (name in columns) continue;
		if (isAssociationName(modelClass, name)) continue;
		result.add(name);
	}

	computedCache.set(modelClass, result);
	return result;
}

/** Per-serialize check for own-property eligibility as a settable virtual. */
export function isSettableVirtual(
	name: string,
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	modelClass: Function,
): boolean {
	if (!isVirtualName(name)) return false;
	if (name in getColumns(modelClass)) return false;
	if (isAssociationName(modelClass, name)) return false;
	return true;
}

function isVirtualName(name: string): boolean {
	return name !== "constructor" && !name.startsWith("_");
}

function isAssociationName(
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	modelClass: Function,
	name: string,
): boolean {
	const value = (modelClass as unknown as Record<string, unknown>)[name];
	return (
		typeof value === "object" &&
		value !== null &&
		"associationType" in (value as Record<string, unknown>)
	);
}

function getColumns(
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	modelClass: Function,
): Record<string, ColumnDefinition> {
	const tableDefinition = (modelClass as unknown as Record<string, unknown>)
		.tableDefinition as TableDefinition | undefined;
	return tableDefinition?.columns ?? {};
}

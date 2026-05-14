import { Temporal } from "@js-temporal/polyfill";

import { getFrontendRegistry } from "./registry";

function isDateColumn(pgType: string): boolean {
	return pgType.includes("timestamp") || pgType === "date";
}

function isDateOnlyColumn(pgType: string): boolean {
	return pgType === "date";
}

/**
 * Hydrate a JSON object into a typed frontend model instance.
 * Uses `__typename` to resolve the model class from the registry,
 * converts date strings to `Temporal.Instant` / `Temporal.PlainDate`,
 * and recursively hydrates nested associations.
 */
export function hydrate<T = unknown>(json: Record<string, unknown>): T {
	const registry = getFrontendRegistry();
	const typeName = json.__typename as string | undefined;
	if (!typeName) {
		throw new Error("Cannot hydrate: missing __typename");
	}

	const ModelClass = registry.get(typeName);
	if (!ModelClass) {
		throw new Error(
			`Unknown model type: "${typeName}". Register it via registerModels({ ${typeName} }) before calling hydrate().`,
		);
	}

	const tableDefinition = (ModelClass as unknown as Record<string, unknown>)
		.tableDefinition as { columns: Record<string, { type: string }> };
	const columns = tableDefinition.columns;
	const instance = new ModelClass() as Record<string, unknown>;

	// Hydrate column values with type conversion
	for (const [key, definition] of Object.entries(columns)) {
		const value = json[key];
		if (value == null) {
			instance[key] = value;
		} else if (isDateOnlyColumn(definition.type)) {
			instance[key] = Temporal.PlainDate.from(value as string);
		} else if (isDateColumn(definition.type)) {
			instance[key] = Temporal.Instant.from(value as string);
		} else {
			instance[key] = value;
		}
	}

	// Hydrate everything else: nested associations (discovered from JSON via
	// __typename) and virtual attributes (plain values not in the column schema).
	for (const [key, value] of Object.entries(json)) {
		if (key === "__typename" || key in columns) continue;

		if (Array.isArray(value)) {
			instance[key] = value.map((item) =>
				typeof item === "object" && item !== null && "__typename" in item
					? hydrate(item as Record<string, unknown>)
					: item,
			);
		} else if (
			typeof value === "object" &&
			value !== null &&
			"__typename" in value
		) {
			instance[key] = hydrate(value as Record<string, unknown>);
		} else {
			instance[key] = value;
		}
	}

	(instance as { markPersisted(): void }).markPersisted();
	return instance as T;
}

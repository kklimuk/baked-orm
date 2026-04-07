import type { TableDefinition } from "../types";

export type SerializeOptions = {
	/** Whitelist: only include these columns. */
	only?: string[];
	/** Blacklist: exclude these columns. */
	except?: string[];
	/** Include associations — string[] shorthand or nested options per association. */
	include?: string[] | Record<string, SerializeOptions | undefined>;
};

/**
 * Convert string[] shorthand to nested options map.
 * `["posts", "posts.comments"]` becomes `{ posts: { include: ["comments"] } }`.
 */
function normalizeInclude(
	include: string[] | Record<string, SerializeOptions | undefined>,
): Record<string, SerializeOptions | undefined> {
	if (!Array.isArray(include)) return include;

	const result: Record<string, SerializeOptions | undefined> = {};
	for (const path of include) {
		const dotIndex = path.indexOf(".");
		if (dotIndex === -1) {
			result[path] ??= undefined;
		} else {
			const head = path.slice(0, dotIndex);
			const tail = path.slice(dotIndex + 1);
			const existing = result[head] ?? {};
			const nestedInclude = (existing.include as string[] | undefined) ?? [];
			nestedInclude.push(tail);
			existing.include = nestedInclude;
			result[head] = existing;
		}
	}
	return result;
}

function getTableDefinition(
	instance: Record<string, unknown>,
): TableDefinition {
	return (
		instance.constructor as unknown as { tableDefinition: TableDefinition }
	).tableDefinition;
}

function serializeAssociated(
	value: Record<string, unknown>,
	nestedOpts: SerializeOptions | undefined,
): Record<string, unknown> {
	return serialize(value, getTableDefinition(value), nestedOpts);
}

/** Serialize a model instance to a JSON-ready object with `__typename` and optional association nesting. */
export function serialize(
	instance: Record<string, unknown>,
	tableDefinition: TableDefinition,
	options?: SerializeOptions,
): Record<string, unknown> {
	const result: Record<string, unknown> = {
		__typename: instance.constructor.name,
	};

	// Determine which columns to include
	const modelClass = instance.constructor as unknown as Record<string, unknown>;
	const sensitiveFields =
		(modelClass.sensitiveFields as string[] | undefined) ?? [];
	let columnKeys = Object.keys(tableDefinition.columns);

	// Always exclude sensitive fields
	if (sensitiveFields.length > 0) {
		columnKeys = columnKeys.filter((key) => !sensitiveFields.includes(key));
	}

	// Apply only/except filters
	if (options?.only) {
		const only = options.only;
		columnKeys = columnKeys.filter((key) => only.includes(key));
	} else if (options?.except) {
		const except = options.except;
		columnKeys = columnKeys.filter((key) => !except.includes(key));
	}

	for (const camelKey of columnKeys) {
		result[camelKey] = instance[camelKey];
	}

	// Serialize included associations
	if (options?.include) {
		const includeMap = normalizeInclude(options.include);
		for (const [assocName, nestedOpts] of Object.entries(includeMap)) {
			const value = instance[assocName];
			if (value === undefined) continue;

			if (Array.isArray(value)) {
				result[assocName] = value.map((item) =>
					serializeAssociated(item as Record<string, unknown>, nestedOpts),
				);
			} else if (value !== null) {
				result[assocName] = serializeAssociated(
					value as Record<string, unknown>,
					nestedOpts,
				);
			} else {
				result[assocName] = null;
			}
		}
	}

	return result;
}

import type { TableDefinition } from "../types";
import { getComputedVirtuals, isSettableVirtual } from "./virtuals";

export type SerializeOptions = {
	/** Whitelist: only include these columns and virtuals. */
	only?: string[];
	/** Blacklist: exclude these columns and virtuals. */
	except?: string[];
	/** Include associations — string[] shorthand or nested options per association. */
	include?: string[] | Record<string, SerializeOptions | undefined>;
	/** Call these instance methods and include their return values keyed by method name. */
	methods?: readonly string[];
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
	// biome-ignore lint/complexity/noBannedTypes: model constructor reference
	const ctor = instance.constructor as unknown as Function &
		Record<string, unknown>;
	const typename = (ctor.typename as string | undefined) ?? ctor.name;
	const result: Record<string, unknown> = { __typename: typename };

	const columns = tableDefinition.columns;
	const sensitive = new Set(
		(ctor.sensitiveFields as string[] | undefined) ?? [],
	);

	function isAllowed(key: string): boolean {
		if (sensitive.has(key)) return false;
		if (options?.only) return options.only.includes(key);
		if (options?.except) return !options.except.includes(key);
		return true;
	}

	// Columns
	for (const camelKey of Object.keys(columns)) {
		if (!isAllowed(camelKey)) continue;
		result[camelKey] = instance[camelKey];
	}

	// Computed virtuals (getters on the user's subclass prototype)
	for (const name of getComputedVirtuals(ctor)) {
		if (!isAllowed(name)) continue;
		result[name] = instance[name];
	}

	// Settable virtuals: own-properties on the instance that aren't columns or
	// associations. Catches class-field defaults, ad-hoc assignments, and SQL
	// aliases populated during hydration.
	for (const name of Object.keys(instance)) {
		if (!isAllowed(name)) continue;
		if (name in result) continue;
		if (!isSettableVirtual(name, ctor)) continue;
		const value = instance[name];
		if (value === undefined) continue;
		result[name] = value;
	}

	// Methods (Rails as_json(methods:) equivalent)
	if (options?.methods) {
		for (const name of options.methods) {
			const fn = instance[name];
			if (typeof fn === "function") {
				result[name] = (fn as () => unknown).call(instance);
			}
		}
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

import { QueryBuilder } from "../model/query";

/** @internal */
// biome-ignore lint/suspicious/noExplicitAny: plugin methods are generic across all model types
type AnyFunction = (...args: any[]) => any;

/**
 * Definition for a baked-orm plugin. Plugins add methods to model instances,
 * model classes (statics), and/or the QueryBuilder prototype.
 *
 * Built-in plugins (soft-delete, locking, recursive-cte, batch-iteration) use
 * this exact same API — see `src/plugins/` for canonical examples.
 */
export interface ModelPlugin {
	name: string;
	/** Instance methods/getters added to every model class prototype. */
	instance?: Record<string, AnyFunction | PropertyDescriptor>;
	/** Static methods added to every model class. */
	static?: Record<string, AnyFunction | PropertyDescriptor>;
	/** Methods added to QueryBuilder.prototype (applied once at registration time). */
	queryBuilder?: Record<string, AnyFunction | PropertyDescriptor>;
}

const registeredPlugins: ModelPlugin[] = [];

function applyProperties(
	target: object,
	properties: Record<string, AnyFunction | PropertyDescriptor>,
): void {
	for (const [name, value] of Object.entries(properties)) {
		if (typeof value === "function") {
			Object.defineProperty(target, name, {
				value,
				writable: true,
				configurable: true,
				enumerable: false,
			});
		} else if (isPropertyDescriptor(value)) {
			Object.defineProperty(target, name, value);
		} else {
			throw new Error(
				`Plugin property "${name}" is neither a function nor a PropertyDescriptor`,
			);
		}
	}
}

function isPropertyDescriptor(value: unknown): value is PropertyDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = value as Record<string, unknown>;
	return "get" in descriptor || "set" in descriptor || "value" in descriptor;
}

/**
 * Register a plugin. QueryBuilder methods are patched immediately.
 * Model instance/static methods are stored and applied per-model by
 * `applyModelPlugins()`, which is called inside the `Model()` factory.
 *
 * Call `definePlugin()` at module top-level so plugins are registered
 * before any models are created.
 */
export function definePlugin(plugin: ModelPlugin): void {
	registeredPlugins.push(plugin);

	if (plugin.queryBuilder) {
		applyProperties(QueryBuilder.prototype, plugin.queryBuilder);
	}
}

/**
 * Apply all registered plugin instance/static methods to a model class.
 * Called internally by the `Model()` factory for each new model class.
 * @internal
 */
export function applyModelPlugins(modelClass: {
	// biome-ignore lint/suspicious/noExplicitAny: model classes are generic
	prototype: any;
}): void {
	for (const plugin of registeredPlugins) {
		if (plugin.instance) {
			applyProperties(modelClass.prototype, plugin.instance);
		}
		if (plugin.static) {
			applyProperties(modelClass, plugin.static);
		}
	}
}

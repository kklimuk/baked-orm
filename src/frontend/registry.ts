import { defineTypename } from "./typename";

type FrontendModelConstructor = new (
	// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous model constructors
	...args: any[]
	// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous model constructors
) => any;

type AnyFrontendModelStatic = FrontendModelConstructor & {
	typename?: string;
};

const FRONTEND_REGISTRY = new Map<string, AnyFrontendModelStatic>();

export function getFrontendRegistry(): Map<string, AnyFrontendModelStatic> {
	return FRONTEND_REGISTRY;
}

/**
 * Register frontend model classes so `hydrate()` can resolve them by `__typename`.
 *
 * The object key becomes the canonical `typename` for that class — this value is
 * preserved through JS minification (object keys are not mangled without explicit
 * opt-in), so registries and `__typename` payloads stay stable in production bundles.
 *
 * ```ts
 * registerModels({ User, Post, Comment });
 * ```
 */
export function registerModels(
	models: Record<string, AnyFrontendModelStatic>,
): void {
	for (const [typename, ModelClass] of Object.entries(models)) {
		defineTypename(ModelClass, typename);
		FRONTEND_REGISTRY.set(typename, ModelClass);
	}
}

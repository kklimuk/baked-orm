// biome-ignore lint/suspicious/noExplicitAny: registry stores heterogeneous model constructors
type AnyFrontendModelStatic = new (...args: any[]) => any;

const FRONTEND_REGISTRY = new Map<string, AnyFrontendModelStatic>();

export type { AnyFrontendModelStatic };

export function getFrontendRegistry(): Map<string, AnyFrontendModelStatic> {
	return FRONTEND_REGISTRY;
}

/** Register frontend model classes so `hydrate()` can resolve them by `__typename`. */
export function registerModels(...models: AnyFrontendModelStatic[]): void {
	for (const ModelClass of models) {
		FRONTEND_REGISTRY.set(ModelClass.name, ModelClass);
	}
}

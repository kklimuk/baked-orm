/**
 * Resolve the wire identifier for a frontend model class.
 *
 * Reads the `typename` static property set by `registerModels`. Falls back to
 * `class.name` when the class hasn't been registered yet — useful during tests
 * or in dev. Throws when neither is available (anonymous class, never registered),
 * so the bug surfaces at the serialize site instead of on the hydrate end.
 */
// biome-ignore lint/suspicious/noExplicitAny: reads a dynamic static property
export function resolveTypename(modelClass: any): string {
	const typename = modelClass?.typename ?? modelClass?.name;
	if (!typename) {
		throw new Error(
			"Cannot resolve typename: class has no `typename` and no `name`. Pass it to `registerModels({ MyClass })` first.",
		);
	}
	return typename;
}

/**
 * Assign a non-enumerable `typename` static property to a model class.
 *
 * Idempotent for same-key registration (HMR, re-imports). Throws if the class
 * is already registered under a different name — two modules silently rebinding
 * the same class is almost always a bug, and the loud failure catches it.
 */
export function defineTypename(
	// biome-ignore lint/suspicious/noExplicitAny: writes to arbitrary class statics
	modelClass: any,
	typename: string,
): void {
	const existing = modelClass.typename as string | undefined;
	if (existing === typename) return;
	if (existing !== undefined) {
		throw new Error(
			`Cannot register class under typename "${typename}": already registered as "${existing}". Each model class must have a stable typename.`,
		);
	}
	Object.defineProperty(modelClass, "typename", {
		value: typename,
		configurable: true,
		enumerable: false,
	});
}

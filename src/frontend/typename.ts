/**
 * Assign a non-enumerable `typename` static property to a model class.
 *
 * Idempotent for same-key registration (HMR, re-imports). Throws if the class
 * is already registered under a different name — two modules silently rebinding
 * the same class is almost always a bug, and the loud failure catches it.
 *
 * `serialize()` reads this property when computing `__typename` for the wire,
 * falling back to `constructor.name` if not set.
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

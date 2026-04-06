export type CallbackHook =
	| "beforeValidation"
	| "afterValidation"
	| "beforeSave"
	| "afterSave"
	| "beforeCreate"
	| "afterCreate"
	| "beforeUpdate"
	| "afterUpdate"
	| "beforeDestroy"
	| "afterDestroy";

export type CallbackFunction = (
	record: Record<string, unknown>,
) => void | Promise<void>;

/** Run all callbacks for a given hook. Discovers callbacks from static properties on the model class. */
export async function runCallbacks(
	hookName: CallbackHook,
	instance: Record<string, unknown>,
	modelClass: Record<string, unknown>,
): Promise<void> {
	const callbacks = modelClass[hookName] as CallbackFunction[] | undefined;
	if (!callbacks) return;

	for (const callback of callbacks) {
		await callback(instance);
	}
}

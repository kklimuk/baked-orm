import type { ColumnDefinition } from "../types";
import { ValidationErrors } from "./errors";

// --- Types ---

export type ValidationContext = "create" | "update";

type BaseValidationOptions = {
	message?: string;
	on?: ValidationContext;
	if?: (record: Record<string, unknown>) => boolean;
};

type PresenceOptions = BaseValidationOptions;

type LengthOptions = BaseValidationOptions & {
	minimum?: number;
	maximum?: number;
	is?: number;
};

type NumericalityOptions = BaseValidationOptions & {
	greaterThan?: number;
	greaterThanOrEqualTo?: number;
	lessThan?: number;
	lessThanOrEqualTo?: number;
	equalTo?: number;
	integer?: boolean;
	notANumberMessage?: string;
	notAnIntegerMessage?: string;
};

type FormatOptions = BaseValidationOptions & {
	pattern: RegExp;
};

type InclusionOptions = BaseValidationOptions & {
	in: readonly unknown[];
};

type ExclusionOptions = BaseValidationOptions & {
	in: readonly unknown[];
};

type EmailOptions = BaseValidationOptions;

type CustomFieldOptions = BaseValidationOptions & {
	validate: (
		value: unknown,
		record: Record<string, unknown>,
	) => string | undefined;
};

/** A validation rule produced by validates(). */
export type ValidationRule = {
	readonly validatorName: string;
	readonly options: Record<string, unknown>;
};

/** Use with `satisfies` to type-check validation field names against a Row type.
 * @example static validations = { name: validates("presence") } satisfies ValidationConfig<UsersRow>
 */
export type ValidationConfig<Row> = {
	[K in keyof Row]?: ValidationRule | ValidationRule[];
};

/** A record-level custom validation produced by validate(). */
export type CustomValidation = {
	readonly __brand: "customValidation";
	readonly fn: (
		record: Record<string, unknown>,
	) => Record<string, string | string[]> | undefined;
	readonly options: BaseValidationOptions;
};

// --- Validator registry ---

type ValidatorFn = (
	value: unknown,
	record: Record<string, unknown>,
	options: Record<string, unknown>,
) => string | undefined;

const VALIDATOR_REGISTRY = new Map<string, ValidatorFn>();

/** Register a custom validator that can be used with validates("name"). */
export function defineValidator(name: string, validator: ValidatorFn): void {
	VALIDATOR_REGISTRY.set(name, validator);
}

// --- Built-in validators ---

const EMAIL_PATTERN =
	/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function presenceValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined || value === "") {
		return (options.message as string) ?? "can't be blank";
	}
	return undefined;
}

function lengthValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const length = typeof value === "string" ? value.length : 0;
	const minimum = options.minimum as number | undefined;
	const maximum = options.maximum as number | undefined;
	const exact = options.is as number | undefined;

	if (exact !== undefined && length !== exact) {
		return (
			(options.message as string) ??
			`is the wrong length (should be ${exact} characters)`
		);
	}
	if (minimum !== undefined && length < minimum) {
		return (
			(options.message as string) ??
			`is too short (minimum is ${minimum} characters)`
		);
	}
	if (maximum !== undefined && length > maximum) {
		return (
			(options.message as string) ??
			`is too long (maximum is ${maximum} characters)`
		);
	}
	return undefined;
}

function numericalityValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const num = typeof value === "number" ? value : Number(value);
	if (Number.isNaN(num)) {
		return (
			(options.notANumberMessage as string) ??
			(options.message as string) ??
			"is not a number"
		);
	}
	if (options.integer && !Number.isInteger(num)) {
		return (
			(options.notAnIntegerMessage as string) ??
			(options.message as string) ??
			"must be an integer"
		);
	}
	if (
		options.greaterThan !== undefined &&
		num <= (options.greaterThan as number)
	) {
		return (
			(options.message as string) ??
			`must be greater than ${options.greaterThan}`
		);
	}
	if (
		options.greaterThanOrEqualTo !== undefined &&
		num < (options.greaterThanOrEqualTo as number)
	) {
		return (
			(options.message as string) ??
			`must be greater than or equal to ${options.greaterThanOrEqualTo}`
		);
	}
	if (options.lessThan !== undefined && num >= (options.lessThan as number)) {
		return (
			(options.message as string) ?? `must be less than ${options.lessThan}`
		);
	}
	if (
		options.lessThanOrEqualTo !== undefined &&
		num > (options.lessThanOrEqualTo as number)
	) {
		return (
			(options.message as string) ??
			`must be less than or equal to ${options.lessThanOrEqualTo}`
		);
	}
	if (options.equalTo !== undefined && num !== (options.equalTo as number)) {
		return (options.message as string) ?? `must be equal to ${options.equalTo}`;
	}
	return undefined;
}

function formatValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const pattern = options.pattern as RegExp;
	if (typeof value !== "string" || !pattern.test(value)) {
		return (options.message as string) ?? "is invalid";
	}
	return undefined;
}

function inclusionValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const allowedValues = options.in as readonly unknown[];
	if (!allowedValues.includes(value)) {
		return (options.message as string) ?? "is not included in the list";
	}
	return undefined;
}

function exclusionValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	const disallowedValues = options.in as readonly unknown[];
	if (disallowedValues.includes(value)) {
		return (options.message as string) ?? "is reserved";
	}
	return undefined;
}

function emailValidator(
	value: unknown,
	_record: Record<string, unknown>,
	options: Record<string, unknown>,
): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || !EMAIL_PATTERN.test(value)) {
		return (options.message as string) ?? "is not a valid email address";
	}
	return undefined;
}

// Register built-in validators
VALIDATOR_REGISTRY.set("presence", presenceValidator);
VALIDATOR_REGISTRY.set("length", lengthValidator);
VALIDATOR_REGISTRY.set("numericality", numericalityValidator);
VALIDATOR_REGISTRY.set("format", formatValidator);
VALIDATOR_REGISTRY.set("inclusion", inclusionValidator);
VALIDATOR_REGISTRY.set("exclusion", exclusionValidator);
VALIDATOR_REGISTRY.set("email", emailValidator);

// --- Factory functions ---

type ValidatorOptionsMap = {
	presence: PresenceOptions;
	length: LengthOptions;
	numericality: NumericalityOptions;
	format: FormatOptions;
	inclusion: InclusionOptions;
	exclusion: ExclusionOptions;
	email: EmailOptions;
	custom: CustomFieldOptions;
};

/** Create a field-level validation rule. */
export function validates<Name extends keyof ValidatorOptionsMap>(
	name: Name,
	options?: ValidatorOptionsMap[Name],
): ValidationRule;
export function validates(
	name: string,
	options?: BaseValidationOptions & Record<string, unknown>,
): ValidationRule;
export function validates(
	name: string,
	options?: Record<string, unknown>,
): ValidationRule {
	return { validatorName: name, options: options ?? {} };
}

/** Create a record-level custom validation. */
export function validate(
	fn: (
		record: Record<string, unknown>,
	) => Record<string, string | string[]> | undefined,
	options?: BaseValidationOptions,
): CustomValidation {
	return {
		__brand: "customValidation",
		fn,
		options: options ?? {},
	};
}

// --- Validation runner ---

function shouldRunValidation(
	options: Record<string, unknown>,
	record: Record<string, unknown>,
	context: ValidationContext,
): boolean {
	const onContext = options.on as ValidationContext | undefined;
	if (onContext && onContext !== context) return false;

	const condition = options.if as
		| ((record: Record<string, unknown>) => boolean)
		| undefined;
	if (condition && !condition(record)) return false;

	return true;
}

function runSingleValidator(
	field: string,
	value: unknown,
	record: Record<string, unknown>,
	rule: ValidationRule,
	context: ValidationContext,
	errors: ValidationErrors,
): void {
	if (!shouldRunValidation(rule.options, record, context)) return;

	if (rule.validatorName === "custom") {
		const customOptions = rule.options as unknown as CustomFieldOptions;
		const message = customOptions.validate(value, record);
		if (message) {
			errors.add(field, message);
		}
		return;
	}

	const validator = VALIDATOR_REGISTRY.get(rule.validatorName);
	if (!validator) {
		throw new Error(`Unknown validator: ${rule.validatorName}`);
	}

	const message = validator(value, record, rule.options);
	if (message) {
		errors.add(field, message);
	}
}

/** Collect all validation errors for a model instance. */
export function collectValidationErrors(
	instance: Record<string, unknown>,
	context: ValidationContext,
	modelClass: Record<string, unknown>,
	columns?: Record<string, ColumnDefinition>,
): ValidationErrors {
	const errors = new ValidationErrors();

	// Field-level validations from static validations
	const validations = modelClass.validations as
		| Record<string, ValidationRule | ValidationRule[]>
		| undefined;

	// Auto-validate enum columns from column definitions,
	// skipping fields that have explicit user-defined validations
	if (columns) {
		for (const [field, column] of Object.entries(columns)) {
			if (!column.enumValues) continue;
			if (validations?.[field]) continue;
			const value = instance[field];
			if (value === null || value === undefined) continue;
			if (!column.enumValues.includes(value as string)) {
				errors.add(
					field,
					`is not a valid value (must be one of: ${column.enumValues.join(", ")})`,
				);
			}
		}
	}

	if (validations) {
		for (const [field, rules] of Object.entries(validations)) {
			const value = instance[field];
			const ruleArray = Array.isArray(rules) ? rules : [rules];
			for (const rule of ruleArray) {
				runSingleValidator(field, value, instance, rule, context, errors);
			}
		}
	}

	// Record-level custom validations from static customValidations
	const customValidations = modelClass.customValidations as
		| CustomValidation[]
		| undefined;

	if (customValidations) {
		for (const custom of customValidations) {
			if (!shouldRunValidation(custom.options, instance, context)) continue;

			const result = custom.fn(instance);
			if (result) {
				for (const [field, messages] of Object.entries(result)) {
					const messageArray = Array.isArray(messages) ? messages : [messages];
					for (const message of messageArray) {
						errors.add(field, message);
					}
				}
			}
		}
	}

	return errors;
}

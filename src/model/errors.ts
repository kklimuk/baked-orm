/** Converts camelCase to "Capitalized words": createdAt -> "Created at", userId -> "User id" */
function humanize(field: string): string {
	const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rails-like error collection. Maps field names to arrays of error messages. */
export class ValidationErrors {
	#errors: Map<string, string[]> = new Map();

	/** Add an error message for a field. Use "base" for record-level errors. */
	add(field: string, message: string): void {
		const existing = this.#errors.get(field);
		if (existing) {
			existing.push(message);
		} else {
			this.#errors.set(field, [message]);
		}
	}

	/** Get all error messages for a field. Returns empty array if none. */
	get(field: string): string[] {
		return this.#errors.get(field) ?? [];
	}

	/** Check if a field has any errors. */
	has(field: string): boolean {
		return this.#errors.has(field);
	}

	/** True when no errors have been added. */
	get isEmpty(): boolean {
		return this.#errors.size === 0;
	}

	/** Number of fields with errors. */
	get size(): number {
		return this.#errors.size;
	}

	/** All errors as "Field message" strings: ["Name can't be blank", "Email is invalid"] */
	fullMessages(): string[] {
		const messages: string[] = [];
		for (const [field, fieldMessages] of this.#errors) {
			for (const message of fieldMessages) {
				if (field === "base") {
					messages.push(message);
				} else {
					messages.push(`${humanize(field)} ${message}`);
				}
			}
		}
		return messages;
	}

	/** All errors for a specific field as "Field message" strings. */
	fullMessagesFor(field: string): string[] {
		const fieldMessages = this.#errors.get(field);
		if (!fieldMessages) return [];
		if (field === "base") {
			return [...fieldMessages];
		}
		return fieldMessages.map((message) => `${humanize(field)} ${message}`);
	}

	/** Serialize to plain object: { email: ["is invalid", "is too long"] } */
	toJSON(): Record<string, string[]> {
		const result: Record<string, string[]> = {};
		for (const [field, messages] of this.#errors) {
			result[field] = [...messages];
		}
		return result;
	}

	[Symbol.iterator](): Iterator<[string, string[]]> {
		return this.#errors[Symbol.iterator]();
	}
}

/** Thrown when save() or create() fails validation. Contains structured errors. */
export class ValidationError extends Error {
	errors: ValidationErrors;
	modelName: string;

	constructor(modelName: string, errors: ValidationErrors) {
		const messages = errors.fullMessages();
		super(`Validation failed for ${modelName}: ${messages.join(", ")}`);
		this.name = "ValidationError";
		this.modelName = modelName;
		this.errors = errors;
	}
}

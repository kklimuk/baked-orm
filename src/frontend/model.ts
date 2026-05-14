import { ValidationErrors } from "../model/errors";
import { serialize } from "../model/serializer";
import { Snapshot } from "../model/snapshot";
import {
	collectValidationErrors,
	type ValidationContext,
} from "../model/validations";
import type { TableDefinition } from "../types";
import { hydrate } from "./hydrate";

/** Instance interface for frontend models. */
export interface FrontendBaseModel {
	readonly isNewRecord: boolean;
	readonly errors: ValidationErrors;
	assignAttributes(attributes: Record<string, unknown>): void;
	markPersisted(): void;
	changed(fieldName?: string): boolean;
	changedAttributes(): Record<string, { was: unknown; now: unknown }>;
	isValid(context?: ValidationContext): boolean;
	toJSON(): Record<string, unknown>;
}

/** Static interface for frontend model classes. */
export interface FrontendModelStatic<Row = unknown> {
	new (attributes?: Partial<Row>): Row & FrontendBaseModel;
	tableDefinition: TableDefinition<Row>;
	/** Stable identifier used on the wire as `__typename`. Set by `registerModels`. */
	typename?: string;
	fromJSON(json: Record<string, unknown>): Row & FrontendBaseModel;
}

/**
 * Frontend model factory. Creates a class with dirty tracking, validations,
 * and hydration — but no CRUD, query builder, callbacks, or DB connection.
 */
export function FrontendModel<Row>(
	tableDefinition: TableDefinition<Row>,
): FrontendModelStatic<Row> {
	const RowClass = tableDefinition.rowClass;
	const columns = tableDefinition.columns;
	const primaryKeyField = tableDefinition.primaryKey[0] ?? "id";

	class FrontendBase extends (RowClass as unknown as new () => Record<
		string,
		unknown
	>) {
		#snapshot = new Snapshot(columns, primaryKeyField);
		#persisted = false;
		#validationErrors = new ValidationErrors();

		static tableDefinition = tableDefinition;

		constructor(attributes?: Partial<Row>) {
			super();
			if (attributes) {
				Object.assign(this, attributes);
			}
		}

		get isNewRecord(): boolean {
			return !this.#persisted;
		}

		get errors(): ValidationErrors {
			return this.#validationErrors;
		}

		// --- Dirty tracking (delegates to Snapshot) ---

		changed(fieldName?: string): boolean {
			return this.#snapshot.changed(this, fieldName);
		}

		changedAttributes(): Record<string, { was: unknown; now: unknown }> {
			return this.#snapshot.changedAttributes(this);
		}

		assignAttributes(attributes: Partial<Row>): void {
			Object.assign(this, attributes);
		}

		markPersisted(): void {
			this.#persisted = true;
			this.#snapshot.capture(this);
		}

		// --- Validations (reuse backend validation runner) ---

		isValid(context: ValidationContext = "create"): boolean {
			const modelClass = this.constructor as unknown as Record<string, unknown>;
			this.#validationErrors = collectValidationErrors(
				this,
				context,
				modelClass,
				columns,
			);
			return this.#validationErrors.isEmpty;
		}

		// --- Serialization (for sending back to API) ---

		toJSON(): Record<string, unknown> {
			return serialize(this, tableDefinition);
		}

		// --- Hydration ---

		static fromJSON(json: Record<string, unknown>): FrontendBase {
			return hydrate(json) as FrontendBase;
		}
	}

	return FrontendBase as unknown as FrontendModelStatic<Row>;
}

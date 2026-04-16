import { applyModelPlugins } from "../plugins";
import type { TableDefinition } from "../types";
import { runCallbacks } from "./callbacks";
import { getModelConnection } from "./connection";
import { ValidationError, ValidationErrors } from "./errors";
import { QueryBuilder } from "./query";
import type { SerializeOptions } from "./serializer";
import { serialize as serializeModel } from "./serializer";
import { Snapshot } from "./snapshot";
import {
	type AnyAssociationDef,
	type AnyModelStatic,
	type AssociationDefinition,
	type AssociationProperties,
	type ConflictOption,
	type InsertOptions,
	type ModelStatic,
	type OrderDirection,
	RecordNotFoundError,
	belongsTo as standaloneBelongsTo,
	hasMany as standaloneHasMany,
	hasManyThrough as standaloneHasManyThrough,
	hasOne as standaloneHasOne,
} from "./types";
import {
	buildConflictClause,
	buildReverseColumnMap,
	buildSensitiveColumns,
	executeQuery,
	hydrateInstance,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "./utils";
import { collectValidationErrors, type ValidationContext } from "./validations";
import { compileConditions, type WhereConditions } from "./where";

const MODEL_REGISTRY = new Map<string, AnyModelStatic>();

export function getModelRegistry(): Map<string, AnyModelStatic> {
	return MODEL_REGISTRY;
}

export function Model<Row>(
	tableDefinition: TableDefinition<Row>,
): ModelStatic<Row>;
export function Model<
	Row,
	Associations extends Record<string, AnyAssociationDef>,
>(
	tableDefinition: TableDefinition<Row>,
	associations: Associations,
): ModelStatic<Row & AssociationProperties<Associations>>;
export function Model<Row>(
	tableDefinition: TableDefinition<Row>,
	associations?: Record<string, AnyAssociationDef>,
): ModelStatic<Row> {
	const RowClass = tableDefinition.rowClass;
	const tableName = tableDefinition.tableName;
	const columns = tableDefinition.columns;
	const primaryKeyField = tableDefinition.primaryKey[0] ?? "id";
	const reverseMap = buildReverseColumnMap(columns);

	function buildBatchParams(records: Partial<Row>[]): {
		dbColumns: string[];
		allValues: unknown[];
		rowPlaceholders: string[];
	} {
		const firstRecord = records[0] as Partial<Row>;
		const camelKeys = Object.keys(firstRecord);
		const dbColumns = camelKeys.map((key) => resolveColumnName(key, columns));

		const allValues: unknown[] = [];
		const rowPlaceholders: string[] = [];
		let paramIndex = 1;

		for (const record of records) {
			const placeholders = camelKeys.map(() => `$${paramIndex++}`);
			rowPlaceholders.push(`(${placeholders.join(", ")})`);
			for (const key of camelKeys) {
				allValues.push((record as Record<string, unknown>)[key]);
			}
		}

		return { dbColumns, allValues, rowPlaceholders };
	}

	function buildConflictSQL(
		conflict: ConflictOption<Row>,
		defaultAction: "update" | "ignore",
		dbColumns: string[],
		paramOffset: number,
	): { conflictSQL: string; extraValues: unknown[] } {
		if (conflict === "ignore") {
			return { conflictSQL: " ON CONFLICT DO NOTHING", extraValues: [] };
		}

		const { conflictTarget, updateSet } = buildConflictClause(
			dbColumns,
			conflict,
			columns,
		);

		let whereSQL = "";
		const extraValues: unknown[] = [];

		if ("columns" in conflict && conflict.where) {
			const compiled = compileConditions(
				conflict.where as Record<string, unknown>,
				columns,
				paramOffset,
			);
			if (compiled.length > 0) {
				whereSQL = ` WHERE ${compiled.map((clause) => clause.fragment).join(" AND ")}`;
				for (const clause of compiled) {
					extraValues.push(...clause.values);
				}
			}
		}

		const action = conflict.action ?? defaultAction;
		let actionSQL: string;
		if (action === "update") {
			// When all inserted columns are conflict columns, updateSet is empty.
			// Fall back to setting the first column to itself (harmless no-op).
			const firstColumn = dbColumns[0];
			const effectiveUpdateSet =
				updateSet ||
				(firstColumn
					? `${quoteIdentifier(firstColumn)} = EXCLUDED.${quoteIdentifier(firstColumn)}`
					: "");
			actionSQL = `DO UPDATE SET ${effectiveUpdateSet}`;
		} else {
			actionSQL = "DO NOTHING";
		}

		return {
			conflictSQL: ` ON CONFLICT ${conflictTarget}${whereSQL} ${actionSQL}`,
			extraValues,
		};
	}

	function hydrateRows<ModelClass extends new () => object>(
		Klass: ModelClass,
		// biome-ignore lint/suspicious/noExplicitAny: Bun.sql result rows
		rows: any[],
	): InstanceType<ModelClass>[] {
		const results: InstanceType<ModelClass>[] = [];
		for (const row of rows) {
			const mapped = mapRowToModel(row as Record<string, unknown>, reverseMap);
			results.push(hydrateInstance(Klass, mapped) as InstanceType<ModelClass>);
		}
		return results;
	}

	class ModelBase extends (RowClass as unknown as new () => Record<
		string,
		unknown
	>) {
		#persisted = false;
		#validationErrors = new ValidationErrors();
		#snapshot = new Snapshot(columns, primaryKeyField);
		#conflictOption: ConflictOption<Row> | undefined;

		static tableDefinition = tableDefinition;
		static tableName = tableName;
		static primaryKeyField = primaryKeyField;

		constructor(attributes?: Partial<Row>) {
			super();
			if (attributes) {
				Object.assign(this, attributes);
			}
			const className = this.constructor.name;
			if (!MODEL_REGISTRY.has(className)) {
				MODEL_REGISTRY.set(className, this.constructor as AnyModelStatic);
			}
		}

		get isNewRecord(): boolean {
			return !this.#persisted;
		}

		get errors(): ValidationErrors {
			return this.#validationErrors;
		}

		markPersisted(): void {
			this.#persisted = true;
			this.#snapshot.capture(this);
		}

		/** @internal — for plugin use (e.g. soft-delete, locking) */
		_captureSnapshot(): void {
			this.#snapshot.capture(this);
		}

		changed(fieldName?: string): boolean {
			return this.#snapshot.changed(this, fieldName);
		}

		changedAttributes(): Record<string, { was: unknown; now: unknown }> {
			return this.#snapshot.changedAttributes(this);
		}

		async isValid(): Promise<boolean> {
			await this.#runValidation();
			return this.#validationErrors.isEmpty;
		}

		async save(): Promise<void> {
			const modelClass = this.constructor as unknown as Record<string, unknown>;

			await this.#runValidation();
			if (!this.#validationErrors.isEmpty) {
				this.#conflictOption = undefined;
				throw new ValidationError(
					this.constructor.name,
					this.#validationErrors,
				);
			}

			await runCallbacks("beforeSave", this, modelClass);

			if (this.isNewRecord) {
				await runCallbacks("beforeCreate", this, modelClass);
				await this.#performInsert();
				await runCallbacks("afterCreate", this, modelClass);
			} else {
				await runCallbacks("beforeUpdate", this, modelClass);
				await this.#performUpdate();
				await runCallbacks("afterUpdate", this, modelClass);
			}

			await runCallbacks("afterSave", this, modelClass);
		}

		async #runValidation(): Promise<void> {
			const context: ValidationContext = this.isNewRecord ? "create" : "update";
			const modelClass = this.constructor as unknown as Record<string, unknown>;
			this.#validationErrors = new ValidationErrors();
			await runCallbacks("beforeValidation", this, modelClass);
			this.#validationErrors = collectValidationErrors(
				this,
				context,
				modelClass,
				columns,
			);
			await runCallbacks("afterValidation", this, modelClass);
		}

		#getSensitiveColumns(): Set<string> {
			return buildSensitiveColumns(this.constructor, columns);
		}

		async #performInsert(): Promise<void> {
			const connection = getModelConnection();
			const sensitiveDbColumns = this.#getSensitiveColumns();
			const columnEntries = Object.entries(columns).filter(
				([camelKey]) => this[camelKey] !== undefined,
			);
			const dbColumns = columnEntries.map(
				([, definition]) => definition.columnName,
			);
			const values = columnEntries.map(([camelKey]) => this[camelKey]);
			const placeholders = dbColumns.map((_, index) => `$${index + 1}`);

			let conflictSQL = "";
			const allValues = [...values];
			const conflict = this.#conflictOption;
			this.#conflictOption = undefined;

			if (conflict) {
				const result = buildConflictSQL(
					conflict,
					"ignore",
					dbColumns,
					values.length + 1,
				);
				conflictSQL = result.conflictSQL;
				allValues.push(...result.extraValues);
			}

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")})${conflictSQL} RETURNING *`;
			const rows = await executeQuery(
				connection,
				text,
				allValues,
				sensitiveDbColumns,
			);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
				this.#persisted = true;
				this.#snapshot.capture(this);
			} else if (!conflict) {
				this.#persisted = true;
				this.#snapshot.capture(this);
			}
			// If conflict was set and no row returned (DO NOTHING triggered),
			// instance stays un-persisted — caller can check isNewRecord.
		}

		async #performUpdate(): Promise<void> {
			const dirtyEntries = this.#snapshot.dirtyEntries(this);

			if (dirtyEntries.length === 0) return;

			const connection = getModelConnection();
			const sensitiveDbColumns = this.#getSensitiveColumns();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const setClauses = dirtyEntries.map(
				([, definition], index) =>
					`${quoteIdentifier(definition.columnName)} = $${index + 1}`,
			);
			const values = [
				...dirtyEntries.map(([camelKey]) => this[camelKey]),
				this[primaryKeyField],
			];

			const text = `UPDATE ${quoteIdentifier(tableName)} SET ${setClauses.join(", ")} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $${dirtyEntries.length + 1} RETURNING *`;
			const rows = await executeQuery(
				connection,
				text,
				values,
				sensitiveDbColumns,
			);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			this.#snapshot.capture(this);
		}

		assignAttributes(attributes: Partial<Row>): void {
			Object.assign(this, attributes);
		}

		async update(attributes: Partial<Row>): Promise<void> {
			this.assignAttributes(attributes);
			await this.save();
		}

		async destroy(): Promise<void> {
			const modelClass = this.constructor as unknown as Record<string, unknown>;

			await runCallbacks("beforeDestroy", this, modelClass);

			const connection = getModelConnection();
			const sensitiveDbColumns = this.#getSensitiveColumns();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const text = `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1`;
			await executeQuery(
				connection,
				text,
				[this[primaryKeyField]],
				sensitiveDbColumns,
			);
			this.#persisted = false;

			await runCallbacks("afterDestroy", this, modelClass);
		}

		async reload(): Promise<void> {
			const connection = getModelConnection();
			const sensitiveDbColumns = this.#getSensitiveColumns();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const text = `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1`;
			const rows = await executeQuery(
				connection,
				text,
				[this[primaryKeyField]],
				sensitiveDbColumns,
			);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			this.#snapshot.capture(this);
		}

		async load(associationName: string): Promise<unknown> {
			if (this[associationName] !== undefined) {
				return this[associationName];
			}

			const { loadAssociation } = await import("./associations");
			const result = await loadAssociation(
				this,
				associationName,
				this.constructor,
				tableDefinition,
			);
			this[associationName] = result;
			return result;
		}

		toJSON(): Record<string, unknown> {
			return serializeModel(this, tableDefinition);
		}

		serialize(options?: SerializeOptions): Record<string, unknown> {
			return serializeModel(this, tableDefinition, options);
		}

		// --- Class methods ---
		// Static methods use `this` parameter so `User.find()` returns `Promise<User>`, not `Promise<ModelBase>`

		static where(conditions: WhereConditions<Row>): QueryBuilder<Row> {
			return new QueryBuilder<Row>(tableDefinition, {
				modelClass: this as unknown as new (attributes?: Partial<Row>) => Row,
			}).where(conditions);
		}

		static whereRaw(fragment: string, values?: unknown[]): QueryBuilder<Row> {
			return new QueryBuilder<Row>(tableDefinition, {
				modelClass: this as unknown as new (attributes?: Partial<Row>) => Row,
			}).whereRaw(fragment, values);
		}

		static order(
			clause: Partial<Record<keyof Row & string, OrderDirection>>,
		): QueryBuilder<Row> {
			return new QueryBuilder<Row>(tableDefinition, {
				modelClass: this as unknown as new (attributes?: Partial<Row>) => Row,
			}).order(clause);
		}

		static limit(count: number): QueryBuilder<Row> {
			return new QueryBuilder<Row>(tableDefinition, {
				modelClass: this as unknown as new (attributes?: Partial<Row>) => Row,
			}).limit(count);
		}

		static all(): QueryBuilder<Row> {
			return new QueryBuilder<Row>(tableDefinition, {
				modelClass: this as unknown as new (attributes?: Partial<Row>) => Row,
			});
		}

		static async find<Subclass extends typeof ModelBase>(
			this: Subclass,
			primaryKey: unknown,
		): Promise<InstanceType<Subclass>> {
			const result = await this.findBy({
				[primaryKeyField]: primaryKey,
			} as Partial<Row>);
			if (!result) {
				throw new RecordNotFoundError(this.name, primaryKey);
			}
			return result;
		}

		static async findBy<Subclass extends typeof ModelBase>(
			this: Subclass,
			conditions: WhereConditions<Row>,
		): Promise<InstanceType<Subclass> | null> {
			const result = await this.where(conditions).first();
			return result as InstanceType<Subclass> | null;
		}

		static async findBySql<Subclass extends typeof ModelBase>(
			this: Subclass,
			sqlText: string,
			values?: unknown[],
		): Promise<InstanceType<Subclass>[]> {
			const connection = getModelConnection();
			const sensitiveDbColumns = buildSensitiveColumns(this, columns);
			const rows = await executeQuery(
				connection,
				sqlText,
				values,
				sensitiveDbColumns,
			);
			return hydrateRows(this, rows);
		}

		static async first<Subclass extends typeof ModelBase>(
			this: Subclass,
		): Promise<InstanceType<Subclass> | null> {
			return this.all().first() as Promise<InstanceType<Subclass> | null>;
		}

		static async last<Subclass extends typeof ModelBase>(
			this: Subclass,
		): Promise<InstanceType<Subclass> | null> {
			return this.all().last() as Promise<InstanceType<Subclass> | null>;
		}

		static async count(): Promise<number> {
			return this.all().count();
		}

		static async exists(conditions?: WhereConditions<Row>): Promise<boolean> {
			if (conditions) {
				return this.where(conditions).exists();
			}
			return this.all().exists();
		}

		static async create<Subclass extends typeof ModelBase>(
			this: Subclass,
			attributes: Partial<Row>,
			options?: InsertOptions<Row>,
		): Promise<InstanceType<Subclass>> {
			const instance = new this(attributes) as InstanceType<Subclass>;
			if (options?.conflict) {
				(instance as ModelBase).#conflictOption = options.conflict;
			}
			await instance.save();
			return instance;
		}

		static async createMany<Subclass extends typeof ModelBase>(
			this: Subclass,
			records: Partial<Row>[],
			options?: InsertOptions<Row>,
		): Promise<InstanceType<Subclass>[]> {
			if (records.length === 0) return [];

			const { dbColumns, allValues, rowPlaceholders } =
				buildBatchParams(records);
			const sensitiveDbColumns = buildSensitiveColumns(this, columns);

			let conflictSQL = "";
			let finalValues = allValues;

			if (options?.conflict) {
				const result = buildConflictSQL(
					options.conflict,
					"ignore",
					dbColumns,
					allValues.length + 1,
				);
				conflictSQL = result.conflictSQL;
				if (result.extraValues.length > 0) {
					finalValues = [...allValues, ...result.extraValues];
				}
			}

			const connection = getModelConnection();
			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")}${conflictSQL} RETURNING *`;
			const rows = await executeQuery(
				connection,
				text,
				finalValues,
				sensitiveDbColumns,
			);

			return hydrateRows(this, rows);
		}

		static async upsert<Subclass extends typeof ModelBase>(
			this: Subclass,
			attributes: Partial<Row>,
			options: Required<InsertOptions<Row>>,
		): Promise<InstanceType<Subclass>> {
			const connection = getModelConnection();
			const sensitiveDbColumns = buildSensitiveColumns(this, columns);
			const camelKeys = Object.keys(attributes);
			const dbColumns = camelKeys.map((key) => resolveColumnName(key, columns));
			const values = camelKeys.map(
				(key) => (attributes as Record<string, unknown>)[key],
			);
			const placeholders = dbColumns.map((_, index) => `$${index + 1}`);

			const { conflictSQL, extraValues } = buildConflictSQL(
				options.conflict,
				"update",
				dbColumns,
				values.length + 1,
			);
			const finalValues =
				extraValues.length > 0 ? [...values, ...extraValues] : values;

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")})${conflictSQL} RETURNING *`;
			const rows = await executeQuery(
				connection,
				text,
				finalValues,
				sensitiveDbColumns,
			);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (!row) {
				throw new Error(
					`${this.name}.upsert: conflict with action "ignore" matched an existing row — no row returned. Use create() with conflict instead if you expect skipped inserts.`,
				);
			}
			const mapped = mapRowToModel(row, reverseMap);
			return hydrateInstance(this, mapped) as InstanceType<Subclass>;
		}

		static async upsertAll<Subclass extends typeof ModelBase>(
			this: Subclass,
			records: Partial<Row>[],
			options: Required<InsertOptions<Row>>,
		): Promise<InstanceType<Subclass>[]> {
			if (records.length === 0) return [];

			const { dbColumns, allValues, rowPlaceholders } =
				buildBatchParams(records);
			const sensitiveDbColumns = buildSensitiveColumns(this, columns);

			const { conflictSQL, extraValues } = buildConflictSQL(
				options.conflict,
				"update",
				dbColumns,
				allValues.length + 1,
			);
			const finalValues =
				extraValues.length > 0 ? [...allValues, ...extraValues] : allValues;

			const connection = getModelConnection();
			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")}${conflictSQL} RETURNING *`;
			const rows = await executeQuery(
				connection,
				text,
				finalValues,
				sensitiveDbColumns,
			);

			return hydrateRows(this, rows);
		}

		static hasMany(
			model: () => AnyModelStatic,
			options?: { foreignKey?: string; as?: string },
		): AssociationDefinition {
			return standaloneHasMany(model, options) as AssociationDefinition;
		}

		static hasOne(
			model: () => AnyModelStatic,
			options?: { foreignKey?: string; as?: string },
		): AssociationDefinition {
			return standaloneHasOne(model, options) as AssociationDefinition;
		}

		static belongsTo(
			modelOrOptions: (() => AnyModelStatic) | { polymorphic: true },
			options?: { foreignKey?: string },
		): AssociationDefinition {
			if (typeof modelOrOptions === "function") {
				return standaloneBelongsTo(
					modelOrOptions,
					options,
				) as AssociationDefinition;
			}
			return standaloneBelongsTo(modelOrOptions) as AssociationDefinition;
		}

		static hasManyThrough(
			model: () => AnyModelStatic,
			options: {
				through: string;
				foreignKey?: string;
				source?: string;
			},
		): AssociationDefinition {
			return standaloneHasManyThrough(model, options) as AssociationDefinition;
		}
	}

	if (associations) {
		for (const [associationName, definition] of Object.entries(associations)) {
			Object.defineProperty(ModelBase, associationName, { value: definition });
		}
	}

	applyModelPlugins(ModelBase);

	const typedModel = ModelBase as unknown as ModelStatic<Row>;
	MODEL_REGISTRY.set(ModelBase.name, typedModel as AnyModelStatic);
	return typedModel;
}

import type { TableDefinition } from "../types";
import { runCallbacks } from "./callbacks";
import { getModelConnection } from "./connection";
import { ValidationError, ValidationErrors } from "./errors";
import { QueryBuilder } from "./query";
import {
	type AnyAssociationDef,
	type AnyModelStatic,
	type AssociationDefinition,
	type AssociationProperties,
	type ModelStatic,
	type OrderDirection,
	RecordNotFoundError,
	belongsTo as standaloneBelongsTo,
	hasMany as standaloneHasMany,
	hasManyThrough as standaloneHasManyThrough,
	hasOne as standaloneHasOne,
	type UpsertOptions,
} from "./types";
import {
	buildConflictClause,
	buildReverseColumnMap,
	executeQuery,
	hydrateInstance,
	mapRowToModel,
	quoteIdentifier,
	resolveColumnName,
} from "./utils";
import { collectValidationErrors, type ValidationContext } from "./validations";

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
		#snapshot: Map<string, unknown> = new Map();

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
			this.#takeSnapshot();
		}

		changed(fieldName?: string): boolean {
			if (fieldName !== undefined) {
				return this.#snapshot.get(fieldName) !== this[fieldName];
			}
			for (const camelKey of Object.keys(columns)) {
				if (camelKey === primaryKeyField) continue;
				if (this.#snapshot.get(camelKey) !== this[camelKey]) return true;
			}
			return false;
		}

		changedAttributes(): Record<string, { was: unknown; now: unknown }> {
			const changes: Record<string, { was: unknown; now: unknown }> = {};
			for (const camelKey of Object.keys(columns)) {
				if (camelKey === primaryKeyField) continue;
				const snapshotValue = this.#snapshot.get(camelKey);
				const currentValue = this[camelKey];
				if (snapshotValue !== currentValue) {
					changes[camelKey] = { was: snapshotValue, now: currentValue };
				}
			}
			return changes;
		}

		#takeSnapshot(): void {
			this.#snapshot.clear();
			for (const camelKey of Object.keys(columns)) {
				this.#snapshot.set(camelKey, this[camelKey]);
			}
		}

		async isValid(): Promise<boolean> {
			await this.#runValidation();
			return this.#validationErrors.isEmpty;
		}

		async save(): Promise<void> {
			const modelClass = this.constructor as unknown as Record<string, unknown>;

			await this.#runValidation();
			if (!this.#validationErrors.isEmpty) {
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
			);
			await runCallbacks("afterValidation", this, modelClass);
		}

		async #performInsert(): Promise<void> {
			const connection = getModelConnection();
			const columnEntries = Object.entries(columns).filter(
				([camelKey]) => this[camelKey] !== undefined,
			);
			const dbColumns = columnEntries.map(
				([, definition]) => definition.columnName,
			);
			const values = columnEntries.map(([camelKey]) => this[camelKey]);
			const placeholders = dbColumns.map((_, index) => `$${index + 1}`);

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
			const rows = await executeQuery(connection, text, values);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			this.#persisted = true;
			this.#takeSnapshot();
		}

		async #performUpdate(): Promise<void> {
			const dirtyEntries = Object.entries(columns).filter(
				([camelKey]) =>
					camelKey !== primaryKeyField &&
					this.#snapshot.get(camelKey) !== this[camelKey],
			);

			if (dirtyEntries.length === 0) return;

			const connection = getModelConnection();
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
			const rows = await executeQuery(connection, text, values);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			this.#takeSnapshot();
		}

		async update(attributes: Partial<Row>): Promise<void> {
			Object.assign(this, attributes);
			await this.save();
		}

		async destroy(): Promise<void> {
			const modelClass = this.constructor as unknown as Record<string, unknown>;

			await runCallbacks("beforeDestroy", this, modelClass);

			const connection = getModelConnection();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const text = `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1`;
			await executeQuery(connection, text, [this[primaryKeyField]]);
			this.#persisted = false;

			await runCallbacks("afterDestroy", this, modelClass);
		}

		async reload(): Promise<void> {
			const connection = getModelConnection();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const text = `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1`;
			const rows = await executeQuery(connection, text, [
				this[primaryKeyField],
			]);
			const row = rows[0] as Record<string, unknown> | undefined;
			if (row) {
				Object.assign(this, mapRowToModel(row, reverseMap));
			}
			this.#takeSnapshot();
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
			const result: Record<string, unknown> = {};
			for (const camelKey of Object.keys(columns)) {
				result[camelKey] = this[camelKey];
			}
			return result;
		}

		// --- Class methods ---
		// Static methods use `this` parameter so `User.find()` returns `Promise<User>`, not `Promise<ModelBase>`

		static where(conditions: Partial<Row>): QueryBuilder<Row> {
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
			conditions: Partial<Row>,
		): Promise<InstanceType<Subclass> | null> {
			const result = await this.where(conditions).first();
			return result as InstanceType<Subclass> | null;
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

		static async exists(conditions?: Partial<Row>): Promise<boolean> {
			if (conditions) {
				return this.where(conditions).exists();
			}
			return this.all().exists();
		}

		static async create<Subclass extends typeof ModelBase>(
			this: Subclass,
			attributes: Partial<Row>,
		): Promise<InstanceType<Subclass>> {
			const instance = new this(attributes) as InstanceType<Subclass>;
			await instance.save();
			return instance;
		}

		static async createMany<Subclass extends typeof ModelBase>(
			this: Subclass,
			records: Partial<Row>[],
		): Promise<InstanceType<Subclass>[]> {
			if (records.length === 0) return [];

			const { dbColumns, allValues, rowPlaceholders } =
				buildBatchParams(records);

			const connection = getModelConnection();
			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")} RETURNING *`;
			const rows = await executeQuery(connection, text, allValues);

			return hydrateRows(this, rows);
		}

		static async upsert<Subclass extends typeof ModelBase>(
			this: Subclass,
			attributes: Partial<Row>,
			options: UpsertOptions,
		): Promise<InstanceType<Subclass>> {
			const connection = getModelConnection();
			const camelKeys = Object.keys(attributes);
			const dbColumns = camelKeys.map((key) => resolveColumnName(key, columns));
			const values = camelKeys.map(
				(key) => (attributes as Record<string, unknown>)[key],
			);
			const placeholders = dbColumns.map((_, index) => `$${index + 1}`);

			const { conflictClause, updateSet } = buildConflictClause(
				dbColumns,
				options.conflictColumns,
				columns,
			);

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (${conflictClause}) DO UPDATE SET ${updateSet} RETURNING *`;
			const rows = await executeQuery(connection, text, values);
			const row = rows[0] as Record<string, unknown> | undefined;
			const mapped = row ? mapRowToModel(row, reverseMap) : {};
			return hydrateInstance(this, mapped) as InstanceType<Subclass>;
		}

		static async upsertAll<Subclass extends typeof ModelBase>(
			this: Subclass,
			records: Partial<Row>[],
			options: UpsertOptions,
		): Promise<InstanceType<Subclass>[]> {
			if (records.length === 0) return [];

			const { dbColumns, allValues, rowPlaceholders } =
				buildBatchParams(records);

			const { conflictClause, updateSet } = buildConflictClause(
				dbColumns,
				options.conflictColumns,
				columns,
			);

			const connection = getModelConnection();
			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")} ON CONFLICT (${conflictClause}) DO UPDATE SET ${updateSet} RETURNING *`;
			const rows = await executeQuery(connection, text, allValues);

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

	const typedModel = ModelBase as unknown as ModelStatic<Row>;
	MODEL_REGISTRY.set(ModelBase.name, typedModel as AnyModelStatic);
	return typedModel;
}

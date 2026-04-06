import type { TableDefinition } from "../types";
import { getModelConnection } from "./connection";
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

	class ModelBase extends (RowClass as unknown as new () => Record<
		string,
		unknown
	>) {
		#persisted = false;

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

		markPersisted(): void {
			this.#persisted = true;
		}

		async save(): Promise<void> {
			const connection = getModelConnection();

			if (this.isNewRecord) {
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
			} else {
				const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
				const columnEntries = Object.entries(columns).filter(
					([camelKey]) => camelKey !== primaryKeyField,
				);
				const setClauses = columnEntries.map(
					([, definition], index) =>
						`${quoteIdentifier(definition.columnName)} = $${index + 1}`,
				);
				const values = [
					...columnEntries.map(([camelKey]) => this[camelKey]),
					this[primaryKeyField],
				];

				const text = `UPDATE ${quoteIdentifier(tableName)} SET ${setClauses.join(", ")} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $${columnEntries.length + 1} RETURNING *`;
				const rows = await executeQuery(connection, text, values);
				const row = rows[0] as Record<string, unknown> | undefined;
				if (row) {
					Object.assign(this, mapRowToModel(row, reverseMap));
				}
			}
		}

		async update(attributes: Partial<Row>): Promise<void> {
			Object.assign(this, attributes);
			await this.save();
		}

		async destroy(): Promise<void> {
			const connection = getModelConnection();
			const primaryKeyDbColumn = resolveColumnName(primaryKeyField, columns);
			const text = `DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(primaryKeyDbColumn)} = $1`;
			await executeQuery(connection, text, [this[primaryKeyField]]);
			this.#persisted = false;
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

			const connection = getModelConnection();
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

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")} RETURNING *`;
			const rows = await executeQuery(connection, text, allValues);

			const results: InstanceType<Subclass>[] = [];
			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					reverseMap,
				);
				results.push(hydrateInstance(this, mapped) as InstanceType<Subclass>);
			}
			return results;
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

			const connection = getModelConnection();
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

			const { conflictClause, updateSet } = buildConflictClause(
				dbColumns,
				options.conflictColumns,
				columns,
			);

			const text = `INSERT INTO ${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${rowPlaceholders.join(", ")} ON CONFLICT (${conflictClause}) DO UPDATE SET ${updateSet} RETURNING *`;
			const rows = await executeQuery(connection, text, allValues);

			const results: InstanceType<Subclass>[] = [];
			for (const row of rows) {
				const mapped = mapRowToModel(
					row as Record<string, unknown>,
					reverseMap,
				);
				results.push(hydrateInstance(this, mapped) as InstanceType<Subclass>);
			}
			return results;
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

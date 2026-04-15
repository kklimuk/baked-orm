import type { TableDefinition } from "../types";
import type { ValidationErrors } from "./errors";
import type { QueryBuilder } from "./query";
import type { WhereConditions } from "./where";

export class RecordNotFoundError extends Error {
	modelName: string;
	primaryKey: unknown;

	constructor(modelName: string, primaryKey: unknown) {
		super(`${modelName} with primary key ${String(primaryKey)} not found`);
		this.name = "RecordNotFoundError";
		this.modelName = modelName;
		this.primaryKey = primaryKey;
	}
}

export type OrderDirection = "ASC" | "DESC";

export type LockMode =
	| "FOR UPDATE"
	| "FOR NO KEY UPDATE"
	| "FOR SHARE"
	| "FOR KEY SHARE"
	| "FOR UPDATE NOWAIT"
	| "FOR NO KEY UPDATE NOWAIT"
	| "FOR SHARE NOWAIT"
	| "FOR KEY SHARE NOWAIT"
	| "FOR UPDATE SKIP LOCKED"
	| "FOR NO KEY UPDATE SKIP LOCKED"
	| "FOR SHARE SKIP LOCKED"
	| "FOR KEY SHARE SKIP LOCKED";

export type AssociationType =
	| "belongsTo"
	| "hasOne"
	| "hasMany"
	| "hasManyThrough";

export type AssociationDefinition = {
	readonly associationType: AssociationType;
	readonly model?: () => AnyModelStatic;
	readonly modelName?: string;
	readonly foreignKey?: string;
	readonly primaryKey?: string;
	readonly polymorphic?: boolean;
	readonly as?: string;
	readonly through?: string;
	readonly source?: string;
};

/** Minimal interface for association model references — avoids strict Row generic constraints */
export interface AnyModelStatic {
	// biome-ignore lint/suspicious/noExplicitAny: association targets are resolved dynamically
	new (...args: any[]): any;
	tableDefinition: TableDefinition;
	tableName: string;
	primaryKeyField: string;
	name: string;
}

// --- Conflict / upsert option types ---

/** Column-based or named-constraint conflict target for INSERT ... ON CONFLICT */
export type ConflictTarget<Row = Record<string, unknown>> =
	| {
			columns: string[];
			constraint?: never;
			where?: WhereConditions<Row>;
			action?: "update" | "ignore";
	  }
	| {
			constraint: string;
			columns?: never;
			where?: never;
			action?: "update" | "ignore";
	  };

/** Conflict option — "ignore" shorthand (untargeted DO NOTHING) or a full target */
export type ConflictOption<Row = Record<string, unknown>> =
	| "ignore"
	| ConflictTarget<Row>;

/**
 * Options for insert methods. Default action depends on the method:
 * - upsert/upsertAll: default "update" (DO UPDATE)
 * - create/createMany: default "ignore" (DO NOTHING)
 * An explicit `action` on the conflict target overrides the default.
 */
export type InsertOptions<Row = Record<string, unknown>> = {
	conflict?: ConflictOption<Row>;
};

// --- Branded association definition types ---
// These carry the target model type so TypeScript can infer instance properties

export type HasManyDef<Target> = AssociationDefinition & {
	readonly __brand: "hasMany";
	readonly __target: Target[];
};

export type HasOneDef<Target> = AssociationDefinition & {
	readonly __brand: "hasOne";
	readonly __target: Target | null;
};

export type BelongsToDef<Target> = AssociationDefinition & {
	readonly __brand: "belongsTo";
	readonly __target: Target | null;
};

export type HasManyThroughDef<Target> = AssociationDefinition & {
	readonly __brand: "hasManyThrough";
	readonly __target: Target[];
};

export type PolymorphicBelongsToDef<Target = unknown> =
	AssociationDefinition & {
		readonly __brand: "belongsToPolymorphic";
		readonly __target: Target | null;
	};

/** Any branded association definition */
export type AnyAssociationDef =
	// biome-ignore lint/suspicious/noExplicitAny: union must cover all branded variants
	| HasManyDef<any>
	// biome-ignore lint/suspicious/noExplicitAny: union must cover all branded variants
	| HasOneDef<any>
	// biome-ignore lint/suspicious/noExplicitAny: union must cover all branded variants
	| BelongsToDef<any>
	// biome-ignore lint/suspicious/noExplicitAny: union must cover all branded variants
	| HasManyThroughDef<any>
	// biome-ignore lint/suspicious/noExplicitAny: union must cover all branded variants
	| PolymorphicBelongsToDef<any>;

/** Extracts the instance property type from a branded association definition */
type AssociationValue<Def> = Def extends { readonly __target: infer Value }
	? Value
	: never;

/** Maps an association definitions object to the corresponding instance property types */
export type AssociationProperties<
	Associations extends Record<string, AnyAssociationDef>,
> = {
	[K in keyof Associations]: AssociationValue<Associations[K]>;
};

// --- Standalone association factory functions ---

export function hasMany<Target>(
	model: string,
	options?: { foreignKey?: string; as?: string },
): HasManyDef<Target>;
export function hasMany<Target extends AnyModelStatic>(
	model: () => Target,
	options?: { foreignKey?: string; as?: string },
): HasManyDef<InstanceType<Target>>;
export function hasMany(
	model: string | (() => AnyModelStatic),
	options?: { foreignKey?: string; as?: string },
): AssociationDefinition {
	return {
		associationType: "hasMany",
		...(typeof model === "string"
			? { modelName: model }
			: { model: model as () => AnyModelStatic }),
		foreignKey: options?.foreignKey,
		as: options?.as,
	} as AssociationDefinition;
}

export function hasOne<Target>(
	model: string,
	options?: { foreignKey?: string; as?: string },
): HasOneDef<Target>;
export function hasOne<Target extends AnyModelStatic>(
	model: () => Target,
	options?: { foreignKey?: string; as?: string },
): HasOneDef<InstanceType<Target>>;
export function hasOne(
	model: string | (() => AnyModelStatic),
	options?: { foreignKey?: string; as?: string },
): AssociationDefinition {
	return {
		associationType: "hasOne",
		...(typeof model === "string"
			? { modelName: model }
			: { model: model as () => AnyModelStatic }),
		foreignKey: options?.foreignKey,
		as: options?.as,
	} as AssociationDefinition;
}

export function belongsTo<Target>(
	model: string,
	options?: { foreignKey?: string },
): BelongsToDef<Target>;
export function belongsTo<Target extends AnyModelStatic>(
	model: () => Target,
	options?: { foreignKey?: string },
): BelongsToDef<InstanceType<Target>>;
export function belongsTo<Target = unknown>(options: {
	polymorphic: true;
}): PolymorphicBelongsToDef<Target>;
export function belongsTo(
	modelOrOptions: string | (() => AnyModelStatic) | { polymorphic: true },
	options?: { foreignKey?: string },
): AnyAssociationDef {
	if (typeof modelOrOptions === "string") {
		return {
			associationType: "belongsTo",
			modelName: modelOrOptions,
			foreignKey: options?.foreignKey,
		} as BelongsToDef<unknown>;
	}
	if (typeof modelOrOptions === "function") {
		return {
			associationType: "belongsTo",
			model: modelOrOptions,
			foreignKey: options?.foreignKey,
		} as BelongsToDef<unknown>;
	}
	return {
		associationType: "belongsTo",
		polymorphic: true,
	} as PolymorphicBelongsToDef;
}

export function hasManyThrough<Target>(
	model: string,
	options: { through: string; foreignKey?: string; source?: string },
): HasManyThroughDef<Target>;
export function hasManyThrough<Target extends AnyModelStatic>(
	model: () => Target,
	options: { through: string; foreignKey?: string; source?: string },
): HasManyThroughDef<InstanceType<Target>>;
export function hasManyThrough(
	model: string | (() => AnyModelStatic),
	options: { through: string; foreignKey?: string; source?: string },
): AssociationDefinition {
	return {
		associationType: "hasManyThrough",
		...(typeof model === "string"
			? { modelName: model }
			: { model: model as () => AnyModelStatic }),
		through: options.through,
		foreignKey: options.foreignKey,
		source: options.source,
	} as AssociationDefinition;
}

// --- Instance and static model interfaces ---

/** Instance methods available on all model records. Non-generic so TypeScript shows the name cleanly. */
export interface BaseModel {
	readonly isNewRecord: boolean;
	readonly errors: ValidationErrors;
	markPersisted(): void;
	assignAttributes(attributes: Record<string, unknown>): void;
	save(): Promise<void>;
	update(attributes: Record<string, unknown>): Promise<void>;
	destroy(): Promise<void>;
	discard(): Promise<void>;
	undiscard(): Promise<void>;
	readonly isDiscarded: boolean;
	readonly isKept: boolean;
	reload(): Promise<void>;
	lock(mode?: LockMode): Promise<void>;
	withLock<Result>(
		callback: (record: this) => Promise<Result>,
		mode?: LockMode,
	): Promise<Result>;
	isValid(): Promise<boolean>;
	changed(fieldName?: string): boolean;
	changedAttributes(): Record<string, { was: unknown; now: unknown }>;
	load<K extends keyof this>(name: K & string): Promise<this[K]>;
	toJSON(): Record<string, unknown>;
	serialize(options?: {
		only?: string[];
		except?: string[];
		include?: string[] | Record<string, unknown>;
	}): Record<string, unknown>;
}

/**
 * Static side of a Model class. Methods that return instances use a `this`
 * parameter so `User.find(id)` returns `Promise<User>`, not `Promise<Row & BaseModel>`.
 */
export interface ModelStatic<Row> {
	new (attributes?: Partial<Row>): Row & BaseModel;

	tableDefinition: TableDefinition<Row>;
	tableName: string;
	primaryKeyField: string;

	where<Self extends ModelStatic<Row>>(
		this: Self,
		conditions: WhereConditions<Row>,
	): QueryBuilder<InstanceType<Self>>;
	whereRaw<Self extends ModelStatic<Row>>(
		this: Self,
		fragment: string,
		values?: unknown[],
	): QueryBuilder<InstanceType<Self>>;
	order<Self extends ModelStatic<Row>>(
		this: Self,
		clause: Partial<Record<keyof Row & string, OrderDirection>>,
	): QueryBuilder<InstanceType<Self>>;
	limit<Self extends ModelStatic<Row>>(
		this: Self,
		count: number,
	): QueryBuilder<InstanceType<Self>>;
	all<Self extends ModelStatic<Row>>(
		this: Self,
	): QueryBuilder<InstanceType<Self>>;

	kept<Self extends ModelStatic<Row>>(
		this: Self,
	): QueryBuilder<InstanceType<Self>>;
	discarded<Self extends ModelStatic<Row>>(
		this: Self,
	): QueryBuilder<InstanceType<Self>>;

	find<Self extends ModelStatic<Row>>(
		this: Self,
		primaryKey: unknown,
	): Promise<InstanceType<Self>>;
	findBy<Self extends ModelStatic<Row>>(
		this: Self,
		conditions: WhereConditions<Row>,
	): Promise<InstanceType<Self> | null>;
	findBySql<Self extends ModelStatic<Row>>(
		this: Self,
		sqlText: string,
		values?: unknown[],
	): Promise<InstanceType<Self>[]>;
	first<Self extends ModelStatic<Row>>(
		this: Self,
	): Promise<InstanceType<Self> | null>;
	last<Self extends ModelStatic<Row>>(
		this: Self,
	): Promise<InstanceType<Self> | null>;
	count(): Promise<number>;
	exists(conditions?: WhereConditions<Row>): Promise<boolean>;

	create<Self extends ModelStatic<Row>>(
		this: Self,
		attributes: Partial<Row>,
		options?: InsertOptions<Row>,
	): Promise<InstanceType<Self>>;
	createMany<Self extends ModelStatic<Row>>(
		this: Self,
		records: Partial<Row>[],
		options?: InsertOptions<Row>,
	): Promise<InstanceType<Self>[]>;
	upsert<Self extends ModelStatic<Row>>(
		this: Self,
		attributes: Partial<Row>,
		options: Required<InsertOptions<Row>>,
	): Promise<InstanceType<Self>>;
	upsertAll<Self extends ModelStatic<Row>>(
		this: Self,
		records: Partial<Row>[],
		options: Required<InsertOptions<Row>>,
	): Promise<InstanceType<Self>[]>;

	hasMany(
		model: () => AnyModelStatic,
		options?: { foreignKey?: string; as?: string },
	): AssociationDefinition;
	hasOne(
		model: () => AnyModelStatic,
		options?: { foreignKey?: string; as?: string },
	): AssociationDefinition;
	belongsTo(
		modelOrOptions: (() => AnyModelStatic) | { polymorphic: true },
		options?: { foreignKey?: string },
	): AssociationDefinition;
	hasManyThrough(
		model: () => AnyModelStatic,
		options: { through: string; foreignKey?: string; source?: string },
	): AssociationDefinition;
}

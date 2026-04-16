// Built-in plugins — self-register on import (must come before Model is used)
import "./plugins/recursive-cte";
import "./plugins/locking";
import "./plugins/soft-delete";
import "./plugins/batch-iteration";

export { defineConfig } from "./config";
export { Model } from "./model/base";
export type { CallbackFunction, CallbackHook } from "./model/callbacks";
export type {
	ConnectOptions,
	QueryLogEntry,
	QueryLogger,
} from "./model/connection";
export {
	connect,
	disconnect,
	isInTransaction,
	query,
	transaction,
} from "./model/connection";
export { ValidationError, ValidationErrors } from "./model/errors";
export { QueryBuilder } from "./model/query";
export type { SerializeOptions } from "./model/serializer";
export { serialize } from "./model/serializer";
export { Snapshot } from "./model/snapshot";
export type {
	AssociationDefinition,
	BaseModel,
	ConflictOption,
	ConflictTarget,
	InsertOptions,
	IsolationLevel,
	LockMode,
	ModelStatic,
	OrderDirection,
	TransactionOptions,
} from "./model/types";
export {
	belongsTo,
	hasMany,
	hasManyThrough,
	hasOne,
	RecordNotFoundError,
} from "./model/types";
export type {
	CustomValidation,
	ValidationConfig,
	ValidationRule,
} from "./model/validations";
export { defineValidator, validate, validates } from "./model/validations";
export type {
	SubqueryDescriptor,
	WhereConditions,
	WhereOperators,
	WhereValue,
} from "./model/where";
export { SUBQUERY } from "./model/where";
export type { ModelPlugin } from "./plugins";
export { definePlugin } from "./plugins";
export type {
	BakedConfig,
	ColumnDefinition,
	ForeignKeyDefinition,
	IndexDefinition,
	Migration,
	ResolvedConfig,
	SchemaDefinition,
	TableDefinition,
} from "./types";

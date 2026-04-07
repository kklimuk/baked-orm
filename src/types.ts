export type ColumnDefinition = {
	type: string;
	nullable: boolean;
	default?: string;
	columnName: string;
	enumValues?: readonly string[];
};

export type IndexDefinition = {
	columns: string[];
	unique?: boolean;
};

export type ForeignKeyDefinition = {
	columns: string[];
	references: { table: string; columns: string[] };
};

export type TableDefinition<Row = unknown> = {
	tableName: string;
	columns: Record<string, ColumnDefinition>;
	primaryKey: string[];
	indexes: Record<string, IndexDefinition>;
	foreignKeys: Record<string, ForeignKeyDefinition>;
	rowClass: new () => Row;
};

export type SchemaDefinition = {
	version: string;
	tables: Record<string, TableDefinition>;
};

export type DatabaseConfig = {
	url?: string;
	hostname?: string;
	port?: number | string;
	username?: string;
	password?: string;
	database?: string;
	/** Maximum number of connections in the pool (default: 10) */
	max?: number;
	/** Seconds before closing an idle connection (default: 0, no timeout) */
	idleTimeout?: number;
	/** Maximum lifetime of a connection in seconds (default: 0, no limit) */
	maxLifetime?: number;
	/** Seconds to wait when establishing a connection (default: 30) */
	connectionTimeout?: number;
};

export type BakedConfig = {
	migrationsPath?: string;
	schemaPath?: string;
	modelsPath?: string;
	frontendModelsPath?: string;
	database?: string | DatabaseConfig;
};

export type ResolvedConfig = {
	migrationsPath: string;
	schemaPath: string;
	modelsPath: string;
	frontendModelsPath: string;
	database?: string | DatabaseConfig;
};

export const DEFAULT_CONFIG: ResolvedConfig = {
	migrationsPath: "./db/migrations",
	schemaPath: "./db/schema.ts",
	modelsPath: "./models",
	frontendModelsPath: "./frontend/models",
};

export type Migration = {
	version: string;
	name: string;
	file: string;
};

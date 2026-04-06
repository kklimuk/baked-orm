export type ColumnDefinition = {
	type: string;
	nullable: boolean;
	default?: string;
	columnName: string;
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
};

export type BakedConfig = {
	migrationsPath?: string;
	schemaPath?: string;
	database?: string | DatabaseConfig;
};

export type ResolvedConfig = {
	migrationsPath: string;
	schemaPath: string;
	database?: string | DatabaseConfig;
};

export const DEFAULT_CONFIG: ResolvedConfig = {
	migrationsPath: "./db/migrations",
	schemaPath: "./db/schema.ts",
};

export type Migration = {
	version: string;
	name: string;
	file: string;
};

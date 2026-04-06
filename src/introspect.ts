import type { SQL } from "bun";
import { resolve } from "path";

import type { ResolvedConfig } from "./types";

const PG_TYPE_MAP: Record<string, string> = {
	uuid: "string",
	text: "string",
	"character varying": "string",
	character: "string",
	varchar: "string",
	char: "string",
	integer: "number",
	int: "number",
	int4: "number",
	smallint: "number",
	int2: "number",
	serial: "number",
	bigint: "bigint",
	int8: "bigint",
	bigserial: "bigint",
	boolean: "boolean",
	bool: "boolean",
	"timestamp with time zone": "Date",
	"timestamp without time zone": "Date",
	timestamptz: "Date",
	timestamp: "Date",
	date: "Date",
	json: "unknown",
	jsonb: "unknown",
	numeric: "string",
	decimal: "string",
	real: "number",
	float4: "number",
	"double precision": "number",
	float8: "number",
	bytea: "Uint8Array",
};

type IntrospectedColumn = {
	table_name: string;
	column_name: string;
	data_type: string;
	udt_name: string;
	is_nullable: string;
	column_default: string | null;
	character_maximum_length: number | null;
};

type IntrospectedConstraint = {
	table_name: string;
	column_name: string;
	constraint_type: string;
	constraint_name: string;
};

type IntrospectedForeignKey = {
	table_name: string;
	column_name: string;
	constraint_name: string;
	foreign_table_name: string;
	foreign_column_name: string;
};

type IntrospectedIndex = {
	tablename: string;
	indexname: string;
	indexdef: string;
};

type CompositeField = {
	type_name: string;
	attribute_name: string;
	attribute_type: string;
};

type CompositeType = {
	name: string;
	fields: { name: string; tsType: string }[];
};

async function introspectCompositeTypes(
	connection: SQL,
): Promise<CompositeType[]> {
	const fields: CompositeField[] = await connection`
		SELECT
			t.typname AS type_name,
			a.attname AS attribute_name,
			pg_catalog.format_type(a.atttypid, a.atttypmod) AS attribute_type
		FROM pg_catalog.pg_type t
		JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
		JOIN pg_catalog.pg_attribute a ON a.attrelid = t.typrelid
		WHERE t.typtype = 'c'
			AND n.nspname = 'public'
			AND a.attnum > 0
			AND NOT a.attisdropped
		ORDER BY t.typname, a.attnum
	`;

	const typeMap = new Map<string, CompositeType>();
	for (const field of fields) {
		let composite = typeMap.get(field.type_name);
		if (!composite) {
			composite = { name: field.type_name, fields: [] };
			typeMap.set(field.type_name, composite);
		}
		composite.fields.push({
			name: field.attribute_name,
			tsType: mapPgType(field.attribute_type),
		});
	}

	return [...typeMap.values()];
}

export function mapPgType(
	pgType: string,
	compositeNames?: Set<string>,
): string {
	if (pgType.endsWith("[]")) {
		const baseType = pgType.slice(0, -2);
		return `${mapPgType(baseType, compositeNames)}[]`;
	}

	if (pgType.startsWith("ARRAY")) {
		return "unknown[]";
	}

	if (compositeNames?.has(pgType)) {
		return `${toPascalCase(pgType)}Composite`;
	}

	if (PG_TYPE_MAP[pgType]) {
		return PG_TYPE_MAP[pgType];
	}

	const baseType = pgType.replace(/\(.+\)/, "").trim();
	if (PG_TYPE_MAP[baseType]) {
		return PG_TYPE_MAP[baseType];
	}

	return "unknown";
}

export function toPascalCase(input: string): string {
	return input
		.split("_")
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join("");
}

export function toCamelCase(input: string): string {
	const parts = input.split("_");
	const first = parts[0] ?? "";
	return (
		first +
		parts
			.slice(1)
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join("")
	);
}

async function introspectTables(connection: SQL): Promise<string[]> {
	const rows: { table_name: string }[] = await connection`
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = 'public'
			AND table_type = 'BASE TABLE'
			AND table_name != 'schema_migrations'
		ORDER BY table_name
	`;
	return rows.map((row) => row.table_name);
}

async function introspectColumns(
	connection: SQL,
	tables: string[],
): Promise<IntrospectedColumn[]> {
	if (tables.length === 0) return [];
	return await connection`
		SELECT table_name, column_name, data_type, udt_name,
			   is_nullable, column_default, character_maximum_length
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = ANY(${connection.array(tables, "text")})
		ORDER BY table_name, ordinal_position
	`;
}

async function introspectConstraints(
	connection: SQL,
	tables: string[],
): Promise<{ pks: IntrospectedConstraint[]; fks: IntrospectedForeignKey[] }> {
	if (tables.length === 0) return { pks: [], fks: [] };

	const pks: IntrospectedConstraint[] = await connection`
		SELECT tc.table_name, kcu.column_name, tc.constraint_type, tc.constraint_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name
			AND tc.table_schema = kcu.table_schema
		WHERE tc.constraint_type = 'PRIMARY KEY'
			AND tc.table_schema = 'public'
			AND tc.table_name = ANY(${connection.array(tables, "text")})
		ORDER BY tc.table_name, kcu.ordinal_position
	`;

	const fks: IntrospectedForeignKey[] = await connection`
		SELECT
			tc.table_name,
			kcu.column_name,
			tc.constraint_name,
			ccu.table_name AS foreign_table_name,
			ccu.column_name AS foreign_column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name
			AND tc.table_schema = kcu.table_schema
		JOIN information_schema.constraint_column_usage ccu
			ON tc.constraint_name = ccu.constraint_name
			AND tc.table_schema = ccu.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY'
			AND tc.table_schema = 'public'
			AND tc.table_name = ANY(${connection.array(tables, "text")})
		ORDER BY tc.table_name, tc.constraint_name
	`;

	return { pks, fks };
}

async function introspectIndexes(
	connection: SQL,
	tables: string[],
): Promise<IntrospectedIndex[]> {
	if (tables.length === 0) return [];
	return await connection`
		SELECT tablename, indexname, indexdef
		FROM pg_indexes
		WHERE schemaname = 'public'
			AND tablename = ANY(${connection.array(tables, "text")})
		ORDER BY tablename, indexname
	`;
}

export function parseIndexColumns(indexdef: string): {
	columns: string[];
	unique: boolean;
} {
	const unique = indexdef.toUpperCase().includes("UNIQUE");
	const match = indexdef.match(/\((.+)\)/);
	const columns = match?.[1]
		? match[1].split(",").map((col) => col.trim().replace(/"/g, ""))
		: [];
	return { columns, unique };
}

export async function generateSchema(
	connection: SQL,
	config: ResolvedConfig,
	version: string | undefined,
) {
	const [tables, compositeTypes] = await Promise.all([
		introspectTables(connection),
		introspectCompositeTypes(connection),
	]);

	const compositeNames = new Set(
		compositeTypes.map((composite) => composite.name),
	);

	const [columns, { pks, fks }, indexes] = await Promise.all([
		introspectColumns(connection, tables),
		introspectConstraints(connection, tables),
		introspectIndexes(connection, tables),
	]);

	const columnsByTable = groupBy(columns, "table_name");
	const pksByTable = groupBy(pks, "table_name");
	const fksByTable = groupBy(fks, "table_name");
	const indexesByTable = groupBy(indexes, "tablename");

	const pkConstraintNames = new Set(
		pks.map((constraint) => constraint.constraint_name),
	);

	const lines: string[] = [];
	lines.push(
		"// Auto-generated by baked-orm — do not edit manually.",
		`// Run \`bun db migrate up\` to regenerate.`,
		`import type { TableDefinition, SchemaDefinition } from "baked-orm";`,
		"",
	);

	if (compositeTypes.length > 0) {
		lines.push("// --- Composite Types ---", "");
		for (const composite of compositeTypes) {
			const className = `${toPascalCase(composite.name)}Composite`;
			lines.push(`export class ${className} {`);
			for (const field of composite.fields) {
				lines.push(`\tdeclare ${field.name}: ${field.tsType};`);
			}
			lines.push("}", "");
		}
	}

	const tableNames: string[] = [];
	for (const tableName of tables) {
		const tableCols = columnsByTable[tableName] ?? [];
		const tablePks = (pksByTable[tableName] ?? []).map(
			(constraint) => constraint.column_name,
		);
		const tableFks = fksByTable[tableName] ?? [];
		const tableIdxs = (indexesByTable[tableName] ?? []).filter(
			(idx) => !pkConstraintNames.has(idx.indexname),
		);

		const rowClassName = `${toPascalCase(tableName)}Row`;
		tableNames.push(tableName);

		lines.push(`// --- Table: ${tableName} ---`, "");
		lines.push(`export class ${rowClassName} {`);
		for (const col of tableCols) {
			const tsType = mapPgType(col.data_type, compositeNames);
			const nullable = col.is_nullable === "YES" ? " | null" : "";
			const camelName = toCamelCase(col.column_name);
			lines.push(`\tdeclare ${camelName}: ${tsType}${nullable};`);
		}
		lines.push("}", "");

		lines.push(
			`export const ${tableName}: TableDefinition<${rowClassName}> = {`,
		);
		lines.push(`\ttableName: ${JSON.stringify(tableName)},`);

		lines.push("\tcolumns: {");
		for (const col of tableCols) {
			const colType = col.character_maximum_length
				? `${col.data_type}(${col.character_maximum_length})`
				: col.data_type;
			const nullable = col.is_nullable === "YES";
			const defaultStr = col.column_default
				? `, default: ${JSON.stringify(col.column_default)}`
				: "";
			const camelName = toCamelCase(col.column_name);
			lines.push(
				`\t\t${camelName}: { type: ${JSON.stringify(colType)}, nullable: ${nullable}${defaultStr}, columnName: ${JSON.stringify(col.column_name)} },`,
			);
		}
		lines.push("\t},");

		lines.push(
			`\tprimaryKey: [${tablePks.map((key) => JSON.stringify(toCamelCase(key))).join(", ")}],`,
		);

		lines.push("\tindexes: {");
		for (const idx of tableIdxs) {
			const parsed = parseIndexColumns(idx.indexdef);
			const uniqueStr = parsed.unique ? ", unique: true" : "";
			lines.push(
				`\t\t${idx.indexname}: { columns: [${parsed.columns.map((col) => JSON.stringify(col)).join(", ")}]${uniqueStr} },`,
			);
		}
		lines.push("\t},");

		lines.push("\tforeignKeys: {");
		const fksByConstraint = new Map<
			string,
			{ columns: string[]; foreignTable: string; foreignColumns: string[] }
		>();
		for (const foreignKey of tableFks) {
			let entry = fksByConstraint.get(foreignKey.constraint_name);
			if (!entry) {
				entry = {
					columns: [],
					foreignTable: foreignKey.foreign_table_name,
					foreignColumns: [],
				};
				fksByConstraint.set(foreignKey.constraint_name, entry);
			}
			entry.columns.push(toCamelCase(foreignKey.column_name));
			entry.foreignColumns.push(toCamelCase(foreignKey.foreign_column_name));
		}
		for (const [constraintName, foreignKey] of fksByConstraint) {
			lines.push(
				`\t\t${constraintName}: { columns: [${foreignKey.columns.map((col) => JSON.stringify(col)).join(", ")}], references: { table: ${JSON.stringify(foreignKey.foreignTable)}, columns: [${foreignKey.foreignColumns.map((col) => JSON.stringify(col)).join(", ")}] } },`,
			);
		}
		lines.push("\t},");

		lines.push(`\trowClass: ${rowClassName},`);
		lines.push("};", "");
	}

	lines.push("// --- Schema ---", "");
	lines.push("const schema: SchemaDefinition = {");
	lines.push(`\tversion: ${JSON.stringify(version ?? "none")},`);
	lines.push(`\ttables: { ${tableNames.join(", ")} },`);
	lines.push("};", "");
	lines.push("export default schema;", "");

	const schemaPath = resolve(process.cwd(), config.schemaPath);
	await Bun.write(schemaPath, lines.join("\n"));

	const rel = schemaPath.replace(`${process.cwd()}/`, "");
	console.log(`\x1b[32mGenerated\x1b[0m ${rel}`);
}

export function groupBy<T>(arr: T[], key: string): Record<string, T[]> {
	const result: Record<string, T[]> = {};
	for (const item of arr) {
		const groupKey = (item as Record<string, unknown>)[key] as string;
		if (!result[groupKey]) result[groupKey] = [];
		result[groupKey].push(item);
	}
	return result;
}

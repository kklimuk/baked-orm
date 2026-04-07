import { Temporal } from "@js-temporal/polyfill";
import { mkdir } from "fs/promises";
import { relative, resolve } from "path";

import type { ResolvedConfig } from "../types";

const ENUM_PREFIX = /^create_enum_/;
const SOFT_DELETE_PREFIX = /^soft_delete_/;

const TABLE_PREFIXES = {
	create: /^create_/,
	alter: /^(update_|alter_)/,
	drop: /^(delete_|drop_)/,
};

export function extractTableName(migrationName: string): string | null {
	if (ENUM_PREFIX.test(migrationName)) return null;
	if (SOFT_DELETE_PREFIX.test(migrationName)) return null;
	for (const pattern of Object.values(TABLE_PREFIXES)) {
		if (pattern.test(migrationName)) {
			return migrationName.replace(pattern, "");
		}
	}
	return null;
}

export function extractEnumName(migrationName: string): string | null {
	if (ENUM_PREFIX.test(migrationName)) {
		return migrationName.replace(ENUM_PREFIX, "");
	}
	return null;
}

export function extractSoftDeleteTableName(
	migrationName: string,
): string | null {
	if (SOFT_DELETE_PREFIX.test(migrationName)) {
		return migrationName.replace(SOFT_DELETE_PREFIX, "");
	}
	return null;
}

export function buildTemplate(migrationName: string): string {
	const softDeleteTable = extractSoftDeleteTableName(migrationName);

	if (softDeleteTable) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`ALTER TABLE ${softDeleteTable} ADD COLUMN discarded_at timestamptz\`;
\tawait txn\`CREATE INDEX idx_${softDeleteTable}_discarded_at ON ${softDeleteTable} (discarded_at) WHERE discarded_at IS NULL\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`DROP INDEX IF EXISTS idx_${softDeleteTable}_discarded_at\`;
\tawait txn\`ALTER TABLE ${softDeleteTable} DROP COLUMN discarded_at\`;
}
`;
	}

	const enumName = extractEnumName(migrationName);

	if (enumName) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`CREATE TYPE ${enumName} AS ENUM ('value1', 'value2')\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`DROP TYPE ${enumName}\`;
}
`;
	}

	const tableName = extractTableName(migrationName);

	if (tableName && TABLE_PREFIXES.create.test(migrationName)) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`
\t\tCREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
\t\tBEGIN
\t\t\tNEW.updated_at = now();
\t\t\tRETURN NEW;
\t\tEND;
\t\t$$ LANGUAGE plpgsql
\t\`;

\tawait txn\`
\t\tCREATE TABLE ${tableName} (
\t\t\tid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
\t\t\tcreated_at timestamptz NOT NULL DEFAULT now(),
\t\t\tupdated_at timestamptz NOT NULL DEFAULT now()
\t\t)
\t\`;

\tawait txn\`
\t\tCREATE TRIGGER trg_${tableName}_updated_at
\t\tBEFORE UPDATE ON ${tableName}
\t\tFOR EACH ROW EXECUTE FUNCTION set_updated_at()
\t\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`DROP TRIGGER IF EXISTS trg_${tableName}_updated_at ON ${tableName}\`;
\tawait txn\`DROP TABLE ${tableName}\`;
}
`;
	}

	if (tableName && TABLE_PREFIXES.alter.test(migrationName)) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`ALTER TABLE ${tableName} ADD COLUMN column_name text\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`ALTER TABLE ${tableName} DROP COLUMN column_name\`;
}
`;
	}

	if (tableName && TABLE_PREFIXES.drop.test(migrationName)) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`DROP TABLE ${tableName}\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`
\t\tCREATE TABLE ${tableName} (
\t\t\t-- Recreate the table schema here
\t\t)
\t\`;
}
`;
	}

	return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\t// Write your migration here
}

export async function down(txn: TransactionSQL) {
\t// Write your rollback here
}
`;
}

export function formatTimestamp(instant: Temporal.Instant): string {
	const dateTime = instant.toZonedDateTimeISO("UTC");
	const year = String(dateTime.year).padStart(4, "0");
	const month = String(dateTime.month).padStart(2, "0");
	const day = String(dateTime.day).padStart(2, "0");
	const hour = String(dateTime.hour).padStart(2, "0");
	const minute = String(dateTime.minute).padStart(2, "0");
	const second = String(dateTime.second).padStart(2, "0");
	return `${year}${month}${day}${hour}${minute}${second}`;
}

export async function runGenerate(config: ResolvedConfig, args: string[]) {
	const name = args[0];
	if (!name) {
		console.error("Usage: bun db generate <migration_name>");
		process.exit(1);
	}

	const migrationsDir = resolve(process.cwd(), config.migrationsPath);
	await mkdir(migrationsDir, { recursive: true });

	const timestamp = formatTimestamp(Temporal.Now.instant());
	const filename = `${timestamp}.${name}.ts`;
	const filePath = `${migrationsDir}/${filename}`;

	await Bun.write(filePath, buildTemplate(name));

	const rel = relative(process.cwd(), filePath);
	console.log(`\x1b[32mCreated\x1b[0m ${rel}`);
}

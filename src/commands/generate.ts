import { Temporal } from "@js-temporal/polyfill";
import { mkdir } from "fs/promises";
import { relative, resolve } from "path";

import type { ResolvedConfig } from "../types";

const PREFIXES = {
	create: /^create_/,
	alter: /^(update_|alter_)/,
	drop: /^(delete_|drop_)/,
};

function extractTableName(migrationName: string): string | null {
	for (const pattern of Object.values(PREFIXES)) {
		if (pattern.test(migrationName)) {
			return migrationName.replace(pattern, "");
		}
	}
	return null;
}

function buildTemplate(migrationName: string): string {
	const tableName = extractTableName(migrationName);

	if (tableName && PREFIXES.create.test(migrationName)) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`
\t\tCREATE TABLE ${tableName} (
\t\t\tid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
\t\t\tcreated_at timestamptz NOT NULL DEFAULT now(),
\t\t\tupdated_at timestamptz NOT NULL DEFAULT now()
\t\t)
\t\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`DROP TABLE ${tableName}\`;
}
`;
	}

	if (tableName && PREFIXES.alter.test(migrationName)) {
		return `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
\tawait txn\`ALTER TABLE ${tableName} ADD COLUMN column_name text\`;
}

export async function down(txn: TransactionSQL) {
\tawait txn\`ALTER TABLE ${tableName} DROP COLUMN column_name\`;
}
`;
	}

	if (tableName && PREFIXES.drop.test(migrationName)) {
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

function formatTimestamp(instant: Temporal.Instant): string {
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

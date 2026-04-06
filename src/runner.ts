import { Glob, type SQL } from "bun";
import { resolve } from "path";

import type { Migration, ResolvedConfig } from "./types";

const LOCK_ID = 7_265_389;

export async function ensureMigrationsTable(connection: SQL) {
	await connection`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version VARCHAR(255) NOT NULL PRIMARY KEY
		)
	`;
}

async function acquireLock(connection: SQL) {
	await connection`SELECT pg_advisory_lock(${LOCK_ID})`;
}

async function releaseLock(connection: SQL) {
	await connection`SELECT pg_advisory_unlock(${LOCK_ID})`;
}

export async function discoverMigrations(
	config: ResolvedConfig,
): Promise<Migration[]> {
	const migrationsDir = resolve(process.cwd(), config.migrationsPath);
	const glob = new Glob("*.ts");
	const migrations: Migration[] = [];

	for await (const file of glob.scan(migrationsDir)) {
		const [version, ...nameParts] = file.replace(/\.ts$/, "").split(".");
		if (!version) continue;
		const name = nameParts.join(".");
		migrations.push({ version, name, file });
	}

	migrations.sort((first, second) =>
		first.version.localeCompare(second.version),
	);

	const duplicates = findDuplicateVersions(migrations);
	if (duplicates.length > 0) {
		for (const { version, files } of duplicates) {
			console.error(
				`\x1b[31mConflict\x1b[0m Multiple migrations share timestamp ${version}:`,
			);
			for (const file of files) {
				console.error(`  - ${file}`);
			}
		}
		throw new Error(
			"Migration timestamp conflict detected. Rename one of the conflicting migrations to resolve.",
		);
	}

	return migrations;
}

export async function getAppliedVersions(
	connection: SQL,
): Promise<Set<string>> {
	const rows: { version: string }[] =
		await connection`SELECT version FROM schema_migrations ORDER BY version ASC`;
	return new Set(rows.map((row) => row.version));
}

type MigrationResult = {
	applied: number;
	version: string | undefined;
};

export async function migrateUp(
	connection: SQL,
	config: ResolvedConfig,
	count: number | null,
): Promise<MigrationResult> {
	await ensureMigrationsTable(connection);
	await acquireLock(connection);

	try {
		const migrations = await discoverMigrations(config);
		const applied = await getAppliedVersions(connection);
		let pending = migrations.filter(
			(migration) => !applied.has(migration.version),
		);

		if (pending.length === 0) {
			console.log("\x1b[32mNo pending migrations.\x1b[0m");
			return { applied: 0, version: lastApplied(applied) };
		}

		if (count != null) {
			pending = pending.slice(0, count);
		}

		console.log(`\x1b[33mRunning ${pending.length} migration(s) up\x1b[0m`);

		const migrationsDir = resolve(process.cwd(), config.migrationsPath);

		await connection.begin(async (txn) => {
			for (const migration of pending) {
				const mod = await import(`${migrationsDir}/${migration.file}`);
				if (typeof mod.up !== "function") {
					throw new Error(
						`Migration ${migration.file} does not export an 'up' function`,
					);
				}
				await mod.up(txn);
				await txn`INSERT INTO schema_migrations (version) VALUES (${migration.version})`;
				console.log(`\x1b[34mApplied\x1b[0m ${migration.file}`);
			}
		});

		return {
			applied: pending.length,
			version: pending.at(-1)?.version,
		};
	} finally {
		await releaseLock(connection);
	}
}

export async function migrateDown(
	connection: SQL,
	config: ResolvedConfig,
	count: number,
): Promise<MigrationResult> {
	await ensureMigrationsTable(connection);
	await acquireLock(connection);

	try {
		const migrations = await discoverMigrations(config);
		const applied = await getAppliedVersions(connection);
		const appliedList = [...applied].sort();

		const toRollback: Migration[] = [];
		for (let index = 1; index <= count; index++) {
			const version = appliedList.at(-index);
			if (!version) break;

			const migration = migrations.find(
				(candidate) => candidate.version === version,
			);
			if (!migration) {
				throw new Error(
					`Cannot rollback version ${version}: migration file not found`,
				);
			}
			toRollback.push(migration);
		}

		if (toRollback.length === 0) {
			console.log("\x1b[32mNo migrations to rollback.\x1b[0m");
			return { applied: 0, version: undefined };
		}

		console.log(
			`\x1b[33mRolling back ${toRollback.length} migration(s)\x1b[0m`,
		);

		const migrationsDir = resolve(process.cwd(), config.migrationsPath);

		await connection.begin(async (txn) => {
			for (const migration of toRollback) {
				const mod = await import(`${migrationsDir}/${migration.file}`);
				if (typeof mod.down !== "function") {
					throw new Error(
						`Migration ${migration.file} does not export a 'down' function`,
					);
				}
				await mod.down(txn);
				await txn`DELETE FROM schema_migrations WHERE version = ${migration.version}`;
				console.log(`\x1b[34mRolled back\x1b[0m ${migration.file}`);
			}
		});

		const remainingApplied = appliedList.filter(
			(ver) => !toRollback.some((migration) => migration.version === ver),
		);
		return {
			applied: toRollback.length,
			version: remainingApplied.at(-1),
		};
	} finally {
		await releaseLock(connection);
	}
}

function lastApplied(applied: Set<string>): string | undefined {
	return [...applied].sort().at(-1);
}

function findDuplicateVersions(
	migrations: Migration[],
): { version: string; files: string[] }[] {
	const byVersion = new Map<string, string[]>();
	for (const migration of migrations) {
		const existing = byVersion.get(migration.version) ?? [];
		existing.push(migration.file);
		byVersion.set(migration.version, existing);
	}
	const duplicates: { version: string; files: string[] }[] = [];
	for (const [version, files] of byVersion) {
		if (files.length > 1) {
			duplicates.push({ version, files });
		}
	}
	return duplicates;
}

import { getConnection } from "../config";
import {
	discoverMigrations,
	ensureMigrationsTable,
	getAppliedVersions,
} from "../runner";
import type { ResolvedConfig } from "../types";

export async function runStatus(config: ResolvedConfig) {
	const connection = getConnection(config);
	try {
		await ensureMigrationsTable(connection);

		const migrations = await discoverMigrations(config);
		const applied = await getAppliedVersions(connection);

		if (migrations.length === 0) {
			console.log("No migrations found.");
			return;
		}

		console.log("Migration status:\n");
		for (const migration of migrations) {
			const isApplied = applied.has(migration.version);
			const icon = isApplied ? "\x1b[32m✓\x1b[0m" : "\x1b[33m○\x1b[0m";
			const label = isApplied ? "applied" : "pending";
			console.log(
				`  ${icon} ${migration.version} ${migration.name} (${label})`,
			);
		}

		const pendingCount = migrations.filter(
			(migration) => !applied.has(migration.version),
		).length;
		console.log(`\n${applied.size} applied, ${pendingCount} pending`);
	} finally {
		await connection.close();
	}
}

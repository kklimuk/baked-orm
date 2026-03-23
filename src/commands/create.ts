import { getMaintenanceConnection } from "../config";
import type { ResolvedConfig } from "../types";

function escapeIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export async function runCreate(config: ResolvedConfig, args: string[]) {
	const databaseName = args[0];
	if (!databaseName) {
		console.error("Usage: bun db create <database_name>");
		process.exit(1);
	}

	const connection = getMaintenanceConnection(config);
	try {
		await connection.unsafe(
			`CREATE DATABASE ${escapeIdentifier(databaseName)}`,
		);
		console.log(`\x1b[32mCreated\x1b[0m database ${databaseName}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) {
			console.log(`\x1b[33mDatabase ${databaseName} already exists.\x1b[0m`);
		} else {
			throw error;
		}
	} finally {
		await connection.close();
	}
}

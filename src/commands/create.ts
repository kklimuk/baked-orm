import { getMaintenanceConnection } from "../config";
import { quoteIdentifier } from "../model/utils";
import type { ResolvedConfig } from "../types";

export async function runCreate(config: ResolvedConfig, args: string[]) {
	const databaseName = args[0];
	if (!databaseName) {
		console.error("Usage: bun db create <database_name>");
		process.exit(1);
	}

	const connection = getMaintenanceConnection(config);
	try {
		await connection.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
		console.log(`\x1b[32mCreated\x1b[0m database ${databaseName}`);
	} catch (error) {
		const pgError = error as Record<string, unknown>;
		if (pgError?.errno === "42P04") {
			console.log(`\x1b[33mDatabase ${databaseName} already exists.\x1b[0m`);
		} else {
			throw error;
		}
	} finally {
		await connection.close();
	}
}

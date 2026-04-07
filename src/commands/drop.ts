import { getMaintenanceConnection } from "../config";
import { quoteIdentifier } from "../model/utils";
import type { ResolvedConfig } from "../types";

export async function runDrop(config: ResolvedConfig, args: string[]) {
	const databaseName = args[0];
	if (!databaseName) {
		console.error("Usage: bun db drop <database_name>");
		process.exit(1);
	}

	const connection = getMaintenanceConnection(config);
	try {
		await connection.unsafe(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
		console.log(`\x1b[32mDropped\x1b[0m database ${databaseName}`);
	} catch (error) {
		const pgError = error as Record<string, unknown>;
		if (pgError?.errno === "3D000") {
			console.log(`\x1b[33mDatabase ${databaseName} does not exist.\x1b[0m`);
		} else {
			throw error;
		}
	} finally {
		await connection.close();
	}
}

import { getMaintenanceConnection } from "../config";
import type { ResolvedConfig } from "../types";

function escapeIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

export async function runDrop(config: ResolvedConfig, args: string[]) {
	const databaseName = args[0];
	if (!databaseName) {
		console.error("Usage: bun db drop <database_name>");
		process.exit(1);
	}

	const connection = getMaintenanceConnection(config);
	try {
		await connection.unsafe(`DROP DATABASE ${escapeIdentifier(databaseName)}`);
		console.log(`\x1b[32mDropped\x1b[0m database ${databaseName}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("does not exist")) {
			console.log(`\x1b[33mDatabase ${databaseName} does not exist.\x1b[0m`);
		} else {
			throw error;
		}
	} finally {
		await connection.close();
	}
}

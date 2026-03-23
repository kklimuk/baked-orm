import { parseArgs } from "util";

import { getConnection } from "../config";
import { generateSchema } from "../introspect";
import { migrateDown, migrateUp } from "../runner";
import type { ResolvedConfig } from "../types";

export async function runMigrate(config: ResolvedConfig, args: string[]) {
	const direction = args[0];
	if (direction !== "up" && direction !== "down") {
		console.error("Usage: bun db migrate <up|down> [--count=N]");
		process.exit(1);
	}

	const { values } = parseArgs({
		args: ["_", "_", ...args],
		options: {
			count: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	});

	let count: number | null = null;
	if (typeof values.count === "string") {
		const parsed = Number.parseInt(values.count, 10);
		if (!Number.isNaN(parsed)) {
			count = parsed;
		}
	}

	const connection = getConnection(config);
	try {
		const result =
			direction === "up"
				? await migrateUp(connection, config, count)
				: await migrateDown(connection, config, count ?? 1);

		await generateSchema(connection, config, result.version);

		console.log(`\x1b[32mMigrated ${result.applied} version(s)\x1b[0m`);
	} finally {
		await connection.close();
	}
}

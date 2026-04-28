import { createInterface } from "readline";
import { getConfiguredDatabaseName, getMaintenanceConnection } from "../config";
import { quoteIdentifier } from "../model/utils";
import type { ResolvedConfig } from "../types";

export async function runDrop(config: ResolvedConfig, args: string[]) {
	const positional: string[] = [];
	let skipConfirmation = false;
	for (const arg of args) {
		if (arg === "--yes" || arg === "-y") {
			skipConfirmation = true;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	const explicitName = positional[0];
	const databaseName = explicitName ?? getConfiguredDatabaseName(config);

	if (!databaseName) {
		console.error("Usage: bun db drop <database_name>");
		process.exit(1);
	}

	// When the name is defaulted (from baked.config.ts or env), require an
	// explicit type-to-confirm before dropping. `--yes` skips the prompt.
	// Explicit names on the command line still drop without prompting — the
	// user opted in by typing the name once.
	const isDefaulted = explicitName === undefined;
	if (isDefaulted && !skipConfirmation) {
		const confirmed = await typeToConfirm(databaseName);
		if (!confirmed) {
			console.error(
				"\x1b[31mAborted:\x1b[0m database name did not match. Pass the name explicitly or use --yes to skip the confirmation.",
			);
			process.exit(1);
		}
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

async function typeToConfirm(databaseName: string): Promise<boolean> {
	process.stdout.write(
		`\x1b[33mAbout to DROP database "${databaseName}" (resolved from configuration/environment).\x1b[0m\n`,
	);
	const reader = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const answer = await new Promise<string>((resolve) => {
		reader.question(
			`Type the database name to confirm (or anything else to abort): `,
			(line) => {
				reader.close();
				resolve(line);
			},
		);
	});
	return answer.trim() === databaseName;
}

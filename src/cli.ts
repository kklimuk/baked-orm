#!/usr/bin/env bun

import { parseArgs } from "util";

import { runGenerate } from "./commands/generate";
import { runInit } from "./commands/init";
import { runMigrate } from "./commands/migrate";
import { runStatus } from "./commands/status";
import { resolveConfig } from "./config";

const COMMANDS = ["init", "generate", "migrate", "status"] as const;
type CommandName = (typeof COMMANDS)[number];

function parseCommand(): { command: CommandName; rest: string[] } {
	const { positionals } = parseArgs({
		args: Bun.argv,
		allowPositionals: true,
		strict: false,
	});

	// Skip bun executable and script path
	const args = positionals.slice(2);
	const command = args[0] as CommandName | undefined;

	if (!command || !COMMANDS.includes(command)) {
		console.error(
			`Usage: bun db <command>\n\nCommands:\n  init        Generate baked.config.ts\n  generate    Create a new migration file\n  migrate     Run migrations (up/down)\n  status      Show migration status`,
		);
		process.exit(1);
	}

	return { command, rest: args.slice(1) };
}

async function main() {
	const { command, rest } = parseCommand();
	const config = await resolveConfig();

	switch (command) {
		case "init":
			await runInit();
			break;
		case "generate":
			await runGenerate(config, rest);
			break;
		case "migrate":
			await runMigrate(config, rest);
			break;
		case "status":
			await runStatus(config);
			break;
	}
}

main();

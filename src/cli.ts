#!/usr/bin/env bun

import { runCreate } from "./commands/create";
import { runDrop } from "./commands/drop";
import { runGenerate } from "./commands/generate";
import { runInit } from "./commands/init";
import { runMigrate } from "./commands/migrate";
import { runModel } from "./commands/model";
import { runStatus } from "./commands/status";
import { resolveConfig } from "./config";

const DB_COMMANDS = [
	"init",
	"create",
	"drop",
	"generate",
	"migrate",
	"status",
] as const;
type DbCommandName = (typeof DB_COMMANDS)[number];

const NAMESPACES = ["db", "model"] as const;
type Namespace = (typeof NAMESPACES)[number];

function printUsage(): never {
	console.error(
		`Usage: bake <namespace> <command>

Namespaces:
  db        Database migrations and schema
  model     Generate model files

Database commands:
  bake db init        Generate baked.config.ts
  bake db create      Create the database
  bake db drop        Drop the database
  bake db generate    Create a new migration file
  bake db migrate     Run migrations (up/down)
  bake db status      Show migration status

Model commands:
  bake model <Name>   Generate backend and frontend model files`,
	);
	process.exit(1);
}

function parseCommand(): {
	namespace: Namespace;
	rest: string[];
} {
	// Skip bun executable and script path, take raw args (including flags)
	const args = Bun.argv.slice(2);
	const namespace = args[0] as Namespace | undefined;

	if (!namespace || !NAMESPACES.includes(namespace)) {
		printUsage();
	}

	return { namespace, rest: args.slice(1) };
}

async function runDbCommand(rest: string[]) {
	const command = rest[0] as DbCommandName | undefined;

	if (!command || !DB_COMMANDS.includes(command)) {
		console.error(
			`Usage: bake db <command>\n\nCommands:\n  init        Generate baked.config.ts\n  create      Create the database\n  drop        Drop the database\n  generate    Create a new migration file\n  migrate     Run migrations (up/down)\n  status      Show migration status`,
		);
		process.exit(1);
	}

	const config = await resolveConfig();
	const commandArgs = rest.slice(1);

	switch (command) {
		case "init":
			await runInit();
			break;
		case "create":
			await runCreate(config, commandArgs);
			break;
		case "drop":
			await runDrop(config, commandArgs);
			break;
		case "generate":
			await runGenerate(config, commandArgs);
			break;
		case "migrate":
			await runMigrate(config, commandArgs);
			break;
		case "status":
			await runStatus(config);
			break;
	}
}

async function main() {
	const { namespace, rest } = parseCommand();

	switch (namespace) {
		case "db":
			await runDbCommand(rest);
			break;
		case "model": {
			const config = await resolveConfig();
			await runModel(config, rest);
			break;
		}
	}
}

main();

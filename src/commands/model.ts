import { mkdir } from "fs/promises";
import { dirname, relative, resolve } from "path";
import { parseArgs } from "util";

import { toPascalCase } from "../introspect";
import type { ResolvedConfig } from "../types";

/** Convert PascalCase or camelCase to snake_case. */
export function toSnakeCase(input: string): string {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.toLowerCase();
}

/** Infer a table name from a model name: PascalCase → snake_case + "s". */
export function inferTableName(modelName: string): string {
	return `${toSnakeCase(modelName)}s`;
}

/** Compute a relative import path from one file to another, without extension. */
function schemaImportPath(fromFile: string, schemaFile: string): string {
	let relativePath = relative(dirname(fromFile), schemaFile);
	// Remove .ts extension
	relativePath = relativePath.replace(/\.ts$/, "");
	// Ensure it starts with ./ or ../
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`;
	}
	return relativePath;
}

function buildBackendTemplate(
	className: string,
	tableName: string,
	schemaImport: string,
): string {
	return `import { Model } from "baked-orm";
import { ${tableName} } from "${schemaImport}";

export class ${className} extends Model(${tableName}) {}
`;
}

function buildFrontendTemplate(
	className: string,
	tableName: string,
	schemaImport: string,
): string {
	return `import { FrontendModel } from "baked-orm/frontend";
import { ${tableName} } from "${schemaImport}";

export class ${className} extends FrontendModel(${tableName}) {}
`;
}

export async function runModel(config: ResolvedConfig, args: string[]) {
	const { positionals, values: flags } = parseArgs({
		args,
		allowPositionals: true,
		strict: false,
		options: {
			table: { type: "string" },
			backend: { type: "string" },
			frontend: { type: "string" },
			"no-frontend": { type: "boolean", default: false },
			"no-backend": { type: "boolean", default: false },
		},
	});

	const rawName = positionals[0];
	if (!rawName) {
		console.error(
			`Usage: bake model <ModelName> [options]

Options:
  --table <name>      Table name (default: inferred from model name)
  --backend <path>    Backend model output directory
  --frontend <path>   Frontend model output directory
  --no-frontend       Skip frontend model generation
  --no-backend        Skip backend model generation`,
		);
		process.exit(1);
	}

	const className = toPascalCase(rawName);
	const tableName = (flags.table as string) ?? inferTableName(rawName);
	const fileName = `${toSnakeCase(rawName)}.ts`;
	const schemaPath = resolve(process.cwd(), config.schemaPath);

	const skipBackend = flags["no-backend"] as boolean;
	const skipFrontend = flags["no-frontend"] as boolean;

	if (skipBackend && skipFrontend) {
		console.error("Cannot use both --no-backend and --no-frontend");
		process.exit(1);
	}

	const created: string[] = [];

	if (!skipBackend) {
		const backendDir = resolve(
			process.cwd(),
			(flags.backend as string) ?? config.modelsPath,
		);
		const backendFile = resolve(backendDir, fileName);
		const backendSchemaImport = schemaImportPath(backendFile, schemaPath);

		await mkdir(backendDir, { recursive: true });
		await Bun.write(
			backendFile,
			buildBackendTemplate(className, tableName, backendSchemaImport),
		);
		created.push(relative(process.cwd(), backendFile));
	}

	if (!skipFrontend) {
		const frontendDir = resolve(
			process.cwd(),
			(flags.frontend as string) ?? config.frontendModelsPath,
		);
		const frontendFile = resolve(frontendDir, fileName);
		const frontendSchemaImport = schemaImportPath(frontendFile, schemaPath);

		await mkdir(frontendDir, { recursive: true });
		await Bun.write(
			frontendFile,
			buildFrontendTemplate(className, tableName, frontendSchemaImport),
		);
		created.push(relative(process.cwd(), frontendFile));
	}

	for (const file of created) {
		console.log(`\x1b[32mCreated\x1b[0m ${file}`);
	}
}

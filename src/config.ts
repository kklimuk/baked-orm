import { SQL, sql } from "bun";

import { type BakedConfig, DEFAULT_CONFIG, type ResolvedConfig } from "./types";

export function defineConfig(config: BakedConfig): BakedConfig {
	return config;
}

export async function resolveConfig(): Promise<ResolvedConfig> {
	const configPath = `${process.cwd()}/baked.config.ts`;
	let userConfig: BakedConfig = {};

	try {
		const mod = await import(configPath);
		userConfig = mod.default ?? mod;
	} catch (error) {
		const errorCode = (error as Record<string, unknown>)?.code;
		const isNotFound =
			errorCode === "ERR_MODULE_NOT_FOUND" || errorCode === "MODULE_NOT_FOUND";
		if (!isNotFound) throw error;
		// No config file found — use defaults
	}

	return {
		migrationsPath: userConfig.migrationsPath ?? DEFAULT_CONFIG.migrationsPath,
		schemaPath: userConfig.schemaPath ?? DEFAULT_CONFIG.schemaPath,
		modelsPath: userConfig.modelsPath ?? DEFAULT_CONFIG.modelsPath,
		frontendModelsPath:
			userConfig.frontendModelsPath ?? DEFAULT_CONFIG.frontendModelsPath,
		database: userConfig.database,
	};
}

export function getConnection(config: ResolvedConfig): SQL {
	if (!config.database) return sql;
	if (typeof config.database === "string") return new SQL(config.database);
	return new SQL(config.database);
}

export function getMaintenanceConnection(config: ResolvedConfig): SQL {
	if (!config.database) {
		return new SQL({ database: "postgres" });
	}
	if (typeof config.database === "string") {
		return new SQL(replaceDatabaseInUrl(config.database, "postgres"));
	}
	return new SQL({ ...config.database, database: "postgres" });
}

export function getConfiguredDatabaseName(
	config: ResolvedConfig,
): string | undefined {
	if (typeof config.database === "string") {
		return parseDatabaseFromUrl(config.database);
	}
	if (config.database) {
		if (config.database.database) return config.database.database;
		if (config.database.url) return parseDatabaseFromUrl(config.database.url);
	}
	const envUrl = Bun.env.POSTGRES_URL ?? Bun.env.DATABASE_URL;
	if (envUrl) {
		const fromEnvUrl = parseDatabaseFromUrl(envUrl);
		if (fromEnvUrl) return fromEnvUrl;
	}
	return Bun.env.PGDATABASE;
}

export function parseDatabaseFromUrl(input: string): string | undefined {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return undefined;
	}
	const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
	return name || undefined;
}

function replaceDatabaseInUrl(input: string, databaseName: string): string {
	const url = new URL(input);
	url.pathname = `/${databaseName}`;
	return url.toString();
}

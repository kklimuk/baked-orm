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
	} catch {
		// No config file found — use defaults
	}

	return {
		migrationsPath: userConfig.migrationsPath ?? DEFAULT_CONFIG.migrationsPath,
		schemaPath: userConfig.schemaPath ?? DEFAULT_CONFIG.schemaPath,
		database: userConfig.database,
	};
}

export function getConnection(config: ResolvedConfig): SQL {
	if (!config.database) return sql;
	if (typeof config.database === "string") return new SQL(config.database);
	return new SQL(config.database);
}

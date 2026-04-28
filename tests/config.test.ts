import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	defineConfig,
	getConfiguredDatabaseName,
	parseDatabaseFromUrl,
} from "../src/config";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../src/types";

function withResolved(database: ResolvedConfig["database"]): ResolvedConfig {
	return { ...DEFAULT_CONFIG, database };
}

describe("defineConfig", () => {
	test("returns config as-is", () => {
		const config = { migrationsPath: "./custom/migrations" };
		expect(defineConfig(config)).toEqual(config);
	});

	test("returns empty config as-is", () => {
		expect(defineConfig({})).toEqual({});
	});

	test("preserves all fields", () => {
		const config = {
			migrationsPath: "./migrations",
			schemaPath: "./schema.ts",
			database: "postgres://localhost/test",
		};
		expect(defineConfig(config)).toEqual(config);
	});
});

describe("DEFAULT_CONFIG", () => {
	test("has correct default migrations path", () => {
		expect(DEFAULT_CONFIG.migrationsPath).toBe("./db/migrations");
	});

	test("has correct default schema path", () => {
		expect(DEFAULT_CONFIG.schemaPath).toBe("./db/schema.ts");
	});

	test("has no default database config", () => {
		expect(DEFAULT_CONFIG.database).toBeUndefined();
	});
});

describe("parseDatabaseFromUrl", () => {
	test("extracts database name from a basic url", () => {
		expect(parseDatabaseFromUrl("postgres://localhost/myapp")).toBe("myapp");
	});

	test("extracts database name with credentials and port", () => {
		expect(parseDatabaseFromUrl("postgres://user:pass@host:5432/myapp")).toBe(
			"myapp",
		);
	});

	test("ignores query string", () => {
		expect(
			parseDatabaseFromUrl("postgres://localhost/myapp?sslmode=require"),
		).toBe("myapp");
	});

	test("returns undefined when path is empty", () => {
		expect(parseDatabaseFromUrl("postgres://localhost")).toBeUndefined();
	});

	test("returns undefined when path is bare slash", () => {
		expect(parseDatabaseFromUrl("postgres://localhost/")).toBeUndefined();
	});

	test("returns undefined for malformed url instead of throwing", () => {
		expect(parseDatabaseFromUrl("not-a-url")).toBeUndefined();
		expect(parseDatabaseFromUrl("")).toBeUndefined();
	});

	test("decodes percent-encoded names", () => {
		expect(parseDatabaseFromUrl("postgres://localhost/my%20app")).toBe(
			"my app",
		);
	});
});

describe("getConfiguredDatabaseName", () => {
	const envKeys = ["POSTGRES_URL", "DATABASE_URL", "PGDATABASE"] as const;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of envKeys) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of envKeys) {
			const previous = savedEnv[key];
			if (previous === undefined) delete Bun.env[key];
			else Bun.env[key] = previous;
		}
	});

	test("returns undefined when nothing is configured", () => {
		expect(getConfiguredDatabaseName(withResolved(undefined))).toBeUndefined();
	});

	test("reads from a string url config", () => {
		expect(
			getConfiguredDatabaseName(
				withResolved("postgres://localhost/from_string"),
			),
		).toBe("from_string");
	});

	test("reads from a DatabaseConfig.database field", () => {
		expect(
			getConfiguredDatabaseName(
				withResolved({ hostname: "localhost", database: "from_object" }),
			),
		).toBe("from_object");
	});

	test("reads from a DatabaseConfig.url field when database is missing", () => {
		expect(
			getConfiguredDatabaseName(
				withResolved({ url: "postgres://localhost/from_url" }),
			),
		).toBe("from_url");
	});

	test("prefers DatabaseConfig.database over DatabaseConfig.url", () => {
		expect(
			getConfiguredDatabaseName(
				withResolved({
					database: "wins",
					url: "postgres://localhost/loses",
				}),
			),
		).toBe("wins");
	});

	test("falls back to POSTGRES_URL env var", () => {
		Bun.env.POSTGRES_URL = "postgres://localhost/from_env";
		expect(getConfiguredDatabaseName(withResolved(undefined))).toBe("from_env");
	});

	test("falls back to DATABASE_URL when POSTGRES_URL is unset", () => {
		Bun.env.DATABASE_URL = "postgres://localhost/from_database_url";
		expect(getConfiguredDatabaseName(withResolved(undefined))).toBe(
			"from_database_url",
		);
	});

	test("prefers POSTGRES_URL over DATABASE_URL", () => {
		Bun.env.POSTGRES_URL = "postgres://localhost/wins";
		Bun.env.DATABASE_URL = "postgres://localhost/loses";
		expect(getConfiguredDatabaseName(withResolved(undefined))).toBe("wins");
	});

	test("falls back to PGDATABASE when env urls have no database name", () => {
		Bun.env.POSTGRES_URL = "postgres://localhost";
		Bun.env.PGDATABASE = "from_pgdatabase";
		expect(getConfiguredDatabaseName(withResolved(undefined))).toBe(
			"from_pgdatabase",
		);
	});

	test("config wins over env vars", () => {
		Bun.env.POSTGRES_URL = "postgres://localhost/env_loses";
		expect(
			getConfiguredDatabaseName(
				withResolved("postgres://localhost/config_wins"),
			),
		).toBe("config_wins");
	});
});

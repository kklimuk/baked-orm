import { describe, expect, test } from "bun:test";

import { defineConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/types";

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

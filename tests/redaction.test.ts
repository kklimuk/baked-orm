import { describe, expect, test } from "bun:test";

import {
	buildSensitiveColumns,
	redactSensitiveValues,
} from "../src/model/utils";
import type { ColumnDefinition } from "../src/types";

const sensitive = new Set(["password_digest", "api_token"]);

describe("redactSensitiveValues", () => {
	describe("INSERT queries", () => {
		test("redacts sensitive column values by position", () => {
			const text =
				'INSERT INTO "users" ("name", "email", "password_digest") VALUES ($1, $2, $3) RETURNING *';
			const values = ["Alice", "alice@test.com", "secret-hash"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["Alice", "alice@test.com", "[REDACTED]"]);
		});

		test("redacts multiple sensitive columns", () => {
			const text =
				'INSERT INTO "users" ("name", "password_digest", "api_token") VALUES ($1, $2, $3) RETURNING *';
			const values = ["Alice", "secret-hash", "tok_123"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["Alice", "[REDACTED]", "[REDACTED]"]);
		});

		test("handles batch insert — redacts in every row", () => {
			const text =
				'INSERT INTO "users" ("name", "password_digest") VALUES ($1, $2), ($3, $4), ($5, $6) RETURNING *';
			const values = ["Alice", "hash1", "Bob", "hash2", "Charlie", "hash3"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual([
				"Alice",
				"[REDACTED]",
				"Bob",
				"[REDACTED]",
				"Charlie",
				"[REDACTED]",
			]);
		});

		test("no redaction when no sensitive columns match", () => {
			const text =
				'INSERT INTO "users" ("name", "email") VALUES ($1, $2) RETURNING *';
			const values = ["Alice", "alice@test.com"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["Alice", "alice@test.com"]);
		});
	});

	describe("UPDATE queries", () => {
		test("redacts sensitive column in SET clause", () => {
			const text =
				'UPDATE "users" SET "password_digest" = $1 WHERE "id" = $2 RETURNING *';
			const values = ["new-hash", "user-id-123"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["[REDACTED]", "user-id-123"]);
		});

		test("redacts sensitive columns mixed with non-sensitive in SET", () => {
			const text =
				'UPDATE "users" SET "name" = $1, "password_digest" = $2, "email" = $3 WHERE "id" = $4 RETURNING *';
			const values = ["Alice", "new-hash", "alice@new.com", "user-id-123"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual([
				"Alice",
				"[REDACTED]",
				"alice@new.com",
				"user-id-123",
			]);
		});
	});

	describe("WHERE clauses", () => {
		test("redacts sensitive column in WHERE condition", () => {
			const text = 'SELECT * FROM "users" WHERE "password_digest" = $1';
			const values = ["lookup-hash"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["[REDACTED]"]);
		});

		test("redacts sensitive column in WHERE with other conditions", () => {
			const text =
				'SELECT * FROM "users" WHERE "name" = $1 AND "api_token" = $2';
			const values = ["Alice", "tok_secret"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["Alice", "[REDACTED]"]);
		});

		test("does not redact non-sensitive WHERE conditions", () => {
			const text = 'SELECT * FROM "users" WHERE "email" = $1 AND "name" = $2';
			const values = ["alice@test.com", "Alice"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["alice@test.com", "Alice"]);
		});
	});

	describe("UPSERT queries", () => {
		test("redacts sensitive columns in INSERT part of upsert", () => {
			const text =
				'INSERT INTO "users" ("email", "password_digest") VALUES ($1, $2) ON CONFLICT ("email") DO UPDATE SET "password_digest" = EXCLUDED."password_digest" RETURNING *';
			const values = ["alice@test.com", "hashed"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["alice@test.com", "[REDACTED]"]);
		});
	});

	describe("edge cases", () => {
		test("returns same array when sensitiveColumns is empty", () => {
			const text =
				'INSERT INTO "users" ("name", "password_digest") VALUES ($1, $2)';
			const values = ["Alice", "hash"];
			const result = redactSensitiveValues(text, values, new Set());
			expect(result).toBe(values); // same reference — no copy
		});

		test("returns same array when values is empty", () => {
			const text = 'DELETE FROM "users"';
			const values: unknown[] = [];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toBe(values);
		});

		test("handles DELETE with sensitive WHERE", () => {
			const text = 'DELETE FROM "users" WHERE "api_token" = $1';
			const values = ["tok_to_delete"];
			const result = redactSensitiveValues(text, values, sensitive);
			expect(result).toEqual(["[REDACTED]"]);
		});
	});
});

describe("buildSensitiveColumns", () => {
	const columns: Record<string, ColumnDefinition> = {
		id: { type: "uuid", nullable: false, columnName: "id" },
		name: { type: "text", nullable: false, columnName: "name" },
		passwordDigest: {
			type: "text",
			nullable: false,
			columnName: "password_digest",
		},
		apiToken: { type: "text", nullable: true, columnName: "api_token" },
	};

	test("maps camelCase sensitiveFields to DB column names", () => {
		function UserModel() {}
		UserModel.sensitiveFields = ["passwordDigest", "apiToken"];
		const result = buildSensitiveColumns(UserModel, columns);
		expect(result).toEqual(new Set(["password_digest", "api_token"]));
	});

	test("returns empty set when no sensitiveFields defined", () => {
		function PlainModel() {}
		const result = buildSensitiveColumns(PlainModel, columns);
		expect(result).toEqual(new Set());
	});

	test("caches result per model class", () => {
		function CachedModel() {}
		CachedModel.sensitiveFields = ["passwordDigest"];
		const first = buildSensitiveColumns(CachedModel, columns);
		const second = buildSensitiveColumns(CachedModel, columns);
		expect(first).toBe(second); // same reference — cached
	});

	test("different models get different cache entries", () => {
		function ModelA() {}
		ModelA.sensitiveFields = ["passwordDigest"];
		function ModelB() {}
		ModelB.sensitiveFields = ["apiToken"];
		const resultA = buildSensitiveColumns(ModelA, columns);
		const resultB = buildSensitiveColumns(ModelB, columns);
		expect(resultA).toEqual(new Set(["password_digest"]));
		expect(resultB).toEqual(new Set(["api_token"]));
	});
});

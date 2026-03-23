import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import {
	buildTemplate,
	extractTableName,
	formatTimestamp,
} from "../src/commands/generate";

describe("extractTableName", () => {
	test("extracts table from create_ prefix", () => {
		expect(extractTableName("create_users")).toBe("users");
	});

	test("extracts table from update_ prefix", () => {
		expect(extractTableName("update_users")).toBe("users");
	});

	test("extracts table from alter_ prefix", () => {
		expect(extractTableName("alter_users")).toBe("users");
	});

	test("extracts table from delete_ prefix", () => {
		expect(extractTableName("delete_users")).toBe("users");
	});

	test("extracts table from drop_ prefix", () => {
		expect(extractTableName("drop_users")).toBe("users");
	});

	test("returns null for unrecognized prefix", () => {
		expect(extractTableName("add_indexes")).toBeNull();
	});

	test("handles compound table names", () => {
		expect(extractTableName("create_user_roles")).toBe("user_roles");
	});

	test("handles deeply nested table names", () => {
		expect(extractTableName("drop_org_team_members")).toBe("org_team_members");
	});
});

describe("buildTemplate", () => {
	test("generates CREATE TABLE template for create_ prefix", () => {
		const template = buildTemplate("create_users");
		expect(template).toContain("CREATE TABLE users");
		expect(template).toContain("DROP TABLE users");
		expect(template).toContain("gen_random_uuid()");
		expect(template).toContain("created_at");
		expect(template).toContain("updated_at");
		expect(template).toContain("export async function up");
		expect(template).toContain("export async function down");
	});

	test("generates ALTER TABLE template for update_ prefix", () => {
		const template = buildTemplate("update_users");
		expect(template).toContain("ALTER TABLE users ADD COLUMN");
		expect(template).toContain("ALTER TABLE users DROP COLUMN");
	});

	test("generates ALTER TABLE template for alter_ prefix", () => {
		const template = buildTemplate("alter_posts");
		expect(template).toContain("ALTER TABLE posts ADD COLUMN");
		expect(template).toContain("ALTER TABLE posts DROP COLUMN");
	});

	test("generates DROP TABLE template for delete_ prefix", () => {
		const template = buildTemplate("delete_users");
		expect(template).toContain("DROP TABLE users");
		expect(template).toContain("CREATE TABLE users");
		expect(template).toContain("Recreate the table schema here");
	});

	test("generates DROP TABLE template for drop_ prefix", () => {
		const template = buildTemplate("drop_sessions");
		expect(template).toContain("DROP TABLE sessions");
	});

	test("generates blank template for unrecognized prefix", () => {
		const template = buildTemplate("add_indexes");
		expect(template).toContain("Write your migration here");
		expect(template).toContain("Write your rollback here");
		expect(template).not.toContain("CREATE TABLE");
		expect(template).not.toContain("ALTER TABLE");
		expect(template).not.toContain("DROP TABLE");
	});

	test("all templates import TransactionSQL", () => {
		const names = [
			"create_users",
			"update_users",
			"delete_users",
			"add_indexes",
		];
		for (const name of names) {
			expect(buildTemplate(name)).toContain(
				'import type { TransactionSQL } from "bun"',
			);
		}
	});
});

describe("formatTimestamp", () => {
	test("formats instant as YYYYMMDDhhmmss", () => {
		const instant = Temporal.Instant.from("2024-01-15T08:30:45Z");
		expect(formatTimestamp(instant)).toBe("20240115083045");
	});

	test("pads single-digit values with zeros", () => {
		const instant = Temporal.Instant.from("2024-03-05T01:02:03Z");
		expect(formatTimestamp(instant)).toBe("20240305010203");
	});

	test("handles midnight", () => {
		const instant = Temporal.Instant.from("2024-12-31T00:00:00Z");
		expect(formatTimestamp(instant)).toBe("20241231000000");
	});

	test("handles end of day", () => {
		const instant = Temporal.Instant.from("2024-06-15T23:59:59Z");
		expect(formatTimestamp(instant)).toBe("20240615235959");
	});
});

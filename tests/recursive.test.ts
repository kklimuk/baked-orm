import { describe, expect, test } from "bun:test";

import {
	buildKnownColumnNames,
	renumberParameters,
	requalifyFragment,
} from "../src/model/recursive";
import type { ColumnDefinition } from "../src/types";

describe("requalifyFragment", () => {
	const knownColumns = new Set(["id", "parent_id", "org_id", "discarded_at"]);

	test("prefixes a single bare column", () => {
		expect(requalifyFragment(`"id" = $1`, "child", knownColumns)).toBe(
			`"child"."id" = $1`,
		);
	});

	test("prefixes multiple columns in one fragment", () => {
		expect(
			requalifyFragment(
				`"org_id" = $1 AND "discarded_at" IS NULL`,
				"child",
				knownColumns,
			),
		).toBe(`"child"."org_id" = $1 AND "child"."discarded_at" IS NULL`);
	});

	test("leaves already-qualified columns alone", () => {
		expect(requalifyFragment(`other."id" = $1`, "child", knownColumns)).toBe(
			`other."id" = $1`,
		);
	});

	test("leaves unknown identifiers alone", () => {
		expect(requalifyFragment(`"unknown_col" = $1`, "child", knownColumns)).toBe(
			`"unknown_col" = $1`,
		);
	});

	test("handles IN clauses", () => {
		expect(
			requalifyFragment(`"id" IN ($1, $2, $3)`, "child", knownColumns),
		).toBe(`"child"."id" IN ($1, $2, $3)`);
	});

	test("preserves identifier escaping in alias quoting", () => {
		expect(requalifyFragment(`"id" = $1`, "weird_alias", knownColumns)).toBe(
			`"weird_alias"."id" = $1`,
		);
	});
});

describe("renumberParameters", () => {
	test("offset of 0 returns fragment unchanged", () => {
		expect(renumberParameters(`"id" = $1 AND "name" = $2`, 0)).toBe(
			`"id" = $1 AND "name" = $2`,
		);
	});

	test("shifts $N indices by offset", () => {
		expect(renumberParameters(`"id" = $1 AND "name" = $2`, 3)).toBe(
			`"id" = $4 AND "name" = $5`,
		);
	});

	test("handles multi-digit indices", () => {
		expect(renumberParameters(`$10 = $11`, 5)).toBe(`$15 = $16`);
	});

	test("ignores non-parameter dollar signs by matching only $<digits>", () => {
		// $foo is not a parameter placeholder, should be left alone.
		expect(renumberParameters(`$1 = '$foo'`, 2)).toBe(`$3 = '$foo'`);
	});
});

describe("buildKnownColumnNames", () => {
	test("collects DB column names from a column map", () => {
		const columns: Record<string, ColumnDefinition> = {
			id: { type: "uuid", nullable: false, columnName: "id" },
			parentId: { type: "uuid", nullable: true, columnName: "parent_id" },
			discardedAt: {
				type: "timestamptz",
				nullable: true,
				columnName: "discarded_at",
			},
		};
		const result = buildKnownColumnNames(columns);
		expect(result).toEqual(new Set(["id", "parent_id", "discarded_at"]));
	});
});

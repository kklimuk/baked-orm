import { describe, expect, test } from "bun:test";

import { compileConditions, SUBQUERY } from "../../src/model/where";
import type { ColumnDefinition } from "../../src/types";

const columns: Record<string, ColumnDefinition> = {
	id: { type: "uuid", nullable: false, columnName: "id" },
	name: { type: "text", nullable: false, columnName: "name" },
	email: { type: "text", nullable: false, columnName: "email" },
	age: { type: "int4", nullable: true, columnName: "age" },
	createdAt: {
		type: "timestamptz",
		nullable: false,
		columnName: "created_at",
	},
	deletedAt: {
		type: "timestamptz",
		nullable: true,
		columnName: "deleted_at",
	},
	metadata: { type: "jsonb", nullable: true, columnName: "metadata" },
};

describe("compileConditions — scalar equality", () => {
	test("string equality maps to col = $N with snake_case column", () => {
		const clauses = compileConditions({ name: "Alice" }, columns, 1);
		expect(clauses).toEqual([
			{ fragment: `"name" = $1`, values: ["Alice"], columnNames: ["name"] },
		]);
	});

	test("camelCase keys resolve to snake_case columns", () => {
		const date = new Date();
		const clauses = compileConditions({ createdAt: date }, columns, 1);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") = $1`,
		);
		expect(clauses[0]?.values).toEqual([date]);
	});

	test("Date instance is treated as a literal value, not an operator object", () => {
		const date = new Date();
		const clauses = compileConditions({ createdAt: date }, columns, 1);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") = $1`,
		);
		expect(clauses[0]?.values).toEqual([date]);
	});

	test("null value emits IS NULL with no parameter", () => {
		const clauses = compileConditions({ deletedAt: null }, columns, 1);
		expect(clauses).toEqual([
			{
				fragment: `"deleted_at" IS NULL`,
				values: [],
				columnNames: ["deleted_at"],
			},
		]);
	});

	test("multiple keys produce multiple clauses with sequential params", () => {
		const clauses = compileConditions({ name: "Alice", age: 30 }, columns, 1);
		expect(clauses).toHaveLength(2);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
		expect(clauses[1]?.fragment).toBe(`"age" = $2`);
	});

	test("startParamIndex offsets parameter numbers", () => {
		const clauses = compileConditions({ name: "Alice" }, columns, 5);
		expect(clauses[0]?.fragment).toBe(`"name" = $5`);
	});

	test("undefined values are skipped entirely", () => {
		const clauses = compileConditions(
			{ name: "Alice", age: undefined },
			columns,
			1,
		);
		expect(clauses).toHaveLength(1);
	});
});

describe("compileConditions — array IN", () => {
	test("array value emits IN clause with placeholders", () => {
		const clauses = compileConditions({ id: ["a", "b", "c"] }, columns, 1);
		expect(clauses).toEqual([
			{
				fragment: `"id" IN ($1, $2, $3)`,
				values: ["a", "b", "c"],
				columnNames: ["id"],
			},
		]);
	});

	test("empty array emits FALSE with no params", () => {
		const clauses = compileConditions({ id: [] }, columns, 1);
		expect(clauses).toEqual([
			{ fragment: "FALSE", values: [], columnNames: ["id"] },
		]);
	});

	test("array IN renumbers correctly with prior clauses", () => {
		const clauses = compileConditions(
			{ name: "x", id: ["a", "b"] },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
		expect(clauses[1]?.fragment).toBe(`"id" IN ($2, $3)`);
	});
});

describe("compileConditions — comparison operators", () => {
	test("gt", () => {
		const clauses = compileConditions({ age: { gt: 18 } }, columns, 1);
		expect(clauses[0]).toEqual({
			fragment: `"age" > $1`,
			values: [18],
			columnNames: ["age"],
		});
	});

	test("gte / lt / lte", () => {
		expect(
			compileConditions({ age: { gte: 18 } }, columns, 1)[0]?.fragment,
		).toBe(`"age" >= $1`);
		expect(
			compileConditions({ age: { lt: 65 } }, columns, 1)[0]?.fragment,
		).toBe(`"age" < $1`);
		expect(
			compileConditions({ age: { lte: 65 } }, columns, 1)[0]?.fragment,
		).toBe(`"age" <= $1`);
	});

	test("ne with non-null", () => {
		const clauses = compileConditions({ name: { ne: "Alice" } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"name" != $1`);
	});

	test("eq with explicit null becomes IS NULL", () => {
		const clauses = compileConditions({ deletedAt: { eq: null } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"deleted_at" IS NULL`);
		expect(clauses[0]?.values).toEqual([]);
	});

	test("ne with explicit null becomes IS NOT NULL", () => {
		const clauses = compileConditions({ deletedAt: { ne: null } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"deleted_at" IS NOT NULL`);
		expect(clauses[0]?.values).toEqual([]);
	});
});

describe("compileConditions — multi-operator on one column", () => {
	test("range query (gte + lt) ANDs predicates and wraps in parens", () => {
		const clauses = compileConditions({ age: { gte: 18, lt: 65 } }, columns, 1);
		expect(clauses).toHaveLength(1);
		expect(clauses[0]?.fragment).toBe(`("age" >= $1 AND "age" < $2)`);
		expect(clauses[0]?.values).toEqual([18, 65]);
		expect(clauses[0]?.columnNames).toEqual(["age"]);
	});

	test("eq + ne on same column AND together", () => {
		const clauses = compileConditions(
			{ name: { ne: "Alice", in: ["Alice", "Bob"] } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`("name" != $1 AND "name" IN ($2, $3))`);
		expect(clauses[0]?.values).toEqual(["Alice", "Alice", "Bob"]);
	});

	test("multi-op preserves param numbering across columns", () => {
		const clauses = compileConditions(
			{ age: { gte: 18, lt: 65 }, name: "Alice" },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`("age" >= $1 AND "age" < $2)`);
		expect(clauses[1]?.fragment).toBe(`"name" = $3`);
	});

	test("empty operator object produces no clause for that column", () => {
		const clauses = compileConditions({ name: {}, age: 30 }, columns, 1);
		expect(clauses).toHaveLength(1);
		expect(clauses[0]?.fragment).toBe(`"age" = $1`);
	});
});

describe("compileConditions — IN / NOT IN operator forms", () => {
	test("in operator", () => {
		const clauses = compileConditions({ id: { in: ["a", "b"] } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"id" IN ($1, $2)`);
		expect(clauses[0]?.values).toEqual(["a", "b"]);
	});

	test("not_in operator", () => {
		const clauses = compileConditions(
			{ id: { not_in: ["a", "b"] } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`"id" NOT IN ($1, $2)`);
	});

	test("not_in with empty array → TRUE", () => {
		const clauses = compileConditions({ id: { not_in: [] } }, columns, 1);
		expect(clauses[0]?.fragment).toBe("TRUE");
	});

	test("in with empty array → FALSE", () => {
		const clauses = compileConditions({ id: { in: [] } }, columns, 1);
		expect(clauses[0]?.fragment).toBe("FALSE");
	});
});

describe("compileConditions — string operators", () => {
	test("like", () => {
		const clauses = compileConditions({ name: { like: "Al%" } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"name" LIKE $1`);
		expect(clauses[0]?.values).toEqual(["Al%"]);
	});

	test("ilike", () => {
		const clauses = compileConditions(
			{ name: { ilike: "%alice%" } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`"name" ILIKE $1`);
	});

	test("contains wraps the value with %", () => {
		const clauses = compileConditions(
			{ name: { contains: "ali" } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`"name" LIKE $1`);
		expect(clauses[0]?.values).toEqual(["%ali%"]);
	});

	test("starts_with wraps with trailing %", () => {
		const clauses = compileConditions(
			{ name: { starts_with: "Al" } },
			columns,
			1,
		);
		expect(clauses[0]?.values).toEqual(["Al%"]);
	});

	test("ends_with wraps with leading %", () => {
		const clauses = compileConditions(
			{ name: { ends_with: "ce" } },
			columns,
			1,
		);
		expect(clauses[0]?.values).toEqual(["%ce"]);
	});
});

describe("compileConditions — JSON columns", () => {
	test("operator-shaped object on JSON column is treated as a literal", () => {
		const value = { eq: 5 };
		const clauses = compileConditions({ metadata: value }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"metadata" = $1`);
		expect(clauses[0]?.values).toEqual([value]);
	});

	test("literal JSON object with non-operator keys is treated as a value", () => {
		const value = { theme: "dark", count: 5 };
		const clauses = compileConditions({ metadata: value }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"metadata" = $1`);
		expect(clauses[0]?.values).toEqual([value]);
	});

	test("null on JSON column still emits IS NULL", () => {
		const clauses = compileConditions({ metadata: null }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"metadata" IS NULL`);
	});
});

describe("compileConditions — non-plain-object values are literals", () => {
	test("Date instance is bound, not interpreted", () => {
		const date = new Date();
		const clauses = compileConditions({ createdAt: date }, columns, 1);
		expect(clauses[0]?.values).toEqual([date]);
	});
});

describe("compileConditions — timestamp precision clamping", () => {
	test("scalar equality on timestamptz uses clamped expression", () => {
		const date = new Date();
		const clauses = compileConditions({ createdAt: date }, columns, 1);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") = $1`,
		);
	});

	test("array IN on timestamptz uses clamped expression", () => {
		const dates = [new Date(), new Date()];
		const clauses = compileConditions({ createdAt: dates }, columns, 1);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") IN ($1, $2)`,
		);
	});

	test("eq operator on timestamptz uses clamped expression", () => {
		const clauses = compileConditions(
			{ createdAt: { eq: new Date() } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") = $1`,
		);
	});

	test("ne operator on timestamptz uses clamped expression", () => {
		const clauses = compileConditions(
			{ createdAt: { ne: new Date() } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") != $1`,
		);
	});

	test("in operator on timestamptz uses clamped expression", () => {
		const clauses = compileConditions(
			{ createdAt: { in: [new Date()] } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") IN ($1)`,
		);
	});

	test("not_in operator on timestamptz uses clamped expression", () => {
		const clauses = compileConditions(
			{ createdAt: { not_in: [new Date()] } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`date_trunc('milliseconds', "created_at") NOT IN ($1)`,
		);
	});

	test("eq null on timestamptz uses bare column (IS NULL)", () => {
		const clauses = compileConditions({ deletedAt: { eq: null } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"deleted_at" IS NULL`);
	});

	test("ne null on timestamptz uses bare column (IS NOT NULL)", () => {
		const clauses = compileConditions({ deletedAt: { ne: null } }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"deleted_at" IS NOT NULL`);
	});

	test("gt/gte/lt/lte on timestamptz use bare column (not clamped)", () => {
		const date = new Date();
		expect(
			compileConditions({ createdAt: { gt: date } }, columns, 1)[0]?.fragment,
		).toBe(`"created_at" > $1`);
		expect(
			compileConditions({ createdAt: { gte: date } }, columns, 1)[0]?.fragment,
		).toBe(`"created_at" >= $1`);
		expect(
			compileConditions({ createdAt: { lt: date } }, columns, 1)[0]?.fragment,
		).toBe(`"created_at" < $1`);
		expect(
			compileConditions({ createdAt: { lte: date } }, columns, 1)[0]?.fragment,
		).toBe(`"created_at" <= $1`);
	});

	test("null on timestamptz uses bare column (not clamped)", () => {
		const clauses = compileConditions({ deletedAt: null }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"deleted_at" IS NULL`);
	});

	test("non-timestamp column is not clamped", () => {
		const clauses = compileConditions({ name: "Alice" }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
	});

	test("multi-operator with mixed range + equality on timestamptz", () => {
		const date = new Date();
		const clauses = compileConditions(
			{ createdAt: { gte: date, ne: date } },
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`("created_at" >= $1 AND date_trunc('milliseconds', "created_at") != $2)`,
		);
	});
});

describe("compileConditions — mixed scalar + operator", () => {
	test("scalar + operator AND together with sequential params", () => {
		const clauses = compileConditions(
			{ name: "Alice", age: { gt: 18 } },
			columns,
			1,
		);
		expect(clauses).toHaveLength(2);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
		expect(clauses[1]?.fragment).toBe(`"age" > $2`);
	});

	test("scalar + null + operator", () => {
		const clauses = compileConditions(
			{
				name: "Alice",
				deletedAt: null,
				age: { gte: 18 },
			},
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
		expect(clauses[1]?.fragment).toBe(`"deleted_at" IS NULL`);
		expect(clauses[2]?.fragment).toBe(`"age" >= $2`);
	});
});

describe("compileConditions — or / and grouping", () => {
	test("or group joins children with OR inside parens", () => {
		const clauses = compileConditions(
			{
				or: [{ name: { ilike: "%alice%" } }, { email: { ilike: "%alice%" } }],
			},
			columns,
			1,
		);
		expect(clauses).toHaveLength(1);
		expect(clauses[0]?.fragment).toBe(`("name" ILIKE $1 OR "email" ILIKE $2)`);
		expect(clauses[0]?.values).toEqual(["%alice%", "%alice%"]);
		expect(new Set(clauses[0]?.columnNames)).toEqual(
			new Set(["name", "email"]),
		);
	});

	test("multi-key child within or wraps in inner parens", () => {
		const clauses = compileConditions(
			{
				or: [{ name: "Alice", age: { gt: 18 } }, { email: "bob@example.com" }],
			},
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`(("name" = $1 AND "age" > $2) OR "email" = $3)`,
		);
		expect(clauses[0]?.values).toEqual(["Alice", 18, "bob@example.com"]);
	});

	test("multi-operator child within or keeps its own parens", () => {
		const clauses = compileConditions(
			{
				or: [{ age: { gte: 18, lt: 65 } }, { name: "Alice" }],
			},
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`(("age" >= $1 AND "age" < $2) OR "name" = $3)`,
		);
	});

	test("nested or inside and inside or", () => {
		const clauses = compileConditions(
			{
				or: [
					{ and: [{ name: "Alice" }, { age: { gt: 18 } }] },
					{ email: "x@y.z" },
				],
			},
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(
			`(("name" = $1 AND "age" > $2) OR "email" = $3)`,
		);
	});

	test("empty or → FALSE", () => {
		const clauses = compileConditions({ or: [] }, columns, 1);
		expect(clauses[0]?.fragment).toBe("FALSE");
		expect(clauses[0]?.values).toEqual([]);
	});

	test("empty and → TRUE", () => {
		const clauses = compileConditions({ and: [] }, columns, 1);
		expect(clauses[0]?.fragment).toBe("TRUE");
	});

	test("group followed by scalar key keeps param numbering correct", () => {
		const clauses = compileConditions(
			{
				or: [{ name: "Alice" }, { name: "Bob" }],
				age: { gt: 18 },
			},
			columns,
			1,
		);
		expect(clauses[0]?.fragment).toBe(`("name" = $1 OR "name" = $2)`);
		expect(clauses[1]?.fragment).toBe(`"age" > $3`);
	});

	test("startParamIndex offset propagates into groups", () => {
		const clauses = compileConditions(
			{ or: [{ name: "a" }, { name: "b" }] },
			columns,
			10,
		);
		expect(clauses[0]?.fragment).toBe(`("name" = $10 OR "name" = $11)`);
	});
});

describe("compileConditions — error cases", () => {
	test("object with unknown key on non-JSON column is treated as literal equality", () => {
		// TypeScript catches typos at the call site; at runtime a non-operator
		// plain object is treated as a literal value rather than throwing.
		const value = { totally_made_up: "x" };
		const clauses = compileConditions({ name: value }, columns, 1);
		expect(clauses[0]?.fragment).toBe(`"name" = $1`);
		expect(clauses[0]?.values).toEqual([value]);
	});

	test("unknown column name throws with helpful message", () => {
		expect(() =>
			compileConditions({ nonExistent: "value" }, columns, 1),
		).toThrow(/unknown column "nonExistent"/);
	});

	test("or with non-array throws", () => {
		expect(() =>
			compileConditions({ or: { name: "x" } } as never, columns, 1),
		).toThrow();
	});

	test("in operator with non-array value throws", () => {
		expect(() =>
			compileConditions({ id: { in: "a" } } as never, columns, 1),
		).toThrow(/array or subquery/);
	});
});

describe("compileConditions — subqueries", () => {
	const subquery = {
		[SUBQUERY]() {
			return {
				sql: `SELECT "id" FROM "users" WHERE "active" = $1`,
				values: [true],
			};
		},
	};

	test("direct subquery value compiles to col IN (SELECT ...)", () => {
		const clauses = compileConditions({ id: subquery } as never, columns, 1);
		expect(clauses).toEqual([
			{
				fragment: `"id" IN (SELECT "id" FROM "users" WHERE "active" = $1)`,
				values: [true],
				columnNames: ["id"],
			},
		]);
	});

	test("param renumbering when outer query has prior params", () => {
		const clauses = compileConditions(
			{ name: "Alice", id: subquery } as never,
			columns,
			1,
		);
		expect(clauses).toHaveLength(2);
		expect(clauses[0]).toEqual({
			fragment: `"name" = $1`,
			values: ["Alice"],
			columnNames: ["name"],
		});
		expect(clauses[1]).toEqual({
			fragment: `"id" IN (SELECT "id" FROM "users" WHERE "active" = $2)`,
			values: [true],
			columnNames: ["id"],
		});
	});

	test("in operator with subquery", () => {
		const clauses = compileConditions(
			{ id: { in: subquery } } as never,
			columns,
			1,
		);
		expect(clauses).toEqual([
			{
				fragment: `"id" IN (SELECT "id" FROM "users" WHERE "active" = $1)`,
				values: [true],
				columnNames: ["id"],
			},
		]);
	});

	test("not_in operator with subquery", () => {
		const clauses = compileConditions(
			{ id: { not_in: subquery } } as never,
			columns,
			1,
		);
		expect(clauses).toEqual([
			{
				fragment: `"id" NOT IN (SELECT "id" FROM "users" WHERE "active" = $1)`,
				values: [true],
				columnNames: ["id"],
			},
		]);
	});

	test("timestamp column skips clamping for subquery values", () => {
		const subq = {
			[SUBQUERY]() {
				return {
					sql: `SELECT "created_at" FROM "events"`,
					values: [],
				};
			},
		};
		const clauses = compileConditions({ createdAt: subq } as never, columns, 1);
		// bare "created_at", not date_trunc(...)
		expect(clauses[0]?.fragment).toBe(
			`"created_at" IN (SELECT "created_at" FROM "events")`,
		);
	});

	test("subquery inside or group", () => {
		const clauses = compileConditions(
			{ or: [{ id: subquery }, { name: "Bob" }] } as never,
			columns,
			1,
		);
		expect(clauses).toHaveLength(1);
		expect(clauses[0]?.fragment).toBe(
			`("id" IN (SELECT "id" FROM "users" WHERE "active" = $1) OR "name" = $2)`,
		);
		expect(clauses[0]?.values).toEqual([true, "Bob"]);
	});

	test("subquery with empty values array", () => {
		const emptySubquery = {
			[SUBQUERY]() {
				return {
					sql: `SELECT "id" FROM "users"`,
					values: [],
				};
			},
		};
		const clauses = compileConditions(
			{ id: emptySubquery } as never,
			columns,
			1,
		);
		expect(clauses).toEqual([
			{
				fragment: `"id" IN (SELECT "id" FROM "users")`,
				values: [],
				columnNames: ["id"],
			},
		]);
	});

	test("mixed in subquery + ne on same column", () => {
		const clauses = compileConditions(
			{ id: { in: subquery, ne: "x" } } as never,
			columns,
			1,
		);
		expect(clauses).toHaveLength(1);
		expect(clauses[0]?.fragment).toBe(
			`("id" IN (SELECT "id" FROM "users" WHERE "active" = $1) AND "id" != $2)`,
		);
		expect(clauses[0]?.values).toEqual([true, "x"]);
	});

	test("columnNames tracking for subquery clause", () => {
		const clauses = compileConditions({ email: subquery } as never, columns, 1);
		expect(clauses[0]?.columnNames).toEqual(["email"]);
	});
});

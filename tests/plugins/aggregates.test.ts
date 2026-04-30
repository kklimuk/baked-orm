import { describe, expect, test } from "bun:test";

import { QueryBuilder } from "../../src/model/query";
import type { TableDefinition } from "../../src/types";

class OrdersRow {
	declare id: string;
	declare userId: string;
	declare status: string;
	declare total: number;
	declare createdAt: Date;
}

const ordersTableDef: TableDefinition<OrdersRow> = {
	tableName: "orders",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		userId: { type: "uuid", nullable: false, columnName: "user_id" },
		status: { type: "text", nullable: false, columnName: "status" },
		total: { type: "numeric", nullable: false, columnName: "total" },
		createdAt: {
			type: "timestamptz",
			nullable: false,
			columnName: "created_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: OrdersRow,
};

class PagesRow {
	declare id: string;
	declare parentId: string | null;
	declare kind: string;
	declare title: string;
}

const pagesTableDef: TableDefinition<PagesRow> = {
	tableName: "pages",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		parentId: { type: "uuid", nullable: true, columnName: "parent_id" },
		kind: { type: "text", nullable: false, columnName: "kind" },
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PagesRow,
};

describe("group() — SQL generation", () => {
	test("single column group + count emits GROUP BY and COUNT(*)", () => {
		const query = new QueryBuilder(ordersTableDef).group("status");
		// Set up the same transient state count() would set internally
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toBe(
			`SELECT "status", COUNT(*) AS "count" FROM "orders" GROUP BY "status"`,
		);
	});

	test("multi-column group emits GROUP BY with both columns", () => {
		const query = new QueryBuilder(ordersTableDef).group("status", "userId");
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toContain(`GROUP BY "status", "user_id"`);
		expect(text).toContain(`SELECT "status", "user_id", COUNT(*)`);
	});

	test("group + sum emits SUM(col) AS sum", () => {
		const query = new QueryBuilder(ordersTableDef).group("userId");
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "sum", column: "total" },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toBe(
			`SELECT "user_id", SUM("total") AS "sum" FROM "orders" GROUP BY "user_id"`,
		);
	});

	test("group + where places WHERE before GROUP BY", () => {
		const query = new QueryBuilder(ordersTableDef)
			.where({ status: "active" })
			.group("userId");
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text, values } = cloned.toSQL();
		expect(text).toBe(
			`SELECT "user_id", COUNT(*) AS "count" FROM "orders" WHERE "status" = $1 GROUP BY "user_id"`,
		);
		expect(values).toEqual(["active"]);
	});

	test("camelCase JS column resolves to snake_case DB column", () => {
		const query = new QueryBuilder(ordersTableDef).group("userId");
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toContain(`"user_id"`);
		expect(text).not.toContain(`"userId"`);
	});

	test("group() with no columns throws", () => {
		expect(() => new QueryBuilder(ordersTableDef).group()).toThrow(
			"group() requires at least one column",
		);
	});

	test("group preserves through .where()/.order() chain", () => {
		const query = new QueryBuilder(ordersTableDef)
			.group("userId")
			.where({ status: "active" })
			.order({ userId: "ASC" });
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toContain("GROUP BY");
		expect(text).toContain("ORDER BY");
		expect(text.indexOf("GROUP BY")).toBeLessThan(text.indexOf("ORDER BY"));
	});
});

describe("scalar aggregates — SQL generation", () => {
	test("sum emits SUM(col) without GROUP BY", () => {
		const query = (
			new QueryBuilder(ordersTableDef) as unknown as QueryBuilder<OrdersRow>
		)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "sum", column: "total" },
			},
		});
		const { text } = query.toSQL();
		expect(text).toBe(`SELECT SUM("total") AS "sum" FROM "orders"`);
	});

	test("sum + where threads WHERE in", () => {
		const query = (
			new QueryBuilder(ordersTableDef).where({
				status: "active",
			}) as unknown as QueryBuilder<OrdersRow>
		)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "sum", column: "total" },
			},
		});
		const { text, values } = query.toSQL();
		expect(text).toBe(
			`SELECT SUM("total") AS "sum" FROM "orders" WHERE "status" = $1`,
		);
		expect(values).toEqual(["active"]);
	});

	test("min emits MIN(col)", () => {
		const query = (
			new QueryBuilder(ordersTableDef) as unknown as QueryBuilder<OrdersRow>
		)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "min", column: "created_at" },
			},
		});
		const { text } = query.toSQL();
		expect(text).toBe(`SELECT MIN("created_at") AS "min" FROM "orders"`);
	});
});

describe("havingRaw — SQL generation", () => {
	test("havingRaw appends HAVING clause", () => {
		const query = new QueryBuilder(ordersTableDef)
			.group("userId")
			.havingRaw("COUNT(*) > $1", [5]);
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text, values } = cloned.toSQL();
		expect(text).toBe(
			`SELECT "user_id", COUNT(*) AS "count" FROM "orders" GROUP BY "user_id" HAVING COUNT(*) > $1`,
		);
		expect(values).toEqual([5]);
	});

	test("havingRaw renumbers params after WHERE params", () => {
		const query = new QueryBuilder(ordersTableDef)
			.where({ status: "active" })
			.group("userId")
			.havingRaw("COUNT(*) > $1", [5]);
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text, values } = cloned.toSQL();
		// $1 from WHERE, $2 from HAVING after renumbering
		expect(text).toBe(
			`SELECT "user_id", COUNT(*) AS "count" FROM "orders" WHERE "status" = $1 GROUP BY "user_id" HAVING COUNT(*) > $2`,
		);
		expect(values).toEqual(["active", 5]);
	});

	test("multiple havingRaw clauses AND together", () => {
		const query = new QueryBuilder(ordersTableDef)
			.group("userId")
			.havingRaw("COUNT(*) > $1", [5])
			.havingRaw("SUM(total) < $1", [1000]);
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text, values } = cloned.toSQL();
		expect(text).toContain("HAVING COUNT(*) > $1 AND SUM(total) < $2");
		expect(values).toEqual([5, 1000]);
	});

	test("havingRaw without group() throws", () => {
		expect(() =>
			new QueryBuilder(ordersTableDef).havingRaw("COUNT(*) > 5"),
		).toThrow("havingRaw() requires group()");
	});
});

describe("aggregate({ ... }) — SQL generation", () => {
	test("aggregate emits raw expressions with aliases", async () => {
		const query = new QueryBuilder(ordersTableDef).group("status");
		const cloned = (query as unknown as QueryBuilder<OrdersRow>)._clone({
			extensions: {
				aggregateTerminal: {
					kind: "raw",
					expressions: [
						{ alias: "ids", sql: "ARRAY_AGG(id)" },
						{ alias: "totalSum", sql: "SUM(total)" },
					],
				},
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toBe(
			`SELECT "status", ARRAY_AGG(id) AS "ids", SUM(total) AS "totalSum" FROM "orders" GROUP BY "status"`,
		);
	});

	test("aggregate without group() throws", async () => {
		const query = new QueryBuilder(ordersTableDef);
		await expect(query.aggregate({ count: "COUNT(*)" })).rejects.toThrow(
			"aggregate({ ... }) requires group()",
		);
	});

	test("aggregate with empty fragments throws", async () => {
		const query = new QueryBuilder(ordersTableDef).group("status");
		await expect(query.aggregate({})).rejects.toThrow(
			"requires at least one expression",
		);
	});
});

describe("composition guards", () => {
	test("sum on non-numeric column throws", async () => {
		const query = new QueryBuilder(ordersTableDef);
		await expect(
			query.sum("status" as unknown as keyof OrdersRow & string),
		).rejects.toThrow(`sum("status") requires a numeric column`);
	});

	test("avg on non-numeric column throws", async () => {
		const query = new QueryBuilder(ordersTableDef);
		await expect(
			query.avg("status" as unknown as keyof OrdersRow & string),
		).rejects.toThrow(`avg("status") requires a numeric column`);
	});

	test("group() + lock() throws at terminal time", async () => {
		// Cast back to QueryBuilder — GroupedQueryBuilder intentionally hides
		// .lock(); we want to verify the runtime guard fires anyway.
		const query = (
			new QueryBuilder(ordersTableDef).group(
				"status",
			) as unknown as QueryBuilder<OrdersRow>
		).lock();
		await expect(query.count()).rejects.toThrow(
			"Cannot call count() with lock()",
		);
	});

	test("group() + distinct() throws at terminal time", async () => {
		const query = (
			new QueryBuilder(ordersTableDef).group(
				"status",
			) as unknown as QueryBuilder<OrdersRow>
		).distinct();
		await expect(query.count()).rejects.toThrow(
			"Cannot call count() with distinct()",
		);
	});

	test("group() + includes() throws at terminal time", async () => {
		const query = (
			new QueryBuilder(ordersTableDef).group(
				"status",
			) as unknown as QueryBuilder<OrdersRow>
		).includes("user");
		await expect(query.count()).rejects.toThrow(
			"Cannot call count() with includes()",
		);
	});

	test("aggregate-active QB used as subquery throws", () => {
		const query = new QueryBuilder(ordersTableDef).group("status");
		const subqueryFn = (
			query as unknown as Record<symbol, (() => unknown) | undefined>
		)[Symbol.for("baked-orm.subquery")];
		expect(() => {
			if (!subqueryFn) throw new Error("missing subquery getter");
			subqueryFn.call(query);
		}).toThrow("aggregate-active query cannot be used as a subquery");
	});
});

describe("recursive CTE composition", () => {
	test("descendants + group + count emits aggregate over __traversal", () => {
		const query = new QueryBuilder(pagesTableDef)
			.where({ id: "root-id" })
			.descendants({ via: "parentId" })
			.group("kind");
		const cloned = (query as unknown as QueryBuilder<PagesRow>)._clone({
			extensions: {
				aggregateTerminal: { kind: "fn", fn: "count", column: null },
			},
		});
		const { text } = cloned.toSQL();
		expect(text).toContain("WITH RECURSIVE __traversal AS (");
		expect(text).toContain(
			`SELECT "kind", COUNT(*) AS "count" FROM __traversal`,
		);
		expect(text).toContain(`GROUP BY "kind"`);
	});
});

describe("scalar count() unchanged", () => {
	test("count() without group() still returns scalar SQL", () => {
		const { text } = new QueryBuilder(ordersTableDef)
			.where({ status: "active" })
			.toSQL();
		expect(text).toContain(`SELECT "orders".* FROM "orders"`);
	});
});

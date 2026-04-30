import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { SQL } from "bun";

import { Model } from "../../src/model/base";
import { connect } from "../../src/model/connection";
import type { TableDefinition } from "../../src/types";
import { getTestConnection, resetDatabase } from "../helpers/postgres";

let connection: SQL;

class OrdersRow {
	declare id: string;
	declare userId: string;
	declare status: string;
	declare total: number;
	declare discardedAt: Date | null;
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
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: OrdersRow,
};

class Order extends Model(ordersTableDef) {
	static softDelete = true;
}

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

class Page extends Model(pagesTableDef) {}

const USER_ONE = "11111111-1111-1111-1111-111111111111";
const USER_TWO = "22222222-2222-2222-2222-222222222222";
const USER_THREE = "33333333-3333-3333-3333-333333333333";

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	await connection`
		CREATE TABLE orders (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL,
			status text NOT NULL,
			total numeric NOT NULL,
			discarded_at timestamptz
		)
	`;
	await connection`
		CREATE TABLE pages (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			parent_id uuid REFERENCES pages(id),
			kind text NOT NULL,
			title text NOT NULL
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

async function seedOrders() {
	await Order.createMany([
		{ userId: USER_ONE, status: "active", total: 100 },
		{ userId: USER_ONE, status: "active", total: 50 },
		{ userId: USER_ONE, status: "cancelled", total: 25 },
		{ userId: USER_TWO, status: "active", total: 200 },
		{ userId: USER_TWO, status: "cancelled", total: 75 },
		{ userId: USER_THREE, status: "active", total: 300 },
	]);
}

describe("scalar aggregates", () => {
	test("Model.sum returns the total", async () => {
		await seedOrders();
		const result = await Order.sum("total");
		expect(result).toBe(750);
	});

	test("Model.avg returns the average", async () => {
		await seedOrders();
		const result = await Order.avg("total");
		expect(result).not.toBeNull();
		// Postgres avg of [100, 50, 25, 200, 75, 300] = 125
		expect(result).toBeCloseTo(125, 5);
	});

	test("Model.min returns the minimum", async () => {
		await seedOrders();
		const result = await Order.min("total");
		expect(result).toBe(25);
	});

	test("Model.max returns the maximum", async () => {
		await seedOrders();
		const result = await Order.max("total");
		expect(result).toBe(300);
	});

	test("scalar where chain narrows result", async () => {
		await seedOrders();
		const activeTotal = await Order.where({ status: "active" }).sum("total");
		expect(activeTotal).toBe(650);
	});

	test("zero rows returns null for sum/avg/min/max", async () => {
		const sum = await Order.where({ status: "missing" }).sum("total");
		const avg = await Order.where({ status: "missing" }).avg("total");
		const min = await Order.where({ status: "missing" }).min("total");
		const max = await Order.where({ status: "missing" }).max("total");
		expect(sum).toBeNull();
		expect(avg).toBeNull();
		expect(min).toBeNull();
		expect(max).toBeNull();
	});
});

describe("grouped aggregates", () => {
	test("group + count returns array of {col, count}", async () => {
		await seedOrders();
		const counts = await Order.group("status").count();
		const sorted = [...counts].sort((a, b) => a.status.localeCompare(b.status));
		expect(sorted).toEqual([
			{ status: "active", count: 4 },
			{ status: "cancelled", count: 2 },
		]);
	});

	test("group + sum returns array of {col, sum}", async () => {
		await seedOrders();
		const sums = await Order.group("userId").sum("total");
		const byUser = new Map(sums.map((row) => [row.userId, row.sum]));
		expect(byUser.get(USER_ONE)).toBe(175);
		expect(byUser.get(USER_TWO)).toBe(275);
		expect(byUser.get(USER_THREE)).toBe(300);
	});

	test("multi-column group", async () => {
		await seedOrders();
		const rows = await Order.group("userId", "status").count();
		const key = (userId: string, status: string) =>
			rows.find((row) => row.userId === userId && row.status === status);
		expect(key(USER_ONE, "active")?.count).toBe(2);
		expect(key(USER_ONE, "cancelled")?.count).toBe(1);
		expect(key(USER_TWO, "active")?.count).toBe(1);
	});

	test("empty match returns []", async () => {
		const counts = await Order.where({ status: "missing" })
			.group("userId")
			.count();
		expect(counts).toEqual([]);
	});

	test("havingRaw filters post-aggregation", async () => {
		await seedOrders();
		const result = await Order.group("userId")
			.havingRaw("COUNT(*) > $1", [1])
			.count();
		// USER_ONE has 3 rows, USER_TWO has 2 rows, USER_THREE has 1 row
		const userIds = result.map((row) => row.userId).sort();
		expect(userIds).toEqual([USER_ONE, USER_TWO].sort());
	});

	test("aggregate({...}) emits raw expressions", async () => {
		await seedOrders();
		const result = await Order.group("userId").aggregate({
			totalSum: "SUM(total)",
			orderCount: "COUNT(*)",
		});
		const byUser = new Map(result.map((row) => [row.userId, row]));
		expect(Number(byUser.get(USER_ONE)?.totalSum)).toBe(175);
		expect(Number(byUser.get(USER_ONE)?.orderCount)).toBe(3);
	});
});

describe("composition", () => {
	test("kept() + group + sum filters discarded rows", async () => {
		await seedOrders();
		const cancelled = await Order.where({ status: "cancelled" }).first();
		expect(cancelled).not.toBeNull();
		await cancelled?.discard();

		const sums = await Order.kept().group("userId").sum("total");
		// USER_ONE had 25 in cancelled — kept-only should reflect that
		const byUser = new Map(sums.map((row) => [row.userId, row.sum]));
		// One cancelled row was discarded; total drops accordingly.
		const allSums = sums.reduce((acc, row) => acc + row.sum, 0);
		expect(allSums).toBe(750 - Number(cancelled?.total));
		expect(byUser.size).toBe(3);
	});

	test("recursive CTE + group walks tree then groups", async () => {
		const root = await Page.create({
			parentId: null,
			kind: "folder",
			title: "root",
		});
		const a = await Page.create({
			parentId: root.id,
			kind: "doc",
			title: "A",
		});
		await Page.create({
			parentId: a.id,
			kind: "doc",
			title: "B",
		});
		await Page.create({
			parentId: root.id,
			kind: "folder",
			title: "C",
		});

		const counts = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.group("kind")
			.count();
		const byKind = new Map(counts.map((row) => [row.kind, row.count]));
		expect(byKind.get("folder")).toBe(2); // root + C
		expect(byKind.get("doc")).toBe(2); // A + B
	});

	test("aggregate-active QB used as where-subquery throws", async () => {
		await seedOrders();
		const aggregate = Order.group("userId");
		expect(() =>
			Order.where({
				userId: aggregate as unknown as { [k: symbol]: () => unknown },
			}),
		).toThrow("aggregate-active query cannot be used as a subquery");
	});

	test("materialize-then-use pattern for pseudo-scalar-subquery", async () => {
		await seedOrders();
		const avg = await Order.avg("total");
		expect(avg).not.toBeNull();
		const aboveAvg = await Order.where({
			total: { gt: avg as number },
		}).count();
		// rows above 125: 200, 300 — so 2
		expect(aboveAvg).toBe(2);
	});
});

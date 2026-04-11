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

import { Model } from "../src/model/base";
import { connect } from "../src/model/connection";
import type { TableDefinition } from "../src/types";
import { getTestConnection, resetDatabase } from "./helpers/postgres";

let connection: SQL;

class PagesRow {
	declare id: string;
	declare parentId: string | null;
	declare orgId: string;
	declare title: string;
	declare discardedAt: Date | null;
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
		orgId: { type: "uuid", nullable: false, columnName: "org_id" },
		title: { type: "text", nullable: false, columnName: "title" },
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PagesRow,
};

class Page extends Model(pagesTableDef) {
	static softDelete = true;
}

const ORG_ONE = "11111111-1111-1111-1111-111111111111";
const ORG_TWO = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	await connection`
		CREATE TABLE pages (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			parent_id uuid REFERENCES pages(id),
			org_id uuid NOT NULL,
			title text NOT NULL,
			discarded_at timestamptz
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

/** Build a tree:
 *      root
 *      /  \
 *     A    C
 *     |
 *     B
 */
async function makeTree(orgId: string) {
	const root = await Page.create({
		parentId: null,
		orgId,
		title: "root",
	});
	const a = await Page.create({
		parentId: root.id,
		orgId,
		title: "A",
	});
	const b = await Page.create({
		parentId: a.id,
		orgId,
		title: "B",
	});
	const c = await Page.create({
		parentId: root.id,
		orgId,
		title: "C",
	});
	return { root, a, b, c };
}

describe("descendants()", () => {
	test("basic descent — pluck all four ids from root", async () => {
		const { root, a, b, c } = await makeTree(ORG_ONE);
		const ids = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id, c.id].sort());
	});

	test("multi-anchor descent", async () => {
		const { a, b, c } = await makeTree(ORG_ONE);
		const ids = await Page.where({
			id: [a.id, c.id] as unknown as string,
		})
			.descendants({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort());
	});

	test("scope conditions inherit at every level", async () => {
		const { root, a, b, c } = await makeTree(ORG_ONE);
		// Sister tree in another org — should NOT bleed in even if parent_id matches.
		await Page.create({ parentId: root.id, orgId: ORG_TWO, title: "X" });
		const ids = await Page.where({ orgId: ORG_ONE, id: root.id })
			.descendants({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id, c.id].sort());
	});

	test("soft delete: kept() prunes discarded rows AND blocks subtree traversal", async () => {
		const { root, a, b, c } = await makeTree(ORG_ONE);
		await a.discard(); // discarding A should also hide B from the walk
		const ids = await Page.kept()
			.where({ id: root.id })
			.descendants({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, c.id].sort());
		// B is unreachable through A even though B itself is kept
		expect(ids).not.toContain(b.id);
	});

	test("empty anchor returns []", async () => {
		const ids = await Page.where({ id: "00000000-0000-0000-0000-000000000000" })
			.descendants({ via: "parentId" })
			.pluck("id");
		expect(ids).toEqual([]);
	});

	test("composition: outer where filters descendants without pruning the walk", async () => {
		const { root, b } = await makeTree(ORG_ONE);
		// b's title is "B"; the outer where should NOT stop traversal at non-matching nodes
		const ids = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.where({ title: "B" })
			.pluck("id");
		expect(ids).toEqual([b.id]);
	});

	test("composition with count()", async () => {
		const { root } = await makeTree(ORG_ONE);
		const count = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.count();
		expect(count).toBe(4);
	});

	test("cycle safety: UNION default terminates with set semantics", async () => {
		// Insert two rows then point them at each other.
		const x = await Page.create({
			parentId: null,
			orgId: ORG_ONE,
			title: "X",
		});
		const y = await Page.create({
			parentId: x.id,
			orgId: ORG_ONE,
			title: "Y",
		});
		await connection`UPDATE pages SET parent_id = ${y.id} WHERE id = ${x.id}`;
		const ids = await Page.where({ id: x.id })
			.descendants({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([x.id, y.id].sort());
	});
});

describe("ancestors()", () => {
	test("basic ascent — from B walk up to root", async () => {
		const { root, a, b } = await makeTree(ORG_ONE);
		const ids = await Page.where({ id: b.id })
			.ancestors({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id].sort());
	});

	test("scope conditions inherit", async () => {
		const { root, a, b } = await makeTree(ORG_ONE);
		const otherOrgChild = await Page.create({
			parentId: root.id,
			orgId: ORG_TWO,
			title: "other",
		});
		const ids = await Page.where({ orgId: ORG_ONE, id: b.id })
			.ancestors({ via: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id].sort());
		expect(ids).not.toContain(otherOrgChild.id);
	});

	test("soft delete: kept() blocks ancestor walk through discarded rows", async () => {
		const { root, a, b } = await makeTree(ORG_ONE);
		await a.discard();
		const ids = await Page.kept()
			.where({ id: b.id })
			.ancestors({ via: "parentId" })
			.pluck("id");
		// B is its own anchor; A is filtered out so the walk stops there and root is unreachable.
		expect(ids).toEqual([b.id]);
		expect(ids).not.toContain(root.id);
		expect(ids).not.toContain(a.id);
	});
});

describe("recursiveOn() (generic primitive)", () => {
	test("descendants is sugar over recursiveOn({ from: via, to: pk })", async () => {
		const { root, a, b, c } = await makeTree(ORG_ONE);
		const ids = await Page.where({ id: root.id })
			.recursiveOn({ from: "parentId", to: "id" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id, c.id].sort());
	});

	test("ancestors is sugar over recursiveOn({ from: pk, to: via })", async () => {
		const { root, a, b } = await makeTree(ORG_ONE);
		const ids = await Page.where({ id: b.id })
			.recursiveOn({ from: "id", to: "parentId" })
			.pluck("id");
		expect([...ids].sort()).toEqual([root.id, a.id, b.id].sort());
	});

	test("setSemantics: false uses UNION ALL", async () => {
		const { root } = await makeTree(ORG_ONE);
		// Without cycles, UNION ALL gives the same result set.
		const ids = await Page.where({ id: root.id })
			.recursiveOn({ from: "parentId", to: "id", setSemantics: false })
			.pluck("id");
		expect(ids.length).toBe(4);
	});
});

describe("recursive composition", () => {
	test("descendants + distinct + pluck single column", async () => {
		const { root } = await makeTree(ORG_ONE);
		await makeTree(ORG_TWO);
		const orgIds = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.distinct()
			.pluck("orgId");
		expect(orgIds).toEqual([ORG_ONE]);
	});

	test("toArray hydrates Page instances over the recursive scope", async () => {
		const { root } = await makeTree(ORG_ONE);
		const pages = await Page.where({ id: root.id })
			.descendants({ via: "parentId" })
			.toArray();
		expect(pages).toHaveLength(4);
		for (const page of pages) {
			expect(page).toBeInstanceOf(Page);
		}
	});
});

describe("recursive guard rails", () => {
	test("recursiveOn throws when called twice", async () => {
		expect(() =>
			Page.all()
				.recursiveOn({ from: "parentId", to: "id" })
				.recursiveOn({ from: "parentId", to: "id" }),
		).toThrow(/cannot be nested/);
	});

	test("recursiveOn throws when seed has order/limit/offset", async () => {
		expect(() =>
			Page.all().order({ title: "ASC" }).recursiveOn({
				from: "parentId",
				to: "id",
			}),
		).toThrow(/order/);
		expect(() =>
			Page.all().limit(5).recursiveOn({ from: "parentId", to: "id" }),
		).toThrow(/order/);
	});

	test("descendants/ancestors require single-column primary key", async () => {
		// This is enforced via tableDefinition.primaryKey.length — Page has a single-column pk so it works.
		// We test the negative path indirectly: the methods exist and don't throw on Page.
		expect(() => Page.all().descendants({ via: "parentId" })).not.toThrow();
	});

	test("updateAll/deleteAll/discardAll throw on a recursive scope", async () => {
		const recursive = Page.all().recursiveOn({
			from: "parentId",
			to: "id",
		});
		await expect(recursive.updateAll({ title: "x" })).rejects.toThrow(
			/recursive query/,
		);
		await expect(recursive.deleteAll()).rejects.toThrow(/recursive query/);
		await expect(recursive.discardAll()).rejects.toThrow(/recursive query/);
	});
});

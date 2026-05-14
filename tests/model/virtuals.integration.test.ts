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

class PagesRow {
	declare id: string;
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
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PagesRow,
};

class FollowsRow {
	declare id: string;
	declare userId: string;
	declare pageId: string;
}

const followsTableDef: TableDefinition<FollowsRow> = {
	tableName: "follows",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		userId: { type: "uuid", nullable: false, columnName: "user_id" },
		pageId: { type: "uuid", nullable: false, columnName: "page_id" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: FollowsRow,
};

class Page extends Model(pagesTableDef) {
	following: boolean | null = null;
}

class Follow extends Model(followsTableDef) {}

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	await resetDatabase(connection);
	await connection`
		CREATE TABLE pages (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			title text NOT NULL
		)
	`;
	await connection`
		CREATE TABLE follows (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL,
			page_id uuid NOT NULL REFERENCES pages(id)
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

describe("virtual attributes — SQL alias hydration via findBySql", () => {
	test("EXISTS subquery alias populates a settable virtual", async () => {
		const followed = await Page.create({ title: "followed" });
		await Page.create({ title: "unfollowed" });
		const userId = "00000000-0000-0000-0000-000000000001";
		await Follow.create({ userId, pageId: followed.id });

		const rows = await Page.findBySql(
			`
			SELECT pages.*, EXISTS(
				SELECT 1 FROM follows
				WHERE follows.page_id = pages.id AND follows.user_id = $1
			) AS following
			FROM pages
			ORDER BY title ASC
			`,
			[userId],
		);

		const followedPage = rows.find((page) => page.title === "followed");
		const unfollowedPage = rows.find((page) => page.title === "unfollowed");

		expect(followedPage?.following).toBe(true);
		expect(unfollowedPage?.following).toBe(false);

		expect(followedPage?.toJSON().following).toBe(true);
		expect(unfollowedPage?.toJSON().following).toBe(false);
	});

	test("class field default applies when SQL does not project the alias", async () => {
		await Page.create({ title: "alone" });
		const [page] = await Page.findBySql("SELECT * FROM pages");
		expect(page?.following).toBeNull();
		expect(page?.toJSON().following).toBeNull();
	});
});

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

// --- Row classes ---

class UsersRow {
	declare id: string;
	declare name: string;
	declare email: string;
	declare active: boolean;
}

const usersTableDef: TableDefinition<UsersRow> = {
	tableName: "users",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		name: { type: "text", nullable: false, columnName: "name" },
		email: { type: "text", nullable: false, columnName: "email" },
		active: {
			type: "bool",
			nullable: false,
			default: "true",
			columnName: "active",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: UsersRow,
};

class PostsRow {
	declare id: string;
	declare userId: string;
	declare title: string;
}

const postsTableDef: TableDefinition<PostsRow> = {
	tableName: "posts",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		userId: { type: "uuid", nullable: false, columnName: "user_id" },
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PostsRow,
};

class PagesRow {
	declare id: string;
	declare parentId: string | null;
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
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PagesRow,
};

class User extends Model(usersTableDef) {}
class Post extends Model(postsTableDef) {}
class Page extends Model(pagesTableDef) {}

// --- Setup ---

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
		CREATE TABLE users (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL,
			email text NOT NULL,
			active boolean NOT NULL DEFAULT true
		)
	`;
	await connection`
		CREATE TABLE posts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL REFERENCES users(id),
			title text NOT NULL
		)
	`;
	await connection`
		CREATE TABLE pages (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			parent_id uuid REFERENCES pages(id),
			title text NOT NULL
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- Tests ---

describe("subquery in where()", () => {
	test("basic: QueryBuilder as where value defaults to PK", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		const bob = await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: false,
		});
		await Post.create({ userId: alice.id, title: "P1" });
		await Post.create({ userId: bob.id, title: "P2" });

		const posts = await Post.where({
			userId: User.where({ active: true }),
		}).toArray();

		expect(posts).toHaveLength(1);
		expect(posts[0]?.title).toBe("P1");
	});

	test("{ in: builder } operator form", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: false,
		});
		await Post.create({ userId: alice.id, title: "P1" });

		const posts = await Post.where({
			userId: { in: User.where({ active: true }) },
		}).toArray();

		expect(posts).toHaveLength(1);
		expect(posts[0]?.userId).toBe(alice.id);
	});

	test("{ not_in: builder } excludes matching rows", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		const bob = await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: false,
		});
		await Post.create({ userId: alice.id, title: "P1" });
		await Post.create({ userId: bob.id, title: "P2" });

		const posts = await Post.where({
			userId: { not_in: User.where({ active: true }) },
		}).toArray();

		expect(posts).toHaveLength(1);
		expect(posts[0]?.userId).toBe(bob.id);
	});

	test("inner + outer WHERE params do not collide", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: true,
		});
		await Post.create({ userId: alice.id, title: "target" });
		await Post.create({ userId: alice.id, title: "other" });

		const posts = await Post.where({
			title: "target",
			userId: User.where({ name: "Alice" }),
		}).toArray();

		expect(posts).toHaveLength(1);
		expect(posts[0]?.title).toBe("target");
	});

	test("explicit .select() projection", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		await Post.create({ userId: alice.id, title: "P1" });

		const posts = await Post.where({
			userId: User.where({ active: true }).select("id"),
		}).toArray();

		expect(posts).toHaveLength(1);
	});

	test("no select() defaults to PK", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		await Post.create({ userId: alice.id, title: "P1" });

		// This works because User's PK is single-column "id"
		const posts = await Post.where({
			userId: User.where({ active: true }),
		}).toArray();

		expect(posts).toHaveLength(1);
	});

	test("multi-column select throws", () => {
		const builder = User.all().select("id", "name");
		expect(() => builder.toSQL()).not.toThrow();
		expect(() => Post.where({ userId: builder }).toSQL()).toThrow(
			/exactly one column/,
		);
	});

	test("recursive scope as subquery throws", () => {
		const recursive = Page.all().descendants({ via: "parentId" });
		// as never: intentionally passing a Page scope where a string is expected to test the error
		expect(() => Post.where({ title: recursive } as never).toSQL()).toThrow(
			/recursive query/,
		);
	});

	test("empty inner result returns empty for IN", async () => {
		const posts = await Post.where({
			userId: User.where({ name: "nobody" }),
		}).toArray();

		expect(posts).toHaveLength(0);
	});

	test("subquery inside or group", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		const bob = await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: false,
		});
		await Post.create({ userId: alice.id, title: "special" });
		await Post.create({ userId: bob.id, title: "normal" });

		// as never: WhereConditions can't express subquery values inside or-groups cleanly
		const posts = await Post.where({
			or: [{ userId: User.where({ active: true }) }, { title: "normal" }],
		} as never)
			.order({ title: "ASC" })
			.toArray();

		expect(posts).toHaveLength(2);
	});

	test("inner scope composes with limit/order/distinct", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
			active: true,
		});
		const bob = await User.create({
			name: "Bob",
			email: "bob@test.com",
			active: true,
		});
		await Post.create({ userId: alice.id, title: "P1" });
		await Post.create({ userId: bob.id, title: "P2" });

		// Inner scope with order + limit → only the first active user
		const posts = await Post.where({
			userId: User.where({ active: true }).order({ name: "ASC" }).limit(1),
		}).toArray();

		expect(posts).toHaveLength(1);
		expect(posts[0]?.userId).toBe(alice.id);
	});
});

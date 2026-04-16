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

// --- Row class ---

class PostsRow {
	declare id: string;
	declare title: string;
	declare discardedAt: Date | null;
	declare createdAt: Date;
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
		title: { type: "text", nullable: false, columnName: "title" },
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
		createdAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "created_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PostsRow,
};

class Post extends Model(postsTableDef) {
	static softDelete = true;
}

// Model without soft delete for guard tests
class UsersRow {
	declare id: string;
	declare name: string;
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
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: UsersRow,
};

class User extends Model(usersTableDef) {}

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	await connection`
		CREATE TABLE posts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			title text NOT NULL,
			discarded_at timestamptz,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`
		CREATE TABLE users (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

describe("discard()", () => {
	test("sets discardedAt to a non-null timestamp", async () => {
		const post = await Post.create({ title: "Hello" });
		expect(post.discardedAt).toBeNull();

		await post.discard();
		expect(post.discardedAt).not.toBeNull();
		expect(post.discardedAt).toBeInstanceOf(Date);
	});

	test("marks record as discarded", async () => {
		const post = await Post.create({ title: "Hello" });
		expect(post.isKept).toBe(true);
		expect(post.isDiscarded).toBe(false);

		await post.discard();
		expect(post.isDiscarded).toBe(true);
		expect(post.isKept).toBe(false);
	});

	test("persists to database", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();

		const reloaded = await Post.find(post.id);
		expect(reloaded.discardedAt).not.toBeNull();
	});

	test("snapshot is clean after discard", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();
		expect(post.changed()).toBe(false);
	});

	test("discarding an already-discarded record updates the timestamp", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();
		const firstTimestamp = post.discardedAt;

		// Small delay to ensure different timestamp
		await new Promise((resolve) => setTimeout(resolve, 10));
		await post.discard();
		const secondTimestamp = post.discardedAt;

		expect(secondTimestamp).not.toBeNull();
		expect((secondTimestamp as Date).getTime()).toBeGreaterThanOrEqual(
			(firstTimestamp as Date).getTime(),
		);
	});

	test("throws on model without softDelete enabled", async () => {
		const user = await User.create({ name: "Alice" });
		expect(user.discard()).rejects.toThrow(
			"Cannot discard User: softDelete is not enabled on this model",
		);
	});

	test("throws on non-persisted record", () => {
		const post = new Post({ title: "Hello" });
		expect(post.discard()).rejects.toThrow(
			"Cannot discard a new record. Save it first.",
		);
	});

	test("runs beforeDiscard and afterDiscard callbacks", async () => {
		const callOrder: string[] = [];

		class TrackedPost extends Model(postsTableDef) {
			static softDelete = true;
			static beforeDiscard = [
				() => {
					callOrder.push("beforeDiscard");
				},
			];
			static afterDiscard = [
				() => {
					callOrder.push("afterDiscard");
				},
			];
		}

		const post = await TrackedPost.create({ title: "Hello" });
		await post.discard();

		expect(callOrder).toEqual(["beforeDiscard", "afterDiscard"]);
	});

	test("beforeDiscard throwing aborts the discard", async () => {
		class GuardedPost extends Model(postsTableDef) {
			static softDelete = true;
			static beforeDiscard = [
				() => {
					throw new Error("discard blocked");
				},
			];
		}

		const post = await GuardedPost.create({ title: "Hello" });
		expect(post.discard()).rejects.toThrow("discard blocked");

		const reloaded = await Post.find(post.id);
		expect(reloaded.discardedAt).toBeNull();
	});
});

describe("undiscard()", () => {
	test("clears discardedAt", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();
		expect(post.isDiscarded).toBe(true);

		await post.undiscard();
		expect(post.discardedAt).toBeNull();
		expect(post.isKept).toBe(true);
	});

	test("persists to database", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();
		await post.undiscard();

		const reloaded = await Post.find(post.id);
		expect(reloaded.discardedAt).toBeNull();
	});

	test("snapshot is clean after undiscard", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.discard();
		await post.undiscard();
		expect(post.changed()).toBe(false);
	});

	test("throws on model without softDelete enabled", async () => {
		const user = await User.create({ name: "Alice" });
		expect(user.undiscard()).rejects.toThrow(
			"Cannot undiscard User: softDelete is not enabled on this model",
		);
	});

	test("throws on non-persisted record", () => {
		const post = new Post({ title: "Hello" });
		expect(post.undiscard()).rejects.toThrow(
			"Cannot undiscard a new record. Save it first.",
		);
	});

	test("runs beforeUndiscard and afterUndiscard callbacks", async () => {
		const callOrder: string[] = [];

		class TrackedPost extends Model(postsTableDef) {
			static softDelete = true;
			static beforeUndiscard = [
				() => {
					callOrder.push("beforeUndiscard");
				},
			];
			static afterUndiscard = [
				() => {
					callOrder.push("afterUndiscard");
				},
			];
		}

		const post = await TrackedPost.create({ title: "Hello" });
		await post.discard();
		callOrder.length = 0;
		await post.undiscard();

		expect(callOrder).toEqual(["beforeUndiscard", "afterUndiscard"]);
	});
});

describe("destroy() still hard-deletes", () => {
	test("removes record from database entirely", async () => {
		const post = await Post.create({ title: "Hello" });
		await post.destroy();

		const count = await Post.count();
		expect(count).toBe(0);
	});
});

describe("kept() and discarded() scopes", () => {
	test("kept() returns only non-discarded records", async () => {
		await Post.create({ title: "Active" });
		const discardable = await Post.create({ title: "Discarded" });
		await discardable.discard();

		const kept = await Post.kept();
		expect(kept).toHaveLength(1);
		expect(kept[0]?.title).toBe("Active");
	});

	test("discarded() returns only discarded records", async () => {
		await Post.create({ title: "Active" });
		const discardable = await Post.create({ title: "Discarded" });
		await discardable.discard();

		const discarded = await Post.discarded();
		expect(discarded).toHaveLength(1);
		expect(discarded[0]?.title).toBe("Discarded");
	});

	test("all() returns all records regardless of discard status", async () => {
		await Post.create({ title: "Active" });
		const discardable = await Post.create({ title: "Discarded" });
		await discardable.discard();

		const all = await Post.all();
		expect(all).toHaveLength(2);
	});

	test("kept() chains with where()", async () => {
		await Post.create({ title: "Alpha" });
		await Post.create({ title: "Beta" });
		const discardable = await Post.create({ title: "Alpha" });
		await discardable.discard();

		const results = await Post.kept().where({ title: "Alpha" });
		expect(results).toHaveLength(1);
	});

	test("kept() chains with order() and limit()", async () => {
		await Post.create({ title: "B" });
		await Post.create({ title: "A" });

		const results = await Post.kept()
			.order({ title: "ASC" })
			.limit(1)
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0]?.title).toBe("A");
	});

	test("throws on model without softDelete enabled", () => {
		expect(() => User.kept()).toThrow(
			"Cannot call kept() on User: softDelete is not enabled on this model",
		);
		expect(() => User.discarded()).toThrow(
			"Cannot call discarded() on User: softDelete is not enabled on this model",
		);
	});
});

describe("discardAll() and undiscardAll()", () => {
	test("discardAll() bulk-discards matching records", async () => {
		await Post.create({ title: "Alpha" });
		await Post.create({ title: "Beta" });
		await Post.create({ title: "Alpha" });

		const count = await Post.where({ title: "Alpha" }).discardAll();
		expect(count).toBe(2);

		const discarded = await Post.discarded();
		expect(discarded).toHaveLength(2);

		const kept = await Post.kept();
		expect(kept).toHaveLength(1);
		expect(kept[0]?.title).toBe("Beta");
	});

	test("undiscardAll() bulk-undiscards matching records", async () => {
		const alpha = await Post.create({ title: "Alpha" });
		const beta = await Post.create({ title: "Beta" });
		await alpha.discard();
		await beta.discard();

		const count = await Post.where({ title: "Alpha" }).undiscardAll();
		expect(count).toBe(1);

		const kept = await Post.kept();
		expect(kept).toHaveLength(1);
		expect(kept[0]?.title).toBe("Alpha");
	});

	test("discardAll() without where discards all records", async () => {
		await Post.create({ title: "A" });
		await Post.create({ title: "B" });

		const count = await Post.all().discardAll();
		expect(count).toBe(2);

		const kept = await Post.kept();
		expect(kept).toHaveLength(0);
	});
});

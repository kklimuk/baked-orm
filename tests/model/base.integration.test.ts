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
import {
	connect,
	isInTransaction,
	query,
	transaction,
} from "../../src/model/connection";
import type { IsolationLevel } from "../../src/model/types";
import { hasMany, RecordNotFoundError } from "../../src/model/types";
import type { TableDefinition } from "../../src/types";
import { getTestConnection, resetDatabase } from "../helpers/postgres";

let connection: SQL;

// --- Row classes (simulating generated schema) ---

class UsersRow {
	declare id: string;
	declare name: string;
	declare email: string;
	declare createdAt: Date;
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
	rowClass: UsersRow,
};

class PostsRow {
	declare id: string;
	declare userId: string;
	declare title: string;
	declare body: string | null;
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
		userId: { type: "uuid", nullable: false, columnName: "user_id" },
		title: { type: "text", nullable: false, columnName: "title" },
		body: { type: "text", nullable: true, columnName: "body" },
		createdAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "created_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {
		fk_posts_user_id: {
			columns: ["userId"],
			references: { table: "users", columns: ["id"] },
		},
	},
	rowClass: PostsRow,
};

class CommentsRow {
	declare id: string;
	declare commentableType: string;
	declare commentableId: string;
	declare body: string;
	declare createdAt: Date;
}

const commentsTableDef: TableDefinition<CommentsRow> = {
	tableName: "comments",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		commentableType: {
			type: "text",
			nullable: false,
			columnName: "commentable_type",
		},
		commentableId: {
			type: "uuid",
			nullable: false,
			columnName: "commentable_id",
		},
		body: { type: "text", nullable: false, columnName: "body" },
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
	rowClass: CommentsRow,
};

class TagsRow {
	declare id: string;
	declare name: string;
}

const tagsTableDef: TableDefinition<TagsRow> = {
	tableName: "tags",
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
	rowClass: TagsRow,
};

class TaggingsRow {
	declare id: string;
	declare postId: string;
	declare tagId: string;
}

const taggingsTableDef: TableDefinition<TaggingsRow> = {
	tableName: "taggings",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		postId: { type: "uuid", nullable: false, columnName: "post_id" },
		tagId: { type: "uuid", nullable: false, columnName: "tag_id" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: TaggingsRow,
};

// --- Model classes ---

// Same-file circular models use static properties + declare.
// In separate files, use string-based refs: hasMany<Post>("Post") with import type — no declare needed.
class User extends Model(usersTableDef) {
	static posts = User.hasMany(() => Post);
	static comments = User.hasMany(() => Comment, { as: "commentable" });
	declare posts: Post[];
	declare comments: Comment[];
}

class Post extends Model(postsTableDef) {
	static author = Post.belongsTo(() => User, { foreignKey: "userId" });
	static comments = Post.hasMany(() => Comment, { as: "commentable" });
	static taggings = Post.hasMany(() => Tagging);
	static tags = Post.hasManyThrough(() => Tag, { through: "taggings" });
	declare author: User | null;
	declare comments: Comment[];
	declare taggings: Tagging[];
	declare tags: Tag[];
}

class Comment extends Model(commentsTableDef) {
	static commentable = Comment.belongsTo({ polymorphic: true });
	declare commentable: Post | User | null;
}

class Tag extends Model(tagsTableDef) {}
class Tagging extends Model(taggingsTableDef) {}

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
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`CREATE UNIQUE INDEX idx_users_email ON users (email)`;
	await connection`
		CREATE TABLE posts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL REFERENCES users(id),
			title text NOT NULL,
			body text,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`
		CREATE TABLE comments (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			commentable_type text NOT NULL,
			commentable_id uuid NOT NULL,
			body text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`
		CREATE TABLE tags (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL
		)
	`;
	await connection`
		CREATE TABLE taggings (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			post_id uuid NOT NULL REFERENCES posts(id),
			tag_id uuid NOT NULL REFERENCES tags(id)
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- Tests ---

describe("Model CRUD", () => {
	test("create inserts a record and returns instance with id", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		expect(user.name).toBe("Alice");
		expect(user.email).toBe("alice@test.com");
		expect(user.id).toBeDefined();
		expect(user.createdAt).toBeInstanceOf(Date);
		expect(user.isNewRecord).toBe(false);
	});

	test("find returns an existing record", async () => {
		const created = await User.create({
			name: "Bob",
			email: "bob@test.com",
		});
		const found = await User.find(created.id);
		expect(found.name).toBe("Bob");
		expect(found.email).toBe("bob@test.com");
		expect(found.isNewRecord).toBe(false);
	});

	test("find throws RecordNotFoundError for missing record", async () => {
		expect(
			User.find("00000000-0000-0000-0000-000000000000"),
		).rejects.toBeInstanceOf(RecordNotFoundError);
	});

	test("findBy returns matching record or null", async () => {
		await User.create({ name: "Charlie", email: "charlie@test.com" });
		const found = await User.findBy({ email: "charlie@test.com" });
		expect(found).not.toBeNull();
		expect(found?.name).toBe("Charlie");

		const missing = await User.findBy({ email: "nobody@test.com" });
		expect(missing).toBeNull();
	});

	test("update modifies an existing record", async () => {
		const user = await User.create({
			name: "Dave",
			email: "dave@test.com",
		});
		await user.update({ name: "David" });
		expect(user.name).toBe("David");

		const reloaded = await User.find(user.id);
		expect(reloaded.name).toBe("David");
	});

	test("destroy deletes the record", async () => {
		const user = await User.create({
			name: "Eve",
			email: "eve@test.com",
		});
		const userId = user.id;
		await user.destroy();
		expect(user.isNewRecord).toBe(true);

		const found = await User.findBy({ id: userId });
		expect(found).toBeNull();
	});

	test("save inserts new record and updates existing", async () => {
		const user = new User({ name: "Frank", email: "frank@test.com" });
		expect(user.isNewRecord).toBe(true);

		await user.save();
		expect(user.isNewRecord).toBe(false);
		expect(user.id).toBeDefined();

		user.name = "Franklin";
		await user.save();

		const reloaded = await User.find(user.id);
		expect(reloaded.name).toBe("Franklin");
	});

	test("reload refreshes instance from database", async () => {
		const user = await User.create({
			name: "Grace",
			email: "grace@test.com",
		});
		await connection`UPDATE users SET name = 'Gracie' WHERE id = ${user.id}`;
		await user.reload();
		expect(user.name).toBe("Gracie");
	});

	test("toJSON returns plain object with column values", async () => {
		const user = await User.create({
			name: "Heidi",
			email: "heidi@test.com",
		});
		const json = user.toJSON();
		expect(json.name).toBe("Heidi");
		expect(json.email).toBe("heidi@test.com");
		expect(json.id).toBeDefined();
	});
});

describe("Model mass operations", () => {
	test("createMany inserts multiple records", async () => {
		const users = await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
		]);
		expect(users).toHaveLength(3);
		expect(users[0]?.name).toBe("Alice");
		expect(users[1]?.name).toBe("Bob");
		expect(users[2]?.name).toBe("Charlie");
		for (const user of users) {
			expect(user.id).toBeDefined();
			expect(user.isNewRecord).toBe(false);
		}
	});

	test("createMany returns empty array for empty input", async () => {
		const users = await User.createMany([]);
		expect(users).toHaveLength(0);
	});

	test("upsert inserts new record", async () => {
		const user = await User.upsert(
			{ name: "Alice", email: "alice@test.com" },
			{ conflict: { columns: ["email"] } },
		);
		expect(user.name).toBe("Alice");
		expect(user.id).toBeDefined();
	});
});

describe("QueryBuilder", () => {
	test("where filters records", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		const results = await User.where({ name: "Alice" });
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe("Alice");
	});

	test("order sorts results", async () => {
		await User.createMany([
			{ name: "Charlie", email: "charlie@test.com" },
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		const results = await User.order({ name: "ASC" }).toArray();
		expect(results[0]?.name).toBe("Alice");
		expect(results[1]?.name).toBe("Bob");
		expect(results[2]?.name).toBe("Charlie");
	});

	test("limit and offset paginate results", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
		]);
		const page = await User.order({ name: "ASC" }).limit(2).offset(1).toArray();
		expect(page).toHaveLength(2);
		expect(page[0]?.name).toBe("Bob");
		expect(page[1]?.name).toBe("Charlie");
	});

	test("count returns number of matching records", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		const count = await User.count();
		expect(count).toBe(2);
	});

	test("exists returns boolean", async () => {
		expect(await User.exists({ name: "Nobody" })).toBe(false);
		await User.create({ name: "Alice", email: "alice@test.com" });
		expect(await User.exists({ name: "Alice" })).toBe(true);
	});

	test("first and last return single records", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		const first = await User.first();
		expect(first).not.toBeNull();

		const last = await User.last();
		expect(last).not.toBeNull();
	});

	test("where with null checks IS NULL", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1", body: null });
		await Post.create({ userId: user.id, title: "Post 2", body: "content" });

		const nullBody = await Post.where({ body: null }).toArray();
		expect(nullBody).toHaveLength(1);
		expect(nullBody[0]?.title).toBe("Post 1");
	});

	test("whereRaw supports raw SQL fragments", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		const results = await User.whereRaw('"name" LIKE $1', ["%lic%"]).toArray();
		expect(results).toHaveLength(1);
		expect(results[0]?.name).toBe("Alice");
	});

	test("updateAll updates matching records in bulk", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		await User.where({ name: "Alice" }).updateAll({ name: "Alicia" });
		const found = await User.findBy({ email: "alice@test.com" });
		expect(found?.name).toBe("Alicia");
	});

	test("deleteAll removes matching records", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		await User.where({ name: "Alice" }).deleteAll();
		const count = await User.count();
		expect(count).toBe(1);
	});

	test("chaining works with await (thenable)", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		const results = await User.where({ name: "Alice" }).limit(1);
		expect(results).toHaveLength(1);
	});
});

describe("pluck and distinct", () => {
	test("pluck returns single column as flat array", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });
		const emails = await User.all().order({ email: "ASC" }).pluck("email");
		expect(emails).toEqual(["alice@test.com", "bob@test.com"]);
	});

	test("pluck respects where", async () => {
		const alice = await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });
		const ids = await User.where({ name: "Alice" }).pluck("id");
		expect(ids).toEqual([alice.id]);
	});

	test("pluck with multiple columns returns tuples", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });
		const rows = await User.all()
			.order({ email: "ASC" })
			.pluck("name", "email");
		expect(rows).toEqual([
			["Alice", "alice@test.com"],
			["Bob", "bob@test.com"],
		]);
	});

	test("pluck on empty result returns []", async () => {
		const ids = await User.where({ name: "nobody" }).pluck("id");
		expect(ids).toEqual([]);
	});

	test("pluck respects order and limit", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });
		await User.create({ name: "Carol", email: "carol@test.com" });
		const names = await User.all()
			.order({ name: "ASC" })
			.limit(2)
			.pluck("name");
		expect(names).toEqual(["Alice", "Bob"]);
	});

	test("distinct deduplicates rows", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const bob = await User.create({ name: "Bob", email: "bob@test.com" });
		await Post.create({ userId: alice.id, title: "P1", body: null });
		await Post.create({ userId: alice.id, title: "P2", body: null });
		await Post.create({ userId: bob.id, title: "P3", body: null });

		const userIds = await Post.all().distinct().pluck("userId");
		expect(userIds.sort()).toEqual([alice.id, bob.id].sort());
	});

	test("pluck snake_case columns map back to camelCase by db column", async () => {
		const alice = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: alice.id, title: "P1", body: null });
		const userIds = await Post.all().pluck("userId");
		expect(userIds).toEqual([alice.id]);
	});
});

describe("Transactions", () => {
	test("transaction commits on success", async () => {
		await transaction(async () => {
			await User.create({ name: "Alice", email: "alice@test.com" });
			await User.create({ name: "Bob", email: "bob@test.com" });
		});
		const count = await User.count();
		expect(count).toBe(2);
	});

	test("transaction rolls back on error", async () => {
		try {
			await transaction(async () => {
				await User.create({ name: "Alice", email: "alice@test.com" });
				throw new Error("Rollback test");
			});
		} catch {
			// expected
		}
		const count = await User.count();
		expect(count).toBe(0);
	});

	test("nested transaction commits both inner and outer", async () => {
		await transaction(async () => {
			await User.create({ name: "Alice", email: "alice@test.com" });
			await transaction(async () => {
				await User.create({ name: "Bob", email: "bob@test.com" });
			});
		});
		const count = await User.count();
		expect(count).toBe(2);
	});

	test("nested transaction rolls back inner only on inner error", async () => {
		await transaction(async () => {
			await User.create({ name: "Alice", email: "alice@test.com" });
			try {
				await transaction(async () => {
					await User.create({ name: "Bob", email: "bob@test.com" });
					throw new Error("rollback inner only");
				});
			} catch {
				// expected — inner rolled back
			}
			const count = await User.count();
			expect(count).toBe(1);
		});
		const count = await User.count();
		expect(count).toBe(1);
	});

	test("nested transaction — outer error rolls back everything", async () => {
		try {
			await transaction(async () => {
				await User.create({ name: "Alice", email: "alice@test.com" });
				await transaction(async () => {
					await User.create({ name: "Bob", email: "bob@test.com" });
				});
				throw new Error("rollback outer");
			});
		} catch {
			// expected
		}
		const count = await User.count();
		expect(count).toBe(0);
	});

	test("supports multiple levels of nesting", async () => {
		await transaction(async () => {
			await User.create({ name: "Alice", email: "alice@test.com" });
			await transaction(async () => {
				await User.create({ name: "Bob", email: "bob@test.com" });
				await transaction(async () => {
					await User.create({
						name: "Charlie",
						email: "charlie@test.com",
					});
				});
			});
		});
		const count = await User.count();
		expect(count).toBe(3);
	});

	test("isInTransaction returns true inside nested transaction", async () => {
		expect(isInTransaction()).toBe(false);
		await transaction(async () => {
			expect(isInTransaction()).toBe(true);
			await transaction(async () => {
				expect(isInTransaction()).toBe(true);
			});
		});
	});

	test("transaction with isolation level serializable", async () => {
		await transaction({ isolation: "serializable" }, async () => {
			const [row] = await query<{ transaction_isolation: string }>(
				"SHOW transaction_isolation",
			);
			expect(row?.transaction_isolation).toBe("serializable");
		});
	});

	test("transaction with isolation level repeatable read", async () => {
		await transaction({ isolation: "repeatable read" }, async () => {
			const [row] = await query<{ transaction_isolation: string }>(
				"SHOW transaction_isolation",
			);
			expect(row?.transaction_isolation).toBe("repeatable read");
		});
	});

	test("transaction with isolation level read committed", async () => {
		await transaction({ isolation: "read committed" }, async () => {
			const [row] = await query<{ transaction_isolation: string }>(
				"SHOW transaction_isolation",
			);
			expect(row?.transaction_isolation).toBe("read committed");
		});
	});

	test("isolation level on nested transaction throws", async () => {
		await transaction(async () => {
			await expect(
				transaction({ isolation: "serializable" }, async () => {
					await User.create({ name: "Alice", email: "alice@test.com" });
				}),
			).rejects.toThrow("Isolation level cannot be set on nested transactions");
		});
	});

	test("invalid isolation level throws", async () => {
		await expect(
			transaction({ isolation: "snapshot" as IsolationLevel }, async () => {
				await User.create({ name: "Alice", email: "alice@test.com" });
			}),
		).rejects.toThrow('Invalid isolation level "snapshot"');
	});

	test("transaction stores do not leak between calls", async () => {
		// Transaction A rolls back — its store must not leak into B.
		try {
			await transaction(async () => {
				await User.create({ name: "A", email: "a@test.com" });
				expect(isInTransaction()).toBe(true);
				throw new Error("rollback A");
			});
		} catch {
			// expected
		}

		// Store is properly cleaned up after A
		expect(isInTransaction()).toBe(false);

		// Transaction B uses its own store — A's rollback has no effect
		await transaction(async () => {
			expect(isInTransaction()).toBe(true);
			await User.create({ name: "B", email: "b@test.com" });
		});

		// Store cleaned up after B too
		expect(isInTransaction()).toBe(false);

		// Only B's record survived
		const count = await User.count();
		expect(count).toBe(1);
		const user = await User.first();
		expect(user?.name).toBe("B");
	});

	test("concurrent transactions have isolated stores", async () => {
		// Barrier: both transactions signal after INSERT, then wait for
		// the other — guarantees true interleaving without sleeps.
		let signalA: () => void;
		let signalB: () => void;
		const barrierA = new Promise<void>((resolve) => {
			signalA = resolve;
		});
		const barrierB = new Promise<void>((resolve) => {
			signalB = resolve;
		});

		// If AsyncLocalStorage leaked, A's rollback would affect B's connection.
		const transactionA = transaction(async () => {
			await User.create({ name: "A", email: "a@test.com" });
			signalA();
			await barrierB;
			throw new Error("rollback A");
		}).catch(() => {});

		const transactionB = transaction(async () => {
			await User.create({ name: "B", email: "b@test.com" });
			signalB();
			await barrierA;
		});

		await Promise.all([transactionA, transactionB]);

		// A rolled back, B committed — only B's record survives
		const count = await User.count();
		expect(count).toBe(1);
		const user = await User.first();
		expect(user?.name).toBe("B");
	});
});

describe("Associations", () => {
	test("hasMany loads related records", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1" });
		await Post.create({ userId: user.id, title: "Post 2" });

		const posts = await user.load("posts");
		expect(posts).toHaveLength(2);
		expect(posts.map((post) => post.title).sort()).toEqual([
			"Post 1",
			"Post 2",
		]);
	});

	test("belongsTo loads parent record", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });

		const author = await post.load("author");
		expect(author).not.toBeNull();
		expect(author?.name).toBe("Alice");
	});

	test("polymorphic belongsTo loads correct type", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });

		const comment = await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Great post!",
		});

		const commentable = await comment.load("commentable");
		expect(commentable).not.toBeNull();
		expect((commentable as Post).title).toBe("Post 1");
	});

	test("polymorphic hasMany loads records", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });

		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Comment 1",
		});
		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Comment 2",
		});

		const comments = await post.load("comments");
		expect(comments).toHaveLength(2);
	});

	test("hasManyThrough loads through join table", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });
		const tag1 = await Tag.create({ name: "typescript" });
		const tag2 = await Tag.create({ name: "bun" });
		await Tagging.create({ postId: post.id, tagId: tag1.id });
		await Tagging.create({ postId: post.id, tagId: tag2.id });

		const tags = await post.load("tags");
		expect(tags).toHaveLength(2);
		expect(tags.map((tag) => tag.name).sort()).toEqual(["bun", "typescript"]);
	});
});

describe("Eager loading", () => {
	test("includes preloads hasMany associations", async () => {
		const user1 = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const user2 = await User.create({
			name: "Bob",
			email: "bob@test.com",
		});
		await Post.create({ userId: user1.id, title: "Alice Post 1" });
		await Post.create({ userId: user1.id, title: "Alice Post 2" });
		await Post.create({ userId: user2.id, title: "Bob Post 1" });

		const users = await User.all().includes("posts").toArray();
		expect(users).toHaveLength(2);

		// load() returns cached data from includes() — no extra query
		const alice = users.find((user) => user.name === "Alice");
		const bob = users.find((user) => user.name === "Bob");
		const alicePosts = await alice?.load("posts");
		const bobPosts = await bob?.load("posts");
		expect(alicePosts).toHaveLength(2);
		expect(bobPosts).toHaveLength(1);
	});

	test("includes preloads belongsTo associations", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1" });
		await Post.create({ userId: user.id, title: "Post 2" });

		const posts = await Post.all().includes("author").toArray();
		expect(posts).toHaveLength(2);

		for (const post of posts) {
			const author = await post.load("author");
			expect(author).not.toBeNull();
			expect(author?.name).toBe("Alice");
		}
	});

	test("includes preloads polymorphic belongsTo associations", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });

		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Comment on post",
		});
		await Comment.create({
			commentableType: "User",
			commentableId: user.id,
			body: "Comment on user",
		});

		const comments = await Comment.all().includes("commentable").toArray();
		expect(comments).toHaveLength(2);

		const postComment = comments.find(
			(comment) => comment.body === "Comment on post",
		);
		const userComment = comments.find(
			(comment) => comment.body === "Comment on user",
		);

		expect(postComment?.commentable).not.toBeNull();
		expect((postComment?.commentable as Post).title).toBe("Post 1");

		expect(userComment?.commentable).not.toBeNull();
		expect((userComment?.commentable as User).name).toBe("Alice");
	});
});

describe("Nested eager loading", () => {
	test("includes with dotted path: hasMany -> belongsTo", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1" });
		await Post.create({ userId: user.id, title: "Post 2" });

		const alice = await User.all().includes("posts.author").first();
		expect(alice).not.toBeNull();
		expect(alice?.posts).toHaveLength(2);
		for (const post of alice?.posts ?? []) {
			expect(post.author).not.toBeNull();
			expect(post.author?.name).toBe("Alice");
		}
	});

	test("includes with dotted path: hasMany -> hasMany (polymorphic)", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });
		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Great post!",
		});
		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Thanks!",
		});

		const alice = await User.all().includes("posts.comments").first();
		expect(alice).not.toBeNull();
		expect(alice?.posts).toHaveLength(1);
		expect(alice?.posts.at(0)?.comments).toHaveLength(2);
	});

	test("multiple nested paths in one call", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });
		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Nice!",
		});

		const alice = await User.all()
			.includes("posts.comments", "posts.author")
			.first();
		expect(alice).not.toBeNull();
		const firstPost = alice?.posts.at(0);
		expect(alice?.posts).toHaveLength(1);
		expect(firstPost?.comments).toHaveLength(1);
		expect(firstPost?.author).not.toBeNull();
		expect(firstPost?.author?.name).toBe("Alice");
	});

	test("mixed shallow and nested includes", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		const post = await Post.create({ userId: user.id, title: "Post 1" });
		await Comment.create({
			commentableType: "Post",
			commentableId: post.id,
			body: "Comment!",
		});

		const firstPost = await Post.all().includes("author", "comments").first();
		expect(firstPost).not.toBeNull();
		expect(firstPost?.author).not.toBeNull();
		expect(firstPost?.comments).toHaveLength(1);
	});

	test("nested includes with empty results at child level", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1" });

		const alice = await User.all().includes("posts.comments").first();
		expect(alice).not.toBeNull();
		expect(alice?.posts).toHaveLength(1);
		expect(alice?.posts.at(0)?.comments).toEqual([]);
	});

	test("nested includes: belongsTo -> hasMany", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Post.create({ userId: user.id, title: "Post 1" });
		await Post.create({ userId: user.id, title: "Post 2" });

		const firstPost = await Post.all().includes("author.posts").first();
		expect(firstPost).not.toBeNull();
		expect(firstPost?.author).not.toBeNull();
		expect(firstPost?.author?.posts).toHaveLength(2);
	});
});

describe("String-based association refs — no declare needed", () => {
	// String-based model refs resolve from the registry at runtime.
	// Combined with import type, this avoids circular imports entirely.
	class Article extends Model(postsTableDef) {}

	class Author extends Model(usersTableDef, {
		articles: hasMany<Article>("Article"),
	}) {}

	test("load() returns correctly typed associations", async () => {
		const author = await Author.create({
			name: "Alice",
			email: "alice@test.com",
		});
		await Article.create({ userId: author.id, title: "Post 1" });
		await Article.create({ userId: author.id, title: "Post 2" });

		// author.load("articles") returns Promise<Article[]> — no cast needed
		const articles = await author.load("articles");
		expect(articles).toHaveLength(2);
		expect(articles[0]?.title).toBe("Post 1");
	});
});

describe("Query logging", () => {
	test("onQuery callback receives query text and duration", async () => {
		const logs: { text: string; durationMs: number }[] = [];

		await connect(connection, {
			onQuery: (entry) => logs.push(entry),
		});

		try {
			await User.create({ name: "Alice", email: "alice@test.com" });
			expect(logs.length).toBeGreaterThan(0);
			expect(logs[0]?.text).toContain("INSERT INTO");
			expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(0);
		} finally {
			// Reset to connection without logger
			await connect(connection);
		}
	});
});

describe("Batch operations", () => {
	test("findEach iterates through all records in batches", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
			{ name: "Dave", email: "dave@test.com" },
			{ name: "Eve", email: "eve@test.com" },
		]);

		const names: string[] = [];
		for await (const user of User.all().findEach({ batchSize: 2 })) {
			names.push(user.name);
		}

		expect(names).toHaveLength(5);
	});

	test("findInBatches yields batches of records", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
			{ name: "Dave", email: "dave@test.com" },
			{ name: "Eve", email: "eve@test.com" },
		]);

		const batchSizes: number[] = [];
		for await (const batch of User.all().findInBatches({ batchSize: 2 })) {
			batchSizes.push(batch.length);
		}

		expect(batchSizes).toEqual([2, 2, 1]);
	});

	test("findEach respects where conditions", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
		]);

		const names: string[] = [];
		for await (const user of User.where({ name: "Alice" }).findEach()) {
			names.push(user.name);
		}

		expect(names).toEqual(["Alice"]);
	});
});

describe("Dirty tracking", () => {
	test("changed() returns false for freshly loaded record", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		const user = await User.find(
			(await User.findBy({ email: "alice@test.com" }))?.id,
		);
		expect(user.changed()).toBe(false);
	});

	test("changed() returns true after modifying a field", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		expect(user.changed()).toBe(false);
		user.name = "Alicia";
		expect(user.changed()).toBe(true);
	});

	test("changed(fieldName) detects specific field changes", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		user.name = "Alicia";
		expect(user.changed("name")).toBe(true);
		expect(user.changed("email")).toBe(false);
	});

	test("changedAttributes() returns was/now values", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		user.name = "Alicia";
		const changes = user.changedAttributes();
		expect(changes.name).toEqual({ was: "Alice", now: "Alicia" });
		expect(changes.email).toBeUndefined();
	});

	test("changed() resets to false after save", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		user.name = "Alicia";
		expect(user.changed()).toBe(true);
		await user.save();
		expect(user.changed()).toBe(false);
	});

	test("save() with no changes skips UPDATE", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });

		const queries: string[] = [];
		await connect(connection, {
			onQuery: ({ text }) => {
				queries.push(text);
			},
		});

		await user.save();
		const updateQueries = queries.filter((query) => query.startsWith("UPDATE"));
		expect(updateQueries).toHaveLength(0);
	});

	test("save() with one changed field only sends that column", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });

		const queries: string[] = [];
		await connect(connection, {
			onQuery: ({ text }) => {
				queries.push(text);
			},
		});

		user.name = "Alicia";
		await user.save();

		const updateQuery = queries.find((query) => query.startsWith("UPDATE"));
		expect(updateQuery).toBeDefined();
		expect(updateQuery).toContain('"name"');
		expect(updateQuery).not.toContain('"email"');
	});

	test("changed() resets after reload", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		user.name = "Modified";
		expect(user.changed()).toBe(true);
		await user.reload();
		expect(user.changed()).toBe(false);
		expect(user.name).toBe("Alice");
	});

	test("new records report all set attributes as changed", () => {
		const user = new User({ name: "Alice", email: "alice@test.com" });
		expect(user.changed()).toBe(true);
		expect(user.changed("name")).toBe(true);
		expect(user.changed("email")).toBe(true);
	});

	test("changedAttributes() is empty after create", async () => {
		const user = await User.create({ name: "Alice", email: "alice@test.com" });
		expect(user.changedAttributes()).toEqual({});
	});
});

describe("where() operator forms", () => {
	beforeEach(async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@example.com" },
			{ name: "Bob", email: "bob@example.com" },
			{ name: "Carol", email: "carol@other.com" },
			{ name: "Dave", email: "dave@example.com" },
		]);
	});

	test("array value emits IN — typecheck-clean without casts", async () => {
		const ids: string[] = (
			await User.where({ name: "Alice" }).pluck("id")
		).concat(await User.where({ name: "Bob" }).pluck("id"));
		const matched = await User.where({ id: ids }).order({ name: "ASC" });
		expect(matched.map((user) => user.name)).toEqual(["Alice", "Bob"]);
	});

	test("empty array IN matches nothing (FALSE)", async () => {
		const count = await User.where({ id: [] }).count();
		expect(count).toBe(0);
	});

	test("eq operator", async () => {
		const found = await User.where({ name: { eq: "Alice" } }).first();
		expect(found?.email).toBe("alice@example.com");
	});

	test("ne operator", async () => {
		const others = await User.where({ name: { ne: "Alice" } }).order({
			name: "ASC",
		});
		expect(others.map((user) => user.name)).toEqual(["Bob", "Carol", "Dave"]);
	});

	test("ne operator with null becomes IS NOT NULL", async () => {
		const alice = await User.findBy({ name: "Alice" });
		if (!alice) throw new Error("expected Alice to exist");
		await Post.create({ userId: alice.id, title: "p1", body: "filled" });
		await Post.create({ userId: alice.id, title: "p2", body: null });
		const withBody = await Post.where({ body: { ne: null } }).order({
			title: "ASC",
		});
		expect(withBody.map((post) => post.title)).toEqual(["p1"]);
	});

	test("eq operator with null becomes IS NULL", async () => {
		const alice = await User.findBy({ name: "Alice" });
		if (!alice) throw new Error("expected Alice to exist");
		await Post.create({ userId: alice.id, title: "p1", body: "filled" });
		await Post.create({ userId: alice.id, title: "p2", body: null });
		const withoutBody = await Post.where({ body: { eq: null } });
		expect(withoutBody.map((post) => post.title)).toEqual(["p2"]);
	});

	test("gt / gte / lt / lte on text comparisons", async () => {
		const after = await User.where({ name: { gt: "Bob" } }).order({
			name: "ASC",
		});
		expect(after.map((user) => user.name)).toEqual(["Carol", "Dave"]);

		const inclusive = await User.where({ name: { gte: "Bob" } }).order({
			name: "ASC",
		});
		expect(inclusive.map((user) => user.name)).toEqual([
			"Bob",
			"Carol",
			"Dave",
		]);

		const before = await User.where({ name: { lt: "Carol" } }).order({
			name: "ASC",
		});
		expect(before.map((user) => user.name)).toEqual(["Alice", "Bob"]);

		const beforeInclusive = await User.where({ name: { lte: "Bob" } }).order({
			name: "ASC",
		});
		expect(beforeInclusive.map((user) => user.name)).toEqual(["Alice", "Bob"]);
	});

	test("multi-operator on same column ANDs (range query)", async () => {
		const range = await User.where({
			name: { gte: "B", lt: "D" },
		}).order({ name: "ASC" });
		expect(range.map((user) => user.name)).toEqual(["Bob", "Carol"]);
	});

	test("in / not_in operators", async () => {
		const matches = await User.where({
			name: { in: ["Alice", "Carol"] },
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Alice", "Carol"]);

		const excluded = await User.where({
			name: { not_in: ["Alice", "Carol"] },
		}).order({ name: "ASC" });
		expect(excluded.map((user) => user.name)).toEqual(["Bob", "Dave"]);
	});

	test("not_in with empty array matches everything", async () => {
		const all = await User.where({ id: { not_in: [] } });
		expect(all).toHaveLength(4);
	});

	test("like operator", async () => {
		const matches = await User.where({
			email: { like: "%@example.com" },
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Alice", "Bob", "Dave"]);
	});

	test("ilike operator (case-insensitive)", async () => {
		const matches = await User.where({ name: { ilike: "ALICE" } });
		expect(matches.map((user) => user.name)).toEqual(["Alice"]);
	});

	test("contains / starts_with / ends_with sugar", async () => {
		const containing = await User.where({ email: { contains: "ali" } });
		expect(containing.map((user) => user.name)).toEqual(["Alice"]);

		const starts = await User.where({ name: { starts_with: "Ca" } });
		expect(starts.map((user) => user.name)).toEqual(["Carol"]);

		const ends = await User.where({ email: { ends_with: "other.com" } });
		expect(ends.map((user) => user.name)).toEqual(["Carol"]);
	});

	test("scalar + operator on the same call ANDs them", async () => {
		const matches = await User.where({
			name: { gte: "Bob" },
			email: { ilike: "%@example.com" },
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Bob", "Dave"]);
	});

	test("camelCase column names resolve to snake_case in operators", async () => {
		const cutoff = new Date(Date.now() - 60_000);
		const recent = await User.where({ createdAt: { gt: cutoff } });
		expect(recent.length).toBeGreaterThanOrEqual(4);
	});

	test("Date equality round-trips on timestamptz columns", async () => {
		const alice = await User.findBy({ name: "Alice" });
		if (!alice) throw new Error("expected Alice to exist");
		const exact = await User.where({ createdAt: alice.createdAt });
		expect(exact.map((user) => user.name)).toContain("Alice");
	});

	test("Date IN round-trips on timestamptz columns", async () => {
		const alice = await User.findBy({ name: "Alice" });
		if (!alice) throw new Error("expected Alice to exist");
		const matched = await User.where({
			createdAt: [alice.createdAt],
		});
		expect(matched.map((user) => user.name)).toContain("Alice");
	});

	test("Date ne operator round-trips on timestamptz columns", async () => {
		// Insert a user with an explicit distinct created_at so ne can differentiate
		await connection`
			INSERT INTO users (id, name, email, created_at)
			VALUES (gen_random_uuid(), 'Eve', 'eve@example.com', now() + interval '1 hour')
		`;
		const eve = await User.findBy({ name: "Eve" });
		if (!eve) throw new Error("expected Eve to exist");
		const others = await User.where({
			createdAt: { ne: eve.createdAt },
		});
		expect(others.map((user) => user.name)).not.toContain("Eve");
		expect(others.length).toBe(4);
	});

	test("empty operator object on non-JSON column produces no clause", async () => {
		const all = await User.where({ name: {} });
		expect(all).toHaveLength(4);
	});

	test("or grouping joins clauses with OR", async () => {
		const matches = await User.where({
			or: [{ name: { ilike: "%alice%" } }, { email: { ilike: "%other.com" } }],
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Alice", "Carol"]);
	});

	test("or with multi-key children", async () => {
		const matches = await User.where({
			or: [{ name: "Alice", email: "alice@example.com" }, { name: "Bob" }],
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Alice", "Bob"]);
	});

	test("or with multi-operator child (range inside OR)", async () => {
		const matches = await User.where({
			or: [
				{ name: { gte: "B", lt: "D" } },
				{ email: { ilike: "%@other.com" } },
			],
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Bob", "Carol"]);
	});

	test("nested or inside top-level AND keeps param numbering correct", async () => {
		const matches = await User.where({
			email: { ilike: "%@example.com" },
			or: [{ name: "Alice" }, { name: "Dave" }],
		}).order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Alice", "Dave"]);
	});

	test("operators compose with whereRaw via consistent param numbering", async () => {
		const matches = await User.where({ name: { gt: "Bob" } })
			.whereRaw(`"email" LIKE $1`, ["%example%"])
			.order({ name: "ASC" });
		expect(matches.map((user) => user.name)).toEqual(["Dave"]);
	});

	test("findBy accepts operator forms", async () => {
		const found = await User.findBy({ name: { ilike: "alice" } });
		expect(found?.email).toBe("alice@example.com");
	});

	test("exists accepts operator forms", async () => {
		expect(await User.exists({ name: { in: ["Alice", "Bob"] } })).toBe(true);
		expect(await User.exists({ name: { in: ["Nope"] } })).toBe(false);
	});
});

describe("findBySql", () => {
	test("returns hydrated model instances", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });

		const users = await User.findBySql("SELECT * FROM users ORDER BY name");
		expect(users).toHaveLength(2);
		expect(users[0]?.name).toBe("Alice");
		expect(users[1]?.name).toBe("Bob");
		expect(users[0]?.isNewRecord).toBe(false);
		expect(users[0]).toBeInstanceOf(User);
	});

	test("supports parameterized queries", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });

		const users = await User.findBySql("SELECT * FROM users WHERE name = $1", [
			"Bob",
		]);
		expect(users).toHaveLength(1);
		expect(users[0]?.email).toBe("bob@test.com");
	});

	test("returns empty array when no rows match", async () => {
		const users = await User.findBySql("SELECT * FROM users WHERE name = $1", [
			"nobody",
		]);
		expect(users).toEqual([]);
	});

	test("maps snake_case columns to camelCase fields", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });

		const users = await User.findBySql("SELECT * FROM users LIMIT 1");
		expect(users[0]?.createdAt).toBeInstanceOf(Date);
	});

	test("returned instances support save and dirty tracking", async () => {
		const created = await User.create({
			name: "Alice",
			email: "alice@test.com",
		});

		const users = await User.findBySql("SELECT * FROM users WHERE id = $1", [
			created.id,
		]);
		const user = users[0];
		expect(user?.changed()).toBe(false);

		if (user) user.name = "Updated";
		expect(user?.changed()).toBe(true);

		await user?.save();
		const reloaded = await User.find(created.id);
		expect(reloaded.name).toBe("Updated");
	});

	test("is transaction-aware", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });

		await transaction(async () => {
			await User.create({ name: "Bob", email: "bob@test.com" });
			const users = await User.findBySql("SELECT * FROM users ORDER BY name");
			expect(users).toHaveLength(2);
		});
	});
});

describe("query", () => {
	test("returns plain objects", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });

		const rows = await query("SELECT name, email FROM users");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ name: "Alice", email: "alice@test.com" });
		expect(rows[0]).not.toBeInstanceOf(User);
	});

	test("supports parameterized queries", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });

		const rows = await query("SELECT name FROM users WHERE name = $1", ["Bob"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ name: "Bob" });
	});

	test("works with GROUP BY and aggregates", async () => {
		await User.create({ name: "Alice", email: "alice@test.com" });
		await User.create({ name: "Bob", email: "bob@test.com" });

		type CountResult = { total: string };
		const rows = await query<CountResult>(
			"SELECT COUNT(*)::text AS total FROM users",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.total).toBe("2");
	});

	test("returns empty array when no rows match", async () => {
		const rows = await query("SELECT * FROM users WHERE name = $1", ["nobody"]);
		expect(rows).toEqual([]);
	});

	test("is transaction-aware", async () => {
		await transaction(async () => {
			await User.create({ name: "Alice", email: "alice@test.com" });
			const rows = await query("SELECT name FROM users");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toEqual({ name: "Alice" });
		});
	});
});

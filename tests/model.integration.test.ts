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
import { connect, transaction } from "../src/model/connection";
import { hasMany, RecordNotFoundError } from "../src/model/types";
import type { TableDefinition } from "../src/types";
import { getTestConnection, resetDatabase } from "./helpers/postgres";

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
			{ conflictColumns: ["email"] },
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
		await User.all().findEach(
			(user) => {
				names.push(user.name);
			},
			{ batchSize: 2 },
		);

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
		await User.all().findInBatches(
			(batch) => {
				batchSizes.push(batch.length);
			},
			{ batchSize: 2 },
		);

		expect(batchSizes).toEqual([2, 2, 1]);
	});

	test("findEach respects where conditions", async () => {
		await User.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
			{ name: "Charlie", email: "charlie@test.com" },
		]);

		const names: string[] = [];
		await User.where({ name: "Alice" }).findEach((user) => {
			names.push(user.name);
		});

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

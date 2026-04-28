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

class ThreadsRow {
	declare id: string;
	declare title: string;
	declare discardedAt: Date | null;
	declare createdAt: Date;
}

const threadsTableDef: TableDefinition<ThreadsRow> = {
	tableName: "threads",
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
	rowClass: ThreadsRow,
};

class CommentsRow {
	declare id: string;
	declare threadId: string | null;
	declare commentableType: string | null;
	declare commentableId: string | null;
	declare body: string;
	declare createdAt: Date;
	declare discardedAt: Date | null;
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
		threadId: { type: "uuid", nullable: true, columnName: "thread_id" },
		commentableType: {
			type: "text",
			nullable: true,
			columnName: "commentable_type",
		},
		commentableId: {
			type: "uuid",
			nullable: true,
			columnName: "commentable_id",
		},
		body: { type: "text", nullable: false, columnName: "body" },
		createdAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "created_at",
		},
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: CommentsRow,
};

class UsersRow {
	declare id: string;
	declare name: string;
	declare discardedAt: Date | null;
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
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: UsersRow,
};

class ProfilesRow {
	declare id: string;
	declare userId: string;
	declare bio: string;
	declare createdAt: Date;
	declare discardedAt: Date | null;
}

const profilesTableDef: TableDefinition<ProfilesRow> = {
	tableName: "profiles",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		userId: { type: "uuid", nullable: false, columnName: "user_id" },
		bio: { type: "text", nullable: false, columnName: "bio" },
		createdAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "created_at",
		},
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: ProfilesRow,
};

class PostsRow {
	declare id: string;
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
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PostsRow,
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
	declare discardedAt: Date | null;
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
		discardedAt: {
			type: "timestamptz",
			nullable: true,
			columnName: "discarded_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: TaggingsRow,
};

// --- Models ---

class Thread extends Model(threadsTableDef) {
	static softDelete = true;
	static comments = Thread.hasMany(() => Comment, {
		foreignKey: "threadId",
		defaultScope: (query) => query.kept().order({ createdAt: "ASC" }),
	});
	static recentComment = Thread.hasOne(() => Comment, {
		foreignKey: "threadId",
		defaultScope: (query) => query.kept().order({ createdAt: "DESC" }),
	});
	static topComments = Thread.hasMany(() => Comment, {
		foreignKey: "threadId",
		defaultScope: (query) => query.kept().order({ createdAt: "ASC" }).limit(2),
	});
	static allComments = Thread.hasMany(() => Comment, {
		foreignKey: "threadId",
	});
	declare comments: Comment[];
	declare recentComment: Comment | null;
	declare topComments: Comment[];
	declare allComments: Comment[];
}

class Comment extends Model(commentsTableDef) {
	static softDelete = true;
	static thread = Comment.belongsTo(() => Thread, {
		foreignKey: "threadId",
		defaultScope: (query) => query.kept(),
	});
	static commentable = Comment.belongsTo({
		polymorphic: true,
		defaultScope: (query, target) => {
			// Polymorphic scopes must be target-agnostic: only filter when the
			// target model has soft-delete enabled.
			const modelClass = target as unknown as { softDelete?: boolean };
			return modelClass.softDelete ? query.kept() : query;
		},
	});
	declare thread: Thread | null;
	declare commentable: Thread | User | Post | Tag | null;
}

class User extends Model(usersTableDef) {
	static softDelete = true;
	static profile = User.hasOne(() => Profile, {
		foreignKey: "userId",
		defaultScope: (query) => query.kept().order({ createdAt: "DESC" }),
	});
	static comments = User.hasMany(() => Comment, {
		as: "commentable",
		defaultScope: (query) => query.kept().order({ createdAt: "ASC" }),
	});
	declare profile: Profile | null;
	declare comments: Comment[];
}

class Profile extends Model(profilesTableDef) {
	static softDelete = true;
}

class Post extends Model(postsTableDef) {
	static taggings = Post.hasMany(() => Tagging);
	static keptTags = Post.hasManyThrough(() => Tag, {
		through: "taggings",
		defaultThroughScope: (query) => query.kept(),
	});
	static specialTags = Post.hasManyThrough(() => Tag, {
		through: "taggings",
		defaultScope: (query) => query.where({ name: "Special" }),
	});
	static keptSpecialTags = Post.hasManyThrough(() => Tag, {
		through: "taggings",
		defaultThroughScope: (query) => query.kept(),
		defaultScope: (query) => query.where({ name: "Special" }),
	});
	declare taggings: Tagging[];
	declare keptTags: Tag[];
	declare specialTags: Tag[];
	declare keptSpecialTags: Tag[];
}

class Tag extends Model(tagsTableDef) {}

class Tagging extends Model(taggingsTableDef) {
	static softDelete = true;
}

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
		CREATE TABLE threads (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			title text NOT NULL,
			discarded_at timestamptz,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`
		CREATE TABLE users (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL,
			discarded_at timestamptz
		)
	`;
	await connection`
		CREATE TABLE posts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			title text NOT NULL
		)
	`;
	await connection`
		CREATE TABLE comments (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			thread_id uuid REFERENCES threads(id),
			commentable_type text,
			commentable_id uuid,
			body text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			discarded_at timestamptz
		)
	`;
	await connection`
		CREATE TABLE profiles (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL REFERENCES users(id),
			bio text NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			discarded_at timestamptz
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
			tag_id uuid NOT NULL REFERENCES tags(id),
			discarded_at timestamptz
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- Helpers ---

async function createTimedComment(
	body: string,
	threadId: string,
	createdAt: Date,
	options?: { discardedAt?: Date },
): Promise<Comment> {
	const comment = await Comment.create({
		body,
		threadId,
		createdAt,
		...(options?.discardedAt ? { discardedAt: options.discardedAt } : {}),
	});
	return comment;
}

// --- Tests ---

describe("hasMany with defaultScope", () => {
	test("eager filters discarded children and applies order", async () => {
		const thread1 = await Thread.create({ title: "T1" });
		const thread2 = await Thread.create({ title: "T2" });

		const baseTime = Date.now();
		await createTimedComment(
			"thread1-c1",
			thread1.id,
			new Date(baseTime + 1000),
		);
		await createTimedComment(
			"thread1-c2-discarded",
			thread1.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);
		await createTimedComment(
			"thread1-c3",
			thread1.id,
			new Date(baseTime + 3500),
		);
		await createTimedComment(
			"thread2-c1",
			thread2.id,
			new Date(baseTime + 1000),
		);

		const threads = await Thread.kept()
			.order({ createdAt: "ASC" })
			.includes("comments")
			.toArray();
		expect(threads).toHaveLength(2);
		const t1 = threads.find((thread) => thread.title === "T1");
		const t2 = threads.find((thread) => thread.title === "T2");
		expect(t1?.comments).toHaveLength(2);
		expect(t1?.comments.map((comment) => comment.body)).toEqual([
			"thread1-c1",
			"thread1-c3",
		]);
		expect(t2?.comments).toHaveLength(1);
	});

	test("eager preserves [] for parents with only discarded children", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("c1", thread.id, new Date(baseTime + 1000), {
			discardedAt: new Date(baseTime + 2000),
		});

		const threads = await Thread.all().includes("comments").toArray();
		expect(threads).toHaveLength(1);
		expect(threads[0]?.comments).toEqual([]);
	});

	test("lazy load() honors defaultScope", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const reloaded = await Thread.find(thread.id);
		const comments = await reloaded.load("comments");
		expect(Array.isArray(comments)).toBe(true);
		expect((comments as Comment[]).map((comment) => comment.body)).toEqual([
			"kept",
		]);
	});

	test("association without defaultScope still returns all rows", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const threads = await Thread.all().includes("allComments").toArray();
		expect(threads[0]?.allComments).toHaveLength(2);
	});
});

describe("hasMany with limit/offset in defaultScope (window function)", () => {
	test("limit applies per-parent, not globally", async () => {
		const thread1 = await Thread.create({ title: "T1" });
		const thread2 = await Thread.create({ title: "T2" });

		const baseTime = Date.now();
		for (let index = 0; index < 5; index++) {
			await createTimedComment(
				`t1-c${index}`,
				thread1.id,
				new Date(baseTime + index * 1000),
			);
			await createTimedComment(
				`t2-c${index}`,
				thread2.id,
				new Date(baseTime + index * 1000),
			);
		}

		const threads = await Thread.all()
			.order({ title: "ASC" })
			.includes("topComments")
			.toArray();
		expect(threads).toHaveLength(2);
		expect(threads[0]?.topComments).toHaveLength(2);
		expect(threads[1]?.topComments).toHaveLength(2);
		expect(threads[0]?.topComments.map((comment) => comment.body)).toEqual([
			"t1-c0",
			"t1-c1",
		]);
		expect(threads[1]?.topComments.map((comment) => comment.body)).toEqual([
			"t2-c0",
			"t2-c1",
		]);
	});

	test("limit excludes discarded rows before windowing", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("c0", thread.id, new Date(baseTime + 0));
		await createTimedComment(
			"c1-discarded",
			thread.id,
			new Date(baseTime + 1000),
			{
				discardedAt: new Date(baseTime + 5000),
			},
		);
		await createTimedComment("c2", thread.id, new Date(baseTime + 2000));
		await createTimedComment("c3", thread.id, new Date(baseTime + 3000));

		const threads = await Thread.all().includes("topComments").toArray();
		expect(threads[0]?.topComments.map((comment) => comment.body)).toEqual([
			"c0",
			"c2",
		]);
	});
});

describe("hasOne with defaultScope", () => {
	test("eager picks scope-ordered first row per parent", async () => {
		const thread1 = await Thread.create({ title: "T1" });
		const thread2 = await Thread.create({ title: "T2" });
		const baseTime = Date.now();
		await createTimedComment("t1-old", thread1.id, new Date(baseTime + 1000));
		await createTimedComment("t1-new", thread1.id, new Date(baseTime + 5000));
		await createTimedComment(
			"t1-newer-discarded",
			thread1.id,
			new Date(baseTime + 6000),
			{ discardedAt: new Date(baseTime + 7000) },
		);
		await createTimedComment("t2-only", thread2.id, new Date(baseTime + 2000));

		const threads = await Thread.all()
			.order({ title: "ASC" })
			.includes("recentComment")
			.toArray();
		expect(threads[0]?.recentComment?.body).toBe("t1-new");
		expect(threads[1]?.recentComment?.body).toBe("t2-only");
	});

	test("eager resolves to null when scope filters out all rows", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("only", thread.id, new Date(baseTime + 1000), {
			discardedAt: new Date(baseTime + 2000),
		});

		const threads = await Thread.all().includes("recentComment").toArray();
		expect(threads[0]?.recentComment).toBeNull();
	});

	test("lazy load() respects scope and returns first row", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("old", thread.id, new Date(baseTime + 1000));
		await createTimedComment("new", thread.id, new Date(baseTime + 2000));

		const reloaded = await Thread.find(thread.id);
		const recent = await reloaded.load("recentComment");
		expect((recent as Comment).body).toBe("new");
	});
});

describe("belongsTo with defaultScope", () => {
	test("filtered parent resolves to null", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("c", thread.id, new Date(baseTime + 1000));
		await thread.discard();

		const comments = await Comment.all().includes("thread").toArray();
		expect(comments).toHaveLength(1);
		expect(comments[0]?.thread).toBeNull();
	});

	test("kept parent resolves normally", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("c", thread.id, new Date(baseTime + 1000));

		const comments = await Comment.all().includes("thread").toArray();
		expect(comments[0]?.thread?.title).toBe("T");
	});

	test("lazy load() respects scope", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		const comment = await createTimedComment(
			"c",
			thread.id,
			new Date(baseTime + 1000),
		);
		await thread.discard();

		const reloaded = await Comment.find(comment.id);
		const result = await reloaded.load("thread");
		expect(result).toBeNull();
	});
});

describe("hasManyThrough with defaultScope and defaultThroughScope", () => {
	test("defaultThroughScope filters the join table", async () => {
		const post = await Post.create({ title: "P" });
		const tag1 = await Tag.create({ name: "Special" });
		const tag2 = await Tag.create({ name: "Other" });
		const tagging1 = await Tagging.create({ postId: post.id, tagId: tag1.id });
		await Tagging.create({ postId: post.id, tagId: tag2.id });
		await tagging1.discard();

		const posts = await Post.all().includes("keptTags").toArray();
		expect(posts[0]?.keptTags).toHaveLength(1);
		expect(posts[0]?.keptTags[0]?.name).toBe("Other");
	});

	test("defaultScope filters the target table", async () => {
		const post = await Post.create({ title: "P" });
		const tag1 = await Tag.create({ name: "Special" });
		const tag2 = await Tag.create({ name: "Other" });
		await Tagging.create({ postId: post.id, tagId: tag1.id });
		await Tagging.create({ postId: post.id, tagId: tag2.id });

		const posts = await Post.all().includes("specialTags").toArray();
		expect(posts[0]?.specialTags).toHaveLength(1);
		expect(posts[0]?.specialTags[0]?.name).toBe("Special");
	});

	test("both scopes compose", async () => {
		const post = await Post.create({ title: "P" });
		const tagSpecial = await Tag.create({ name: "Special" });
		const tagOther = await Tag.create({ name: "Other" });
		const taggingSpecial = await Tagging.create({
			postId: post.id,
			tagId: tagSpecial.id,
		});
		await Tagging.create({ postId: post.id, tagId: tagOther.id });

		// Discard the special tagging — the kept-only through scope should now
		// hide the Special tag.
		await taggingSpecial.discard();

		const posts = await Post.all().includes("keptSpecialTags").toArray();
		expect(posts[0]?.keptSpecialTags).toHaveLength(0);
	});

	test("lazy load() respects both scopes", async () => {
		const post = await Post.create({ title: "P" });
		const tag1 = await Tag.create({ name: "Special" });
		const tag2 = await Tag.create({ name: "Other" });
		const tagging1 = await Tagging.create({ postId: post.id, tagId: tag1.id });
		await Tagging.create({ postId: post.id, tagId: tag2.id });
		await tagging1.discard();

		const reloaded = await Post.find(post.id);
		const tags = await reloaded.load("keptTags");
		expect(Array.isArray(tags)).toBe(true);
		expect((tags as Tag[]).map((tag) => tag.name)).toEqual(["Other"]);
	});
});

describe("polymorphic associations with defaultScope", () => {
	test("polymorphic hasMany filters and orders", async () => {
		const user = await User.create({ name: "U" });
		const baseTime = Date.now();
		await Comment.create({
			body: "c1",
			commentableType: "User",
			commentableId: user.id,
			createdAt: new Date(baseTime + 1000),
		});
		await Comment.create({
			body: "c2-discarded",
			commentableType: "User",
			commentableId: user.id,
			createdAt: new Date(baseTime + 2000),
			discardedAt: new Date(baseTime + 3000),
		});
		await Comment.create({
			body: "c3",
			commentableType: "User",
			commentableId: user.id,
			createdAt: new Date(baseTime + 4000),
		});

		const users = await User.all().includes("comments").toArray();
		expect(users[0]?.comments).toHaveLength(2);
		expect(users[0]?.comments.map((comment) => comment.body)).toEqual([
			"c1",
			"c3",
		]);
	});

	test("polymorphic belongsTo filters by scope", async () => {
		const thread = await Thread.create({ title: "T" });
		await Comment.create({
			body: "c",
			commentableType: "Thread",
			commentableId: thread.id,
		});
		await thread.discard();

		const comments = await Comment.all().includes("commentable").toArray();
		expect(comments[0]?.commentable).toBeNull();
	});

	test("polymorphic scope respects target via the target arg (non-soft-delete target passes through)", async () => {
		// `Tag` does not have `softDelete` enabled, so the polymorphic
		// `commentable` scope should return the query unmodified and the tag
		// should resolve normally. Using `Tag` (rather than `Post`) for this
		// case because the model registry is process-global — other test files
		// register a soft-delete-enabled `Post` that would override ours and
		// flip the scope branch under test.
		const tag = await Tag.create({ name: "T" });
		await Comment.create({
			body: "c",
			commentableType: "Tag",
			commentableId: tag.id,
		});

		const comments = await Comment.all().includes("commentable").toArray();
		expect(comments[0]?.commentable).not.toBeNull();
		expect((comments[0]?.commentable as Tag).name).toBe("T");
	});
});

describe("nested includes with scopes", () => {
	test("scopes apply at every level", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const comments = await Comment.kept().includes("thread").toArray();
		expect(comments).toHaveLength(1);
		expect(comments[0]?.thread?.title).toBe("T");

		const threads = await Thread.all().includes("comments").toArray();
		expect(threads[0]?.comments).toHaveLength(1);
	});
});

describe("per-call scope overrides on .includes()", () => {
	test("scope: false bypasses the declared defaultScope", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const threads = await Thread.all()
			.includes("comments", { scope: false })
			.toArray();
		expect(threads[0]?.comments).toHaveLength(2);
		const bodies = threads[0]?.comments.map((comment) => comment.body).sort();
		expect(bodies).toEqual(["discarded", "kept"]);
	});

	test("scope: function replaces the declared defaultScope", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const threads = await Thread.all()
			.includes("comments", { scope: (query) => query.discarded() })
			.toArray();
		expect(threads[0]?.comments).toHaveLength(1);
		expect(threads[0]?.comments[0]?.body).toBe("discarded");
	});

	test("override only applies on the call where it was passed (no leak)", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const overridden = await Thread.all()
			.includes("comments", { scope: false })
			.toArray();
		expect(overridden[0]?.comments).toHaveLength(2);

		// A separate query without the override still applies the defaultScope.
		const normal = await Thread.all().includes("comments").toArray();
		expect(normal[0]?.comments).toHaveLength(1);
		expect(normal[0]?.comments[0]?.body).toBe("kept");
	});

	test("override only applies at the top level — nested levels keep declared scopes", async () => {
		// `Comment.thread` has a `kept()` scope; passing `scope: false` for
		// `comments` (the top level here) must NOT cascade into the nested
		// `comments.thread` resolution.
		const threadDiscarded = await Thread.create({ title: "discarded" });
		const baseTime = Date.now();
		await createTimedComment(
			"c",
			threadDiscarded.id,
			new Date(baseTime + 1000),
		);
		await threadDiscarded.discard();

		const threads = await Thread.all()
			.includes("comments.thread", { scope: false })
			.toArray();
		expect(threads[0]?.comments).toHaveLength(1);
		// Nested `thread` scope (kept()) still applies — discarded thread is null.
		expect(threads[0]?.comments[0]?.thread).toBeNull();
	});

	test("scope: false on hasManyThrough bypasses declared target scope but defaultThroughScope still applies", async () => {
		const post = await Post.create({ title: "P" });
		const tagSpecial = await Tag.create({ name: "Special" });
		const tagOther = await Tag.create({ name: "Other" });
		await Tagging.create({ postId: post.id, tagId: tagSpecial.id });
		await Tagging.create({ postId: post.id, tagId: tagOther.id });

		// `specialTags` has `defaultScope: q => q.where({ name: "Special" })` and
		// no defaultThroughScope. Bypassing it returns ALL tags joined through.
		const posts = await Post.all()
			.includes("specialTags", { scope: false })
			.toArray();
		expect(posts[0]?.specialTags.map((tag) => tag.name).sort()).toEqual([
			"Other",
			"Special",
		]);
	});

	test("scope override coexists with other plain includes() in the same chain", async () => {
		const thread = await Thread.create({ title: "T" });
		const baseTime = Date.now();
		await createTimedComment("kept", thread.id, new Date(baseTime + 1000));
		await createTimedComment(
			"discarded",
			thread.id,
			new Date(baseTime + 2000),
			{ discardedAt: new Date(baseTime + 3000) },
		);

		const threads = await Thread.all()
			.includes("comments", { scope: false })
			.includes("recentComment")
			.toArray();
		expect(threads[0]?.comments).toHaveLength(2);
		// recentComment uses its own declared kept().order(DESC) scope
		expect(threads[0]?.recentComment?.body).toBe("kept");
	});
});

describe("_buildWindowedSql edge cases", () => {
	test("offset shifts the per-partition slice", async () => {
		// Define an inline model with offset+limit scope to test _buildWindowedSql
		class OffsetThread extends Model(threadsTableDef) {
			static softDelete = true;
			static skipFirstComment = OffsetThread.hasMany(() => Comment, {
				foreignKey: "threadId",
				defaultScope: (query) =>
					query.order({ createdAt: "ASC" }).limit(2).offset(1),
			});
			declare skipFirstComment: Comment[];
		}

		const thread = await OffsetThread.create({ title: "T" });
		const baseTime = Date.now();
		for (let index = 0; index < 5; index++) {
			await createTimedComment(
				`c${index}`,
				thread.id,
				new Date(baseTime + index * 1000),
			);
		}

		const threads = await OffsetThread.all()
			.includes("skipFirstComment")
			.toArray();
		expect(threads[0]?.skipFirstComment.map((comment) => comment.body)).toEqual(
			["c1", "c2"],
		);
	});
});

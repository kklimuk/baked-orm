import { describe, expect, test } from "bun:test";

import { serialize } from "../src/model/serializer";
import type { TableDefinition } from "../src/types";

// --- Row classes + table definitions ---

class UsersRow {
	[key: string]: unknown;
	declare id: string;
	declare name: string;
	declare email: string;
	declare passwordDigest: string;
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
		passwordDigest: {
			type: "text",
			nullable: false,
			columnName: "password_digest",
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
	rowClass: UsersRow,
};

class PostsRow {
	[key: string]: unknown;
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
	foreignKeys: {},
	rowClass: PostsRow,
};

class CommentsRow {
	[key: string]: unknown;
	declare id: string;
	declare postId: string;
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
		postId: { type: "uuid", nullable: false, columnName: "post_id" },
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

// --- Mock model classes that mimic what Model() produces ---

class MockUser extends UsersRow {
	static tableDefinition = usersTableDef;
	static sensitiveFields: string[] = [];
	constructor(attrs: Partial<UsersRow> = {}) {
		super();
		Object.assign(this, attrs);
	}
}

class MockUserWithSensitive extends UsersRow {
	static tableDefinition = usersTableDef;
	static sensitiveFields = ["passwordDigest"];
	constructor(attrs: Partial<UsersRow> = {}) {
		super();
		Object.assign(this, attrs);
	}
}

class MockPost extends PostsRow {
	static tableDefinition = postsTableDef;
	static sensitiveFields: string[] = [];
	constructor(attrs: Partial<PostsRow> = {}) {
		super();
		Object.assign(this, attrs);
	}
}

class MockComment extends CommentsRow {
	static tableDefinition = commentsTableDef;
	static sensitiveFields: string[] = [];
	constructor(attrs: Partial<CommentsRow> = {}) {
		super();
		Object.assign(this, attrs);
	}
}

// --- Tests ---

describe("serialize", () => {
	test("includes __typename from constructor name", () => {
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const result = serialize(user, usersTableDef);
		expect(result.__typename).toBe("MockUser");
	});

	test("includes all column values by default", () => {
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const result = serialize(user, usersTableDef);
		expect(result.id).toBe("1");
		expect(result.name).toBe("Alice");
		expect(result.email).toBe("alice@test.com");
		expect(result.passwordDigest).toBe("hashed");
		expect(result.createdAt).toBeInstanceOf(Date);
	});

	test("only option whitelists columns", () => {
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const result = serialize(user, usersTableDef, { only: ["id", "name"] });
		expect(result.__typename).toBeDefined();
		expect(result.id).toBe("1");
		expect(result.name).toBe("Alice");
		expect(result.email).toBeUndefined();
		expect(result.passwordDigest).toBeUndefined();
		expect(result.createdAt).toBeUndefined();
	});

	test("except option blacklists columns", () => {
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const result = serialize(user, usersTableDef, {
			except: ["passwordDigest", "createdAt"],
		});
		expect(result.id).toBe("1");
		expect(result.name).toBe("Alice");
		expect(result.email).toBe("alice@test.com");
		expect(result.passwordDigest).toBeUndefined();
		expect(result.createdAt).toBeUndefined();
	});

	test("sensitiveFields are always excluded", () => {
		const user = new MockUserWithSensitive({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "super-secret",
			createdAt: new Date("2024-01-01"),
		});

		const result = serialize(user, usersTableDef);
		expect(result.passwordDigest).toBeUndefined();
		expect(result.name).toBe("Alice");

		// Even with only that includes the sensitive field
		const resultOnly = serialize(user, usersTableDef, {
			only: ["id", "passwordDigest"],
		});
		expect(resultOnly.passwordDigest).toBeUndefined();
		expect(resultOnly.id).toBe("1");
	});

	test("sensitiveFields excluded from keys list", () => {
		const user = new MockUserWithSensitive({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const keys = Object.keys(serialize(user, usersTableDef));
		expect(keys).not.toContain("passwordDigest");
		expect(keys).toContain("name");
		expect(keys).toContain("__typename");
	});

	test("include with string[] shorthand serializes associations", () => {
		const post = new MockPost({
			id: "p1",
			userId: "1",
			title: "Hello",
			body: "World",
			createdAt: new Date("2024-01-02"),
		});
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		(user as Record<string, unknown>).posts = [post];

		const result = serialize(user, usersTableDef, { include: ["posts"] });
		expect(result.posts).toBeArray();
		const posts = result.posts as Record<string, unknown>[];
		expect(posts).toHaveLength(1);
		expect(posts[0]?.__typename).toBe("MockPost");
		expect(posts[0]?.title).toBe("Hello");
	});

	test("include with nested options applies per-association filtering", () => {
		const post = new MockPost({
			id: "p1",
			userId: "1",
			title: "Hello",
			body: "World",
			createdAt: new Date("2024-01-02"),
		});
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		(user as Record<string, unknown>).posts = [post];

		const result = serialize(user, usersTableDef, {
			include: { posts: { only: ["id", "title"] } },
		});
		const posts = result.posts as Record<string, unknown>[];
		expect(posts[0]?.id).toBe("p1");
		expect(posts[0]?.title).toBe("Hello");
		expect(posts[0]?.body).toBeUndefined();
		expect(posts[0]?.userId).toBeUndefined();
	});

	test("include with dotted paths for nested associations", () => {
		const comment = new MockComment({
			id: "c1",
			postId: "p1",
			body: "Nice!",
			createdAt: new Date("2024-01-03"),
		});
		const post = new MockPost({
			id: "p1",
			userId: "1",
			title: "Hello",
			body: "World",
			createdAt: new Date("2024-01-02"),
		});
		(post as Record<string, unknown>).comments = [comment];

		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		(user as Record<string, unknown>).posts = [post];

		const result = serialize(user, usersTableDef, {
			include: ["posts.comments"],
		});
		const posts = result.posts as Record<string, unknown>[];
		const comments = posts[0]?.comments as Record<string, unknown>[];
		expect(comments).toHaveLength(1);
		expect(comments[0]?.__typename).toBe("MockComment");
		expect(comments[0]?.body).toBe("Nice!");
	});

	test("null belongsTo association serializes as null", () => {
		const post = new MockPost({
			id: "p1",
			userId: "1",
			title: "Hello",
			body: null,
			createdAt: new Date("2024-01-02"),
		});
		(post as Record<string, unknown>).author = null;

		const result = serialize(post, postsTableDef, { include: ["author"] });
		expect(result.author).toBeNull();
	});

	test("undefined (not loaded) association is skipped", () => {
		const user = new MockUser({
			id: "1",
			name: "Alice",
			email: "alice@test.com",
			passwordDigest: "hashed",
			createdAt: new Date("2024-01-01"),
		});
		const result = serialize(user, usersTableDef, { include: ["posts"] });
		expect(result.posts).toBeUndefined();
	});
});

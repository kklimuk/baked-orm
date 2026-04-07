import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { hydrate } from "../src/frontend/hydrate";
import { FrontendModel } from "../src/frontend/model";
import { getFrontendRegistry, registerModels } from "../src/frontend/registry";
import { validates } from "../src/model/validations";
import type { TableDefinition } from "../src/types";

// --- Row classes (simulating generated schema) ---

class UsersRow {
	[key: string]: unknown;
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
			type: "timestamp with time zone",
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
	declare publishedOn: Date | null;
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
		publishedOn: { type: "date", nullable: true, columnName: "published_on" },
		createdAt: {
			type: "timestamp with time zone",
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

// --- Frontend models ---

class User extends FrontendModel(usersTableDef) {
	static validations = {
		name: validates("presence"),
		email: [validates("presence"), validates("email")],
	};
	declare posts: Post[];
}

class Post extends FrontendModel(postsTableDef) {
	declare author: User;
}

// Register models so hydrate() can resolve __typename
registerModels(User, Post);

// --- Tests ---

describe("FrontendModel", () => {
	test("constructor assigns attributes", () => {
		const user = new User({ name: "Alice", email: "alice@test.com" });
		expect(user.name).toBe("Alice");
		expect(user.email).toBe("alice@test.com");
	});

	test("new instances are new records", () => {
		const user = new User({ name: "Alice" });
		expect(user.isNewRecord).toBe(true);
	});

	test("markPersisted sets isNewRecord to false", () => {
		const user = new User({ name: "Alice" });
		user.markPersisted();
		expect(user.isNewRecord).toBe(false);
	});

	describe("dirty tracking", () => {
		test("new record reports all fields as changed", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			expect(user.changed()).toBe(true);
			expect(user.changed("name")).toBe(true);
		});

		test("persisted record starts clean", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			user.markPersisted();
			expect(user.changed()).toBe(false);
			expect(user.changed("name")).toBe(false);
		});

		test("changing a field after markPersisted reports dirty", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			user.markPersisted();
			user.name = "Bob";
			expect(user.changed()).toBe(true);
			expect(user.changed("name")).toBe(true);
			expect(user.changed("email")).toBe(false);
		});

		test("changedAttributes returns was/now pairs", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			user.markPersisted();
			user.name = "Bob";
			const changes = user.changedAttributes();
			expect(changes.name).toEqual({ was: "Alice", now: "Bob" });
			expect(changes.email).toBeUndefined();
		});
	});

	describe("validations", () => {
		test("validates presence", () => {
			const user = new User({ name: "", email: "alice@test.com" });
			expect(user.isValid()).toBe(false);
			expect(user.errors.get("name")).toEqual(["can't be blank"]);
		});

		test("validates email format", () => {
			const user = new User({ name: "Alice", email: "not-an-email" });
			expect(user.isValid()).toBe(false);
			expect(user.errors.get("email")).toEqual([
				"is not a valid email address",
			]);
		});

		test("valid record passes", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			expect(user.isValid()).toBe(true);
			expect(user.errors.isEmpty).toBe(true);
		});

		test("isValid resets errors on each call", () => {
			const user = new User({ name: "", email: "alice@test.com" });
			expect(user.isValid()).toBe(false);
			expect(user.errors.isEmpty).toBe(false);
			user.name = "Alice";
			expect(user.isValid()).toBe(true);
			expect(user.errors.isEmpty).toBe(true);
		});
	});

	describe("toJSON", () => {
		test("includes __typename and column values", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			const json = user.toJSON();
			expect(json.__typename).toBe("User");
			expect(json.name).toBe("Alice");
			expect(json.email).toBe("alice@test.com");
		});

		test("does not include non-column properties", () => {
			const user = new User({ name: "Alice", email: "alice@test.com" });
			(user as Record<string, unknown>).extraProp = "should not appear";
			const json = user.toJSON();
			expect(json.extraProp).toBeUndefined();
		});
	});

	describe("fromJSON", () => {
		test("hydrates from JSON via __typename", () => {
			const user = User.fromJSON({
				__typename: "User",
				id: "abc-123",
				name: "Alice",
				email: "alice@test.com",
				createdAt: "2024-06-15T10:30:00Z",
			});
			expect(user.name).toBe("Alice");
			expect(user.email).toBe("alice@test.com");
			expect(user.id).toBe("abc-123");
		});
	});

	describe("registry", () => {
		test("models are registered by class name", () => {
			const registry = getFrontendRegistry();
			expect(registry.has("User")).toBe(true);
			expect(registry.has("Post")).toBe(true);
		});
	});
});

describe("hydrate", () => {
	test("converts timestamp columns to Temporal.Instant", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "abc-123",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(user.createdAt).toBeInstanceOf(Temporal.Instant);
		expect((user.createdAt as unknown as Temporal.Instant).toString()).toBe(
			"2024-06-15T10:30:00Z",
		);
	});

	test("converts date-only columns to Temporal.PlainDate", () => {
		const post = hydrate<Post>({
			__typename: "Post",
			id: "p1",
			userId: "u1",
			title: "Hello",
			body: null,
			publishedOn: "2024-06-15",
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(post.publishedOn).toBeInstanceOf(Temporal.PlainDate);
		expect((post.publishedOn as unknown as Temporal.PlainDate).toString()).toBe(
			"2024-06-15",
		);
	});

	test("null date columns stay null", () => {
		const post = hydrate<Post>({
			__typename: "Post",
			id: "p1",
			userId: "u1",
			title: "Hello",
			body: null,
			publishedOn: null,
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(post.publishedOn).toBeNull();
	});

	test("hydrated instances are persisted (not new records)", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "abc-123",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(user.isNewRecord).toBe(false);
	});

	test("hydrated instances start clean (no dirty fields)", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "abc-123",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(user.changed()).toBe(false);
	});

	test("modifying a hydrated instance makes it dirty", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "abc-123",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
		});
		user.name = "Bob";
		expect(user.changed("name")).toBe(true);
		expect(user.changed("email")).toBe(false);
	});

	test("recursively hydrates hasMany associations", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "u1",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
			posts: [
				{
					__typename: "Post",
					id: "p1",
					userId: "u1",
					title: "Hello",
					body: "World",
					publishedOn: null,
					createdAt: "2024-06-16T10:30:00Z",
				},
			],
		});
		expect(user.posts).toHaveLength(1);
		expect(user.posts[0]?.title).toBe("Hello");
		expect(user.posts[0]?.isNewRecord).toBe(false);
		expect(user.posts[0]?.createdAt).toBeInstanceOf(Temporal.Instant);
	});

	test("recursively hydrates belongsTo associations", () => {
		const post = hydrate<Post>({
			__typename: "Post",
			id: "p1",
			userId: "u1",
			title: "Hello",
			body: null,
			publishedOn: null,
			createdAt: "2024-06-15T10:30:00Z",
			author: {
				__typename: "User",
				id: "u1",
				name: "Alice",
				email: "alice@test.com",
				createdAt: "2024-06-14T10:30:00Z",
			},
		});
		expect(post.author).toBeDefined();
		expect(post.author.name).toBe("Alice");
		expect(post.author.isNewRecord).toBe(false);
	});

	test("non-typed array values are left as-is", () => {
		const user = hydrate<User>({
			__typename: "User",
			id: "u1",
			name: "Alice",
			email: "alice@test.com",
			createdAt: "2024-06-15T10:30:00Z",
			tags: ["foo", "bar"],
		});
		expect((user as Record<string, unknown>).tags).toEqual(["foo", "bar"]);
	});

	test("throws on missing __typename", () => {
		expect(() => hydrate({ id: "1", name: "Alice" })).toThrow(
			"Cannot hydrate: missing __typename",
		);
	});

	test("throws on unknown __typename", () => {
		expect(() => hydrate({ __typename: "UnknownModel", id: "1" })).toThrow(
			'Unknown model type: "UnknownModel"',
		);
	});

	test("round-trip: toJSON then hydrate preserves data", () => {
		const original = new User({
			name: "Alice",
			email: "alice@test.com",
		});
		(original as Record<string, unknown>).id = "u1";
		(original as Record<string, unknown>).createdAt = new Date(
			"2024-06-15T10:30:00Z",
		);

		const json = original.toJSON();
		// Simulate JSON wire format (Date → ISO string via JSON.stringify)
		const wireJson = JSON.parse(JSON.stringify(json));
		const hydrated = hydrate<User>(wireJson);

		expect(hydrated.id).toBe("u1");
		expect(hydrated.name).toBe("Alice");
		expect(hydrated.email).toBe("alice@test.com");
		expect(hydrated.createdAt).toBeInstanceOf(Temporal.Instant);
		expect(hydrated.isNewRecord).toBe(false);
	});
});

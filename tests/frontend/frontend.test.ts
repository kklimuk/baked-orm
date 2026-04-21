import { afterEach, describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { hydrate } from "../../src/frontend/hydrate";
import { FrontendModel } from "../../src/frontend/model";
import {
	getFrontendRegistry,
	registerModels,
} from "../../src/frontend/registry";
import { Snapshot } from "../../src/model/snapshot";
import { validates } from "../../src/model/validations";
import type { TableDefinition } from "../../src/types";

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

class ProfilesRow {
	[key: string]: unknown;
	declare id: string;
	declare userId: string;
	declare metadata: unknown;
	declare createdAt: Date;
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
		metadata: { type: "jsonb", nullable: true, columnName: "metadata" },
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
	rowClass: ProfilesRow,
};

class Profile extends FrontendModel(profilesTableDef) {
	declare metadata: { theme: string; notifications: { email: boolean } };
}

// Register models so hydrate() can resolve __typename
registerModels({ User, Post, Profile });

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
		// Tests below register extra classes into the module-scoped registry.
		// Track and delete them after each test to avoid cross-test pollution.
		const addedKeys: string[] = [];
		afterEach(() => {
			const registry = getFrontendRegistry();
			for (const key of addedKeys) registry.delete(key);
			addedKeys.length = 0;
		});

		function makeSingleColumnModel(tableName: string) {
			class RowClass {
				[key: string]: unknown;
				declare id: string;
			}
			const tableDef: TableDefinition<RowClass> = {
				tableName,
				columns: { id: { type: "uuid", nullable: false, columnName: "id" } },
				primaryKey: ["id"],
				indexes: {},
				foreignKeys: {},
				rowClass: RowClass,
			};
			return class extends FrontendModel(tableDef) {};
		}

		test("models are registered by object key", () => {
			const registry = getFrontendRegistry();
			expect(registry.has("User")).toBe(true);
			expect(registry.has("Post")).toBe(true);
		});

		test("registerModels sets the typename static to the object key", () => {
			expect((User as { typename?: string }).typename).toBe("User");
			expect((Post as { typename?: string }).typename).toBe("Post");
		});

		test("registering under an alias keys the registry and typename by alias", () => {
			const Widget = makeSingleColumnModel("widgets");
			registerModels({ Gadget: Widget });
			addedKeys.push("Gadget");

			expect((Widget as { typename?: string }).typename).toBe("Gadget");
			const widget = new Widget({ id: "w1" });
			expect(widget.toJSON().__typename).toBe("Gadget");
			expect(getFrontendRegistry().has("Gadget")).toBe(true);
		});

		test("re-registering same class under same name is idempotent", () => {
			const Box = makeSingleColumnModel("boxes");
			registerModels({ Box });
			addedKeys.push("Box");
			expect(() => registerModels({ Box })).not.toThrow();
		});

		test("re-registering same class under a different name throws", () => {
			const Crate = makeSingleColumnModel("crates");
			registerModels({ Crate });
			addedKeys.push("Crate");
			expect(() => registerModels({ Carton: Crate })).toThrow(
				/already registered as "Crate"/,
			);
		});

		test("hydrate resolves by typename even after class.name is mangled", () => {
			const Minified = makeSingleColumnModel("minifieds");
			registerModels({ Minified });
			addedKeys.push("Minified");

			// Simulate identifier minification: class.name gets mangled.
			Object.defineProperty(Minified, "name", {
				value: "q",
				configurable: true,
			});
			expect(Minified.name).toBe("q");

			const instance = hydrate<InstanceType<typeof Minified>>({
				__typename: "Minified",
				id: "m1",
			});
			expect(instance).toBeInstanceOf(Minified);
			expect(instance.id).toBe("m1");

			// toJSON also uses typename, not the mangled class.name
			const fresh = new Minified({ id: "m2" });
			expect(fresh.toJSON().__typename).toBe("Minified");
		});

		test("unregistered typename throws a helpful error", () => {
			expect(() => hydrate({ __typename: "Unregistered", id: "1" })).toThrow(
				/registerModels\(\{ Unregistered \}\)/,
			);
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

	test("JSON columns pass through hydration as-is", () => {
		const profile = hydrate<Profile>({
			__typename: "Profile",
			id: "p1",
			userId: "u1",
			metadata: { theme: "dark", notifications: { email: true } },
			createdAt: "2024-06-15T10:30:00Z",
		});
		expect(profile.metadata).toEqual({
			theme: "dark",
			notifications: { email: true },
		});
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

describe("JSON/JSONB dirty tracking", () => {
	describe("via FrontendModel", () => {
		test("in-place mutation of JSON field is detected as dirty", () => {
			const profile = new Profile({
				metadata: { theme: "dark", notifications: { email: true } },
			} as Partial<ProfilesRow>);
			profile.markPersisted();
			expect(profile.changed("metadata")).toBe(false);

			profile.metadata.theme = "light";
			expect(profile.changed("metadata")).toBe(true);
		});

		test("nested mutation of JSON field is detected", () => {
			const profile = new Profile({
				metadata: { theme: "dark", notifications: { email: true } },
			} as Partial<ProfilesRow>);
			profile.markPersisted();

			profile.metadata.notifications.email = false;
			expect(profile.changed("metadata")).toBe(true);
			expect(profile.changedAttributes().metadata).toEqual({
				was: { theme: "dark", notifications: { email: true } },
				now: { theme: "dark", notifications: { email: false } },
			});
		});

		test("JSON field with no mutation stays clean", () => {
			const profile = new Profile({
				metadata: { theme: "dark", notifications: { email: true } },
			} as Partial<ProfilesRow>);
			profile.markPersisted();
			expect(profile.changed("metadata")).toBe(false);
			expect(profile.changed()).toBe(false);
		});

		test("replacing JSON field by reference is detected", () => {
			const profile = new Profile({
				metadata: { theme: "dark", notifications: { email: true } },
			} as Partial<ProfilesRow>);
			profile.markPersisted();

			profile.metadata = { theme: "light", notifications: { email: false } };
			expect(profile.changed("metadata")).toBe(true);
		});

		test("null JSON field stays clean", () => {
			const profile = new Profile({
				metadata: null,
			} as Partial<ProfilesRow>);
			profile.markPersisted();
			expect(profile.changed("metadata")).toBe(false);
		});

		test("undefined JSON field assigned a value is detected", () => {
			const profile = new Profile({} as Partial<ProfilesRow>);
			profile.markPersisted();
			expect(profile.changed("metadata")).toBe(false);

			profile.metadata = { theme: "dark", notifications: { email: true } };
			expect(profile.changed("metadata")).toBe(true);
		});

		test("non-JSON fields still use reference equality", () => {
			const profile = new Profile({
				userId: "u1",
				metadata: { theme: "dark", notifications: { email: true } },
			} as Partial<ProfilesRow>);
			profile.markPersisted();

			(profile as Record<string, unknown>).userId = "u2";
			expect(profile.changed("userId")).toBe(true);
		});
	});

	describe("via Snapshot directly", () => {
		const columns = {
			id: { type: "uuid", nullable: false, columnName: "id" },
			data: { type: "jsonb", nullable: true, columnName: "data" },
			config: { type: "json", nullable: true, columnName: "config" },
			name: { type: "text", nullable: false, columnName: "name" },
		};

		test("capture clones JSON values so mutations are detected", () => {
			const snapshot = new Snapshot(columns, "id");
			const instance: Record<string, unknown> = {
				id: "1",
				data: { count: 0 },
				config: { debug: true },
				name: "test",
			};
			snapshot.capture(instance);

			(instance.data as Record<string, unknown>).count = 1;
			expect(snapshot.changed(instance, "data")).toBe(true);
			expect(snapshot.changed(instance, "name")).toBe(false);
		});

		test("dirtyEntries includes mutated JSON columns", () => {
			const snapshot = new Snapshot(columns, "id");
			const instance: Record<string, unknown> = {
				id: "1",
				data: { count: 0 },
				config: { debug: true },
				name: "test",
			};
			snapshot.capture(instance);

			(instance.data as Record<string, unknown>).count = 1;
			const dirty = snapshot.dirtyEntries(instance);
			expect(dirty.map(([key]) => key)).toEqual(["data"]);
		});

		test("both json and jsonb types are deep-tracked", () => {
			const snapshot = new Snapshot(columns, "id");
			const instance: Record<string, unknown> = {
				id: "1",
				data: { nested: { value: 1 } },
				config: { flags: ["a"] },
				name: "test",
			};
			snapshot.capture(instance);

			(
				(instance.data as Record<string, unknown>).nested as Record<
					string,
					unknown
				>
			).value = 2;
			((instance.config as Record<string, unknown>).flags as string[]).push(
				"b",
			);

			expect(snapshot.changed(instance, "data")).toBe(true);
			expect(snapshot.changed(instance, "config")).toBe(true);
			const dirty = snapshot.dirtyEntries(instance);
			expect(dirty.map(([key]) => key)).toEqual(["data", "config"]);
		});
	});
});

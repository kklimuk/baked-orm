import { describe, expect, test } from "bun:test";

import { Model } from "../../src/model/base";
import { serialize } from "../../src/model/serializer";
import { hasMany } from "../../src/model/types";
import type { TableDefinition } from "../../src/types";

class UsersRow {
	[key: string]: unknown;
	declare id: string;
	declare firstName: string;
	declare lastName: string;
	declare email: string;
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
		firstName: { type: "text", nullable: false, columnName: "first_name" },
		lastName: { type: "text", nullable: false, columnName: "last_name" },
		email: { type: "text", nullable: false, columnName: "email" },
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

class Post extends Model(postsTableDef) {}

describe("virtual attributes — auto-detection", () => {
	test("computed getter is included in serialize output", () => {
		class User extends Model(usersTableDef) {
			get fullName(): string {
				return `${this.firstName} ${this.lastName}`;
			}
		}

		const user = new User({
			id: "1",
			firstName: "Alice",
			lastName: "Smith",
			email: "alice@test.com",
		});
		const result = serialize(user, usersTableDef);
		expect(result.fullName).toBe("Alice Smith");
		expect(result.firstName).toBe("Alice");
	});

	test("settable virtual with class-field default is included with default value", () => {
		class User extends Model(usersTableDef) {
			following: boolean | null = null;
		}

		const user = new User({
			id: "1",
			firstName: "Alice",
			lastName: "S",
			email: "a@test.com",
		});
		const result = serialize(user, usersTableDef);
		expect(result).toHaveProperty("following");
		expect(result.following).toBeNull();
	});

	test("settable virtual reflects assigned value", () => {
		class User extends Model(usersTableDef) {
			following: boolean | null = null;
		}

		const user = new User({
			id: "1",
			firstName: "Alice",
			lastName: "S",
			email: "a@test.com",
		});
		user.following = true;
		const result = serialize(user, usersTableDef);
		expect(result.following).toBe(true);
	});

	test("ad-hoc property assigned post-construction is serialized", () => {
		class User extends Model(usersTableDef) {}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		(user as Record<string, unknown>).computedAtRuntime = 42;
		const result = serialize(user, usersTableDef);
		expect(result.computedAtRuntime).toBe(42);
	});

	test("undefined settable values are omitted", () => {
		class User extends Model(usersTableDef) {}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		(user as Record<string, unknown>).optional = undefined;
		const result = serialize(user, usersTableDef);
		expect(result).not.toHaveProperty("optional");
	});

	test("only filter applies to virtuals", () => {
		class User extends Model(usersTableDef) {
			get fullName(): string {
				return `${this.firstName} ${this.lastName}`;
			}
		}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const result = serialize(user, usersTableDef, {
			only: ["id", "fullName"],
		});
		expect(result.id).toBe("1");
		expect(result.fullName).toBe("A B");
		expect(result.firstName).toBeUndefined();
	});

	test("except filter applies to virtuals", () => {
		class User extends Model(usersTableDef) {
			get fullName(): string {
				return `${this.firstName} ${this.lastName}`;
			}
		}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const result = serialize(user, usersTableDef, { except: ["fullName"] });
		expect(result).not.toHaveProperty("fullName");
		expect(result.firstName).toBe("A");
	});

	test("sensitiveFields excludes virtuals", () => {
		class User extends Model(usersTableDef) {
			get internalToken(): string {
				return "secret-derived";
			}
			static sensitiveFields = ["internalToken"];
		}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const result = serialize(user, usersTableDef);
		expect(result).not.toHaveProperty("internalToken");
	});

	test("methods option calls instance methods and includes results", () => {
		class User extends Model(usersTableDef) {
			computeBadge(): string {
				return `badge-${this.firstName}`;
			}
		}
		const user = new User({
			id: "1",
			firstName: "Alice",
			lastName: "S",
			email: "a@test.com",
		});
		const result = serialize(user, usersTableDef, {
			methods: ["computeBadge"],
		});
		expect(result.computeBadge).toBe("badge-Alice");
	});

	test("underscore-prefixed getters are NOT included", () => {
		class User extends Model(usersTableDef) {
			get _internal(): string {
				return "hidden";
			}
		}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const result = serialize(user, usersTableDef);
		expect(result).not.toHaveProperty("_internal");
	});

	test("plugin-added getters (isDiscarded, isKept) are NOT auto-included", () => {
		class SoftUser extends Model(usersTableDef) {
			static softDelete = true;
		}
		const user = new SoftUser({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const result = serialize(user, usersTableDef);
		expect(result).not.toHaveProperty("isDiscarded");
		expect(result).not.toHaveProperty("isKept");
	});

	test("preloaded associations are NOT auto-included as virtuals", () => {
		class User extends Model(usersTableDef, {
			posts: hasMany(() => Post),
		}) {}

		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		const post = new Post({ id: "p1", userId: "1", title: "Hello" });
		(user as Record<string, unknown>).posts = [post];

		const result = serialize(user, usersTableDef);
		expect(result).not.toHaveProperty("posts");

		// But explicit include still works
		const withInclude = serialize(user, usersTableDef, { include: ["posts"] });
		expect(withInclude.posts).toBeArray();
	});

	test("toJSON on a model instance includes virtuals automatically", () => {
		class User extends Model(usersTableDef) {
			get displayName(): string {
				return this.firstName.toUpperCase();
			}
			online: boolean = false;
		}
		const user = new User({
			id: "1",
			firstName: "alice",
			lastName: "s",
			email: "a@test.com",
		});
		const json = user.toJSON();
		expect(json.displayName).toBe("ALICE");
		expect(json.online).toBe(false);
	});

	test("setting a virtual does not mark the instance as dirty", () => {
		class User extends Model(usersTableDef) {
			online: boolean = false;
		}
		const user = new User({
			id: "1",
			firstName: "A",
			lastName: "B",
			email: "x@test.com",
		});
		user.markPersisted();
		expect(user.changed()).toBe(false);
		user.online = true;
		expect(user.changed()).toBe(false);
	});
});

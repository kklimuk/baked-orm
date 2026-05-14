import { describe, expect, test } from "bun:test";

import { Model } from "../../src/model/base";
import { definePlugin, type PluginVirtual } from "../../src/plugins";
import type { TableDefinition } from "../../src/types";

class UsersRow {
	[key: string]: unknown;
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

// Per-test gate static — the test plugins below only contribute virtuals
// when a model class opts in via these flags. This keeps tests isolated:
// models without the flag are unaffected by the plugin.
type GatedModel = {
	enableAuditVirtuals?: boolean;
	enableConflictPluginA?: boolean;
	enableConflictPluginB?: boolean;
	enableSettableVirtual?: boolean;
};

definePlugin({
	name: "test-audit",
	virtuals(modelClass): Record<string, PluginVirtual> {
		if (!(modelClass as unknown as GatedModel).enableAuditVirtuals) return {};
		return {
			auditNote: {
				get: (instance) => `audit:${(instance as { name: string }).name}`,
			},
			fetchedAt: {
				get: () => 12345,
			},
		};
	},
});

definePlugin({
	name: "test-settable",
	virtuals(modelClass): Record<string, PluginVirtual> {
		if (!(modelClass as unknown as GatedModel).enableSettableVirtual) return {};
		const storage = new WeakMap<object, unknown>();
		return {
			settable: {
				get: (instance) => storage.get(instance as object) ?? null,
				set: (instance, value) => storage.set(instance as object, value),
			},
		};
	},
});

definePlugin({
	name: "test-conflict-a",
	virtuals(modelClass): Record<string, PluginVirtual> {
		if (!(modelClass as unknown as GatedModel).enableConflictPluginA) return {};
		return { sameName: { get: () => "from-a" } };
	},
});

definePlugin({
	name: "test-conflict-b",
	virtuals(modelClass): Record<string, PluginVirtual> {
		if (!(modelClass as unknown as GatedModel).enableConflictPluginB) return {};
		return { sameName: { get: () => "from-b" } };
	},
});

describe("plugin virtuals hook", () => {
	test("plugin contribution serializes through toJSON", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
		}
		const user = new User({ id: "1", name: "Alice" });
		const json = user.toJSON();
		expect(json.auditNote).toBe("audit:Alice");
		expect(json.fetchedAt).toBe(12345);
	});

	test("plugin contribution is accessible as a direct property read", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
		}
		const user = new User({ id: "1", name: "Bob" });
		expect((user as unknown as { auditNote: string }).auditNote).toBe(
			"audit:Bob",
		);
	});

	test("plugin without flag gets no virtuals", () => {
		class User extends Model(usersTableDef) {}
		const user = new User({ id: "1", name: "Alice" });
		const json = user.toJSON();
		expect(json).not.toHaveProperty("auditNote");
		expect(json).not.toHaveProperty("fetchedAt");
	});

	test("settable plugin virtual: assignment routes through plugin's set", () => {
		class User extends Model(usersTableDef) {
			static enableSettableVirtual = true;
		}
		const user = new User({ id: "1", name: "Alice" });
		expect((user as unknown as { settable: unknown }).settable).toBeNull();
		(user as unknown as { settable: string }).settable = "hello";
		expect((user as unknown as { settable: string }).settable).toBe("hello");
		expect(user.toJSON().settable).toBe("hello");
	});

	test("read-only plugin virtual: assignment throws in strict mode", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
		}
		const user = new User({ id: "1", name: "Alice" });
		expect(() => {
			(user as unknown as { auditNote: string }).auditNote = "override";
		}).toThrow(TypeError);
	});

	test("user-declared getter wins over plugin contribution", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
			get auditNote(): string {
				return "user-defined";
			}
		}
		const user = new User({ id: "1", name: "Alice" });
		expect(user.auditNote).toBe("user-defined");
		expect(user.toJSON().auditNote).toBe("user-defined");
	});

	test("user class field shadows plugin accessor (own-property precedence)", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
			auditNote: string = "from-class-field";
		}
		const user = new User({ id: "1", name: "Alice" });
		expect(user.auditNote).toBe("from-class-field");
		expect(user.toJSON().auditNote).toBe("from-class-field");
	});

	test("two plugins contributing the same name throws on first instantiation", () => {
		class Conflict extends Model(usersTableDef) {
			static enableConflictPluginA = true;
			static enableConflictPluginB = true;
		}
		expect(() => new Conflict({ id: "1", name: "x" })).toThrow(/sameName/);
	});

	test("plugin contribution colliding with a column is silently ignored", () => {
		// Plugin tries to contribute "name" (which is a column). Should be skipped.
		definePlugin({
			name: "test-column-collision",
			virtuals(modelClass): Record<string, PluginVirtual> {
				if (
					!(modelClass as unknown as { enableColumnCollision?: boolean })
						.enableColumnCollision
				)
					return {};
				return { name: { get: () => "from-plugin" } };
			},
		});

		class User extends Model(usersTableDef) {
			static enableColumnCollision = true;
		}
		const user = new User({ id: "1", name: "real-column-value" });
		// The actual column value wins, plugin contribution silently ignored
		expect(user.name).toBe("real-column-value");
		expect(user.toJSON().name).toBe("real-column-value");
	});

	test("snapshot dirty tracking is unaffected by plugin virtuals", () => {
		class User extends Model(usersTableDef) {
			static enableSettableVirtual = true;
		}
		const user = new User({ id: "1", name: "Alice" });
		user.markPersisted();
		expect(user.changed()).toBe(false);
		(user as unknown as { settable: string }).settable = "modified";
		expect(user.changed()).toBe(false);
		expect(user.changedAttributes()).toEqual({});
	});

	test("only/except filters apply to plugin virtuals", () => {
		class User extends Model(usersTableDef) {
			static enableAuditVirtuals = true;
		}
		const user = new User({ id: "1", name: "Alice" });
		const onlyResult = user.serialize({ only: ["id", "auditNote"] });
		expect(onlyResult.auditNote).toBe("audit:Alice");
		expect(onlyResult.fetchedAt).toBeUndefined();
		expect(onlyResult.name).toBeUndefined();

		const exceptResult = user.serialize({ except: ["fetchedAt"] });
		expect(exceptResult.auditNote).toBe("audit:Alice");
		expect(exceptResult).not.toHaveProperty("fetchedAt");
	});
});

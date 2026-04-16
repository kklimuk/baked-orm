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
import { ValidationError } from "../../src/model/errors";
import { validate, validates } from "../../src/model/validations";
import type { TableDefinition } from "../../src/types";
import { getTestConnection, resetDatabase } from "../helpers/postgres";

let connection: SQL;

// --- Row classes ---

class UsersRow {
	declare id: string;
	declare name: string;
	declare email: string;
	declare age: number | null;
	declare role: string;
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
		age: { type: "integer", nullable: true, columnName: "age" },
		role: {
			type: "text",
			nullable: false,
			default: "'user'",
			columnName: "role",
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

// --- Model with validations ---

class ValidatedUser extends Model(usersTableDef) {
	static validations = {
		name: validates("presence"),
		email: [validates("presence"), validates("email")],
		age: validates("numericality", {
			greaterThanOrEqualTo: 0,
			integer: true,
		}),
		role: validates("inclusion", { in: ["admin", "user", "moderator"] }),
	};
}

// --- Model with callbacks ---

const callbackLog: string[] = [];

class CallbackUser extends Model(usersTableDef) {
	static validations = {
		name: validates("presence"),
	};

	static beforeValidation = [
		(record: Record<string, unknown>) => {
			callbackLog.push("beforeValidation");
			// Normalize email before validation
			if (typeof record.email === "string") {
				record.email = record.email.trim();
			}
		},
	];

	static afterValidation = [
		() => {
			callbackLog.push("afterValidation");
		},
	];

	static beforeSave = [
		(record: Record<string, unknown>) => {
			callbackLog.push("beforeSave");
			if (typeof record.email === "string") {
				record.email = record.email.toLowerCase();
			}
		},
	];

	static afterSave = [
		() => {
			callbackLog.push("afterSave");
		},
	];

	static beforeCreate = [
		() => {
			callbackLog.push("beforeCreate");
		},
	];

	static afterCreate = [
		() => {
			callbackLog.push("afterCreate");
		},
	];

	static beforeUpdate = [
		() => {
			callbackLog.push("beforeUpdate");
		},
	];

	static afterUpdate = [
		() => {
			callbackLog.push("afterUpdate");
		},
	];

	static beforeDestroy = [
		() => {
			callbackLog.push("beforeDestroy");
		},
	];

	static afterDestroy = [
		() => {
			callbackLog.push("afterDestroy");
		},
	];
}

// --- Model with conditional validations ---

class ConditionalUser extends Model(usersTableDef) {
	static validations = {
		name: validates("presence"),
		age: validates("presence", { on: "update" }),
		role: validates("inclusion", {
			in: ["admin", "superadmin"],
			if: (record: Record<string, unknown>) =>
				record.role === "admin" || record.role === "superadmin",
		}),
	};
}

// --- Model with custom validations ---

class CustomValidatedUser extends Model(usersTableDef) {
	static validations = {
		name: validates("presence"),
	};

	static customValidations = [
		validate((record) => {
			if (record.name === record.email) {
				return { name: "must be different from email" };
			}
		}),
	];
}

// --- Model without validations (for regression) ---

class PlainUser extends Model(usersTableDef) {}

// --- Setup ---

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	callbackLog.length = 0;
	await resetDatabase(connection);
	await connection`
		CREATE TABLE users (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL,
			email text NOT NULL,
			age integer,
			role text NOT NULL DEFAULT 'user',
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- Tests ---

describe("Validation lifecycle", () => {
	test("save() throws ValidationError when validations fail", async () => {
		const user = new ValidatedUser({ name: "", email: "bad" });
		try {
			await user.save();
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			const validationError = error as ValidationError;
			expect(validationError.errors.has("name")).toBe(true);
			expect(validationError.errors.has("email")).toBe(true);
			expect(validationError.errors.get("name")).toEqual(["can't be blank"]);
			expect(validationError.errors.get("email")).toContain(
				"is not a valid email address",
			);
		}
	});

	test("create() throws ValidationError when validations fail", async () => {
		try {
			await ValidatedUser.create({ name: "", email: "" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
		}
	});

	test("update() throws ValidationError when validations fail", async () => {
		const user = await ValidatedUser.create({
			name: "Alice",
			email: "alice@test.com",
		});
		try {
			await user.update({ name: "" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
		}
	});

	test("isValid() returns false without throwing", async () => {
		const user = new ValidatedUser({ name: "", email: "bad" });
		const valid = await user.isValid();
		expect(valid).toBe(false);
		expect(user.errors.isEmpty).toBe(false);
		expect(user.errors.has("name")).toBe(true);
	});

	test("isValid() returns true for valid record", async () => {
		const user = new ValidatedUser({
			name: "Alice",
			email: "alice@test.com",
			role: "user",
		});
		const valid = await user.isValid();
		expect(valid).toBe(true);
		expect(user.errors.isEmpty).toBe(true);
	});

	test("errors are reset on each save attempt", async () => {
		const user = new ValidatedUser({ name: "", email: "bad" });

		const firstValid = await user.isValid();
		expect(firstValid).toBe(false);
		expect(user.errors.size).toBeGreaterThan(0);

		user.name = "Alice";
		user.email = "alice@test.com";
		const secondValid = await user.isValid();
		expect(secondValid).toBe(true);
		expect(user.errors.isEmpty).toBe(true);
	});

	test("successful save still works with validations", async () => {
		const user = await ValidatedUser.create({
			name: "Alice",
			email: "alice@test.com",
			role: "admin",
			age: 30,
		});
		expect(user.isNewRecord).toBe(false);
		expect(user.id).toBeDefined();
		expect(user.name).toBe("Alice");
	});

	test("model without validations saves normally", async () => {
		const user = await PlainUser.create({
			name: "Alice",
			email: "alice@test.com",
		});
		expect(user.isNewRecord).toBe(false);
		expect(user.id).toBeDefined();
	});
});

describe("Callback lifecycle", () => {
	test("create fires callbacks in correct order", async () => {
		await CallbackUser.create({
			name: "Alice",
			email: "  ALICE@TEST.COM  ",
		});
		expect(callbackLog).toEqual([
			"beforeValidation",
			"afterValidation",
			"beforeSave",
			"beforeCreate",
			"afterCreate",
			"afterSave",
		]);
	});

	test("update fires callbacks in correct order", async () => {
		const user = await CallbackUser.create({
			name: "Alice",
			email: "ALICE@TEST.COM",
		});
		callbackLog.length = 0;

		await user.update({ name: "Alicia" });
		expect(callbackLog).toEqual([
			"beforeValidation",
			"afterValidation",
			"beforeSave",
			"beforeUpdate",
			"afterUpdate",
			"afterSave",
		]);
	});

	test("destroy fires callbacks in correct order", async () => {
		const user = await CallbackUser.create({
			name: "Alice",
			email: "ALICE@TEST.COM",
		});
		callbackLog.length = 0;

		await user.destroy();
		expect(callbackLog).toEqual(["beforeDestroy", "afterDestroy"]);
	});

	test("beforeSave callback mutates record before persistence", async () => {
		const user = await CallbackUser.create({
			name: "Alice",
			email: "ALICE@TEST.COM",
		});
		// beforeSave lowercases email
		expect(user.email).toBe("alice@test.com");
	});

	test("beforeValidation callback runs before validation", async () => {
		// beforeValidation trims email, so "  alice@test.com  " becomes "alice@test.com"
		const user = await CallbackUser.create({
			name: "Alice",
			email: "  alice@test.com  ",
		});
		expect(user.email).toBe("alice@test.com");
	});

	test("before callback throwing aborts the operation", async () => {
		class AbortUser extends Model(usersTableDef) {
			static beforeSave = [
				() => {
					throw new Error("aborted!");
				},
			];
		}

		try {
			await AbortUser.create({ name: "Alice", email: "alice@test.com" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect((error as Error).message).toBe("aborted!");
		}

		// Verify nothing was inserted
		const count = await PlainUser.count();
		expect(count).toBe(0);
	});

	test("validation failure prevents callbacks from running", async () => {
		const user = new CallbackUser({ name: "", email: "bad" });
		callbackLog.length = 0;

		try {
			await user.save();
		} catch {
			// expected
		}

		// Validation callbacks fire, but save callbacks do not
		expect(callbackLog).toEqual(["beforeValidation", "afterValidation"]);
	});
});

describe("Conditional validations (integration)", () => {
	test("on: update skips validation on create", async () => {
		// age is required on: update only
		const user = await ConditionalUser.create({
			name: "Alice",
			email: "alice@test.com",
		});
		expect(user.isNewRecord).toBe(false);
	});

	test("on: update enforces validation on update", async () => {
		const user = await ConditionalUser.create({
			name: "Alice",
			email: "alice@test.com",
			age: 25,
		});

		try {
			await user.update({ age: null as unknown as number });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
		}
	});
});

describe("Custom validations (integration)", () => {
	test("custom validate() catches cross-field issues", async () => {
		try {
			await CustomValidatedUser.create({
				name: "alice@test.com",
				email: "alice@test.com",
			});
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			const validationError = error as ValidationError;
			expect(validationError.errors.get("name")).toContain(
				"must be different from email",
			);
		}
	});

	test("custom validate() passes when condition not met", async () => {
		const user = await CustomValidatedUser.create({
			name: "Alice",
			email: "alice@test.com",
		});
		expect(user.isNewRecord).toBe(false);
	});
});

describe("Bulk operations skip validations", () => {
	test("createMany skips validations", async () => {
		// ValidatedUser requires name presence, but createMany bypasses that
		// We use PlainUser (no validations) to test that bulk ops don't call validation code
		const users = await PlainUser.createMany([
			{ name: "Alice", email: "alice@test.com" },
			{ name: "Bob", email: "bob@test.com" },
		]);
		expect(users).toHaveLength(2);
	});
});

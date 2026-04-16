import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";

import { Model } from "../../src/model/base";
import { connect, transaction } from "../../src/model/connection";
import type { TableDefinition } from "../../src/types";
import { getTestConnection, resetDatabase } from "../helpers/postgres";

let connection: SQL;

// --- Row class ---

class AccountsRow {
	declare id: string;
	declare name: string;
	declare balance: number;
	declare createdAt: Date;
	declare updatedAt: Date;
}

const accountsTableDef: TableDefinition<AccountsRow> = {
	tableName: "accounts",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		name: { type: "text", nullable: false, columnName: "name" },
		balance: {
			type: "int4",
			nullable: false,
			default: "0",
			columnName: "balance",
		},
		createdAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "created_at",
		},
		updatedAt: {
			type: "timestamptz",
			nullable: false,
			default: "now()",
			columnName: "updated_at",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: AccountsRow,
};

class Account extends Model(accountsTableDef) {}

// --- Setup ---

beforeAll(async () => {
	connection = getTestConnection();
	await connect(connection);
});

afterAll(async () => {
	await connection.close();
});

beforeEach(async () => {
	await connection`
		CREATE TABLE IF NOT EXISTS accounts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name TEXT NOT NULL,
			balance INT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- QueryBuilder.lock() ---

describe("QueryBuilder.lock() — integration", () => {
	test("lock() throws outside a transaction", async () => {
		await Account.create({ name: "Alice", balance: 100 });
		await expect(
			Account.where({ name: "Alice" }).lock().first(),
		).rejects.toThrow("lock() requires a transaction");
	});

	test("lock() works inside a transaction", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		await transaction(async () => {
			const locked = await Account.where({ id: account.id }).lock().first();
			expect(locked?.name).toBe("Alice");
			expect(locked?.balance).toBe(100);
		});
	});

	test("lock('FOR SHARE') works inside a transaction", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		await transaction(async () => {
			const locked = await Account.where({ id: account.id })
				.lock("FOR SHARE")
				.first();
			expect(locked?.balance).toBe(100);
		});
	});
});

// --- Instance lock() ---

describe("instance lock()", () => {
	test("lock() re-fetches and refreshes attributes", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });

		// Modify balance directly in DB
		await connection`UPDATE accounts SET balance = 200 WHERE id = ${account.id}`;

		await transaction(async () => {
			await account.lock();
			expect(account.balance).toBe(200);
		});
	});

	test("lock() throws on new record", async () => {
		const account = new Account({ name: "Alice", balance: 100 });
		await expect(
			transaction(async () => {
				await account.lock();
			}),
		).rejects.toThrow("Cannot lock a new record");
	});

	test("lock() throws outside transaction", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		await expect(account.lock()).rejects.toThrow(
			"lock() requires a transaction",
		);
	});

	test("lock() accepts a custom mode", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		await transaction(async () => {
			await account.lock("FOR NO KEY UPDATE");
			expect(account.balance).toBe(100);
		});
	});
});

// --- Instance withLock() ---

describe("instance withLock()", () => {
	test("withLock() wraps in transaction, locks, and runs callback", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });

		// Modify balance directly in DB before withLock
		await connection`UPDATE accounts SET balance = 200 WHERE id = ${account.id}`;

		await account.withLock(async (locked) => {
			// Should have refreshed from DB
			expect(locked.balance).toBe(200);
			locked.balance = 300;
			await locked.save();
		});

		// Verify persisted
		const reloaded = await Account.find(account.id);
		expect(reloaded.balance).toBe(300);
	});

	test("withLock() returns the callback result", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		const result = await account.withLock(async (locked) => {
			return locked.balance * 2;
		});
		expect(result).toBe(200);
	});

	test("withLock() with custom mode", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });
		await account.withLock(async (locked) => {
			expect(locked.balance).toBe(100);
		}, "FOR SHARE");
	});

	test("withLock() throws on new record", async () => {
		const account = new Account({ name: "Alice", balance: 100 });
		await expect(account.withLock(async () => {})).rejects.toThrow(
			"Cannot lock a new record",
		);
	});

	test("withLock() rolls back on error", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });

		try {
			await account.withLock(async (locked) => {
				locked.balance = 0;
				await locked.save();
				throw new Error("simulated failure");
			});
		} catch {
			// expected
		}

		// Balance should be unchanged because transaction rolled back
		const reloaded = await Account.find(account.id);
		expect(reloaded.balance).toBe(100);
	});
});

// --- Concurrency ---

describe("concurrency", () => {
	test("two concurrent transactions: second blocks until first commits", async () => {
		const account = await Account.create({ name: "Alice", balance: 100 });

		// We need separate connections for true concurrency
		const connection2 = new SQL({
			database: "baked_orm_test",
			max: 1,
		});

		const order: string[] = [];

		const transaction1 = connection.begin(async (txn1) => {
			await txn1`SELECT * FROM accounts WHERE id = ${account.id} FOR UPDATE`;
			order.push("txn1:locked");

			// Hold the lock for a bit
			await new Promise((resolve) => setTimeout(resolve, 100));

			await txn1`UPDATE accounts SET balance = 50 WHERE id = ${account.id}`;
			order.push("txn1:updated");
		});

		// Give txn1 a moment to acquire the lock
		await new Promise((resolve) => setTimeout(resolve, 20));

		const transaction2 = connection2.begin(async (txn2) => {
			// This will block until txn1 releases the lock
			const rows =
				await txn2`SELECT * FROM accounts WHERE id = ${account.id} FOR UPDATE`;
			order.push("txn2:locked");

			const balance = (rows[0] as { balance: number }).balance;
			// Should see txn1's committed value
			expect(balance).toBe(50);
		});

		await Promise.all([transaction1, transaction2]);

		expect(order).toEqual(["txn1:locked", "txn1:updated", "txn2:locked"]);

		await connection2.close();
	});
});

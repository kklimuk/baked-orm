import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { SQL } from "bun";

import { Model } from "../../src/model/base";
import type { QueryLogEntry } from "../../src/model/connection";
import { connect } from "../../src/model/connection";
import type { TableDefinition } from "../../src/types";
import { getTestConnection, resetDatabase } from "../helpers/postgres";

let connection: SQL;

// --- Schema with a sensitive column ---

class AccountsRow {
	declare id: string;
	declare email: string;
	declare passwordDigest: string;
	declare apiToken: string | null;
	declare createdAt: Date;
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
		email: { type: "text", nullable: false, columnName: "email" },
		passwordDigest: {
			type: "text",
			nullable: false,
			columnName: "password_digest",
		},
		apiToken: { type: "text", nullable: true, columnName: "api_token" },
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
	rowClass: AccountsRow,
};

class Account extends Model(accountsTableDef) {
	static sensitiveFields = ["passwordDigest", "apiToken"];
}

// --- Setup ---

beforeAll(async () => {
	connection = getTestConnection();
});

afterAll(async () => {
	await resetDatabase(connection);
	await connection.close();
});

beforeEach(async () => {
	await resetDatabase(connection);
	await connection`
		CREATE TABLE accounts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			email text NOT NULL,
			password_digest text NOT NULL,
			api_token text,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await connection`CREATE UNIQUE INDEX idx_accounts_email ON accounts (email)`;
});

// --- Helper to capture logs ---

async function withQueryLogs(
	callback: () => Promise<void>,
): Promise<QueryLogEntry[]> {
	const logs: QueryLogEntry[] = [];
	await connect(connection, { onQuery: (entry) => logs.push(entry) });
	try {
		await callback();
	} finally {
		await connect(connection);
	}
	return logs;
}

function assertNoSecretInValues(
	logs: QueryLogEntry[],
	secrets: string[],
): void {
	for (const log of logs) {
		if (!log.values) continue;
		for (const value of log.values) {
			for (const secret of secrets) {
				expect(value).not.toBe(secret);
			}
		}
	}
}

// --- Tests ---

describe("Sensitive field redaction in query logs", () => {
	test("create() redacts sensitive values in INSERT log", async () => {
		const logs = await withQueryLogs(async () => {
			await Account.create({
				email: "alice@test.com",
				passwordDigest: "super-secret-hash",
				apiToken: "tok_abc123",
			});
		});

		const insertLog = logs.find((log) => log.text.includes("INSERT"));
		expect(insertLog).toBeDefined();
		expect(insertLog?.values).toContain("alice@test.com");
		expect(insertLog?.values).not.toContain("super-secret-hash");
		expect(insertLog?.values).not.toContain("tok_abc123");
		expect(insertLog?.values).toContain("[REDACTED]");
	});

	test("save() on update redacts sensitive values in UPDATE log", async () => {
		const account = await Account.create({
			email: "alice@test.com",
			passwordDigest: "old-hash",
			apiToken: "tok_old",
		});

		const logs = await withQueryLogs(async () => {
			account.passwordDigest = "new-secret-hash";
			await account.save();
		});

		const updateLog = logs.find((log) => log.text.includes("UPDATE"));
		expect(updateLog).toBeDefined();
		expect(updateLog?.values).not.toContain("new-secret-hash");
		expect(updateLog?.values).toContain("[REDACTED]");
	});

	test("where() redacts sensitive values in SELECT log", async () => {
		await Account.create({
			email: "alice@test.com",
			passwordDigest: "hash123",
			apiToken: "tok_xyz",
		});

		const logs = await withQueryLogs(async () => {
			await Account.where({ passwordDigest: "hash123" }).toArray();
		});

		const selectLog = logs.find((log) => log.text.includes("SELECT"));
		expect(selectLog).toBeDefined();
		expect(selectLog?.values).not.toContain("hash123");
		expect(selectLog?.values).toContain("[REDACTED]");
	});

	test("findBy() with sensitive field redacts in log", async () => {
		await Account.create({
			email: "alice@test.com",
			passwordDigest: "hash123",
			apiToken: "tok_find",
		});

		const logs = await withQueryLogs(async () => {
			await Account.findBy({ apiToken: "tok_find" });
		});

		const selectLog = logs.find((log) => log.text.includes("SELECT"));
		expect(selectLog).toBeDefined();
		expect(selectLog?.values).not.toContain("tok_find");
		expect(selectLog?.values).toContain("[REDACTED]");
	});

	test("createMany() redacts sensitive values across all rows", async () => {
		const logs = await withQueryLogs(async () => {
			await Account.createMany([
				{
					email: "alice@test.com",
					passwordDigest: "hash-alice",
					apiToken: "tok_alice",
				},
				{
					email: "bob@test.com",
					passwordDigest: "hash-bob",
					apiToken: "tok_bob",
				},
			]);
		});

		const insertLog = logs.find((log) => log.text.includes("INSERT"));
		expect(insertLog).toBeDefined();
		// Emails should be visible
		expect(insertLog?.values).toContain("alice@test.com");
		expect(insertLog?.values).toContain("bob@test.com");
		// Passwords and tokens should be redacted
		assertNoSecretInValues(logs, [
			"hash-alice",
			"hash-bob",
			"tok_alice",
			"tok_bob",
		]);
	});

	test("upsert() redacts sensitive values", async () => {
		const logs = await withQueryLogs(async () => {
			await Account.upsert(
				{
					email: "alice@test.com",
					passwordDigest: "upsert-hash",
					apiToken: "tok_upsert",
				},
				{ conflict: { columns: ["email"] } },
			);
		});

		const insertLog = logs.find((log) => log.text.includes("INSERT"));
		expect(insertLog).toBeDefined();
		expect(insertLog?.values).toContain("alice@test.com");
		expect(insertLog?.values).not.toContain("upsert-hash");
		expect(insertLog?.values).not.toContain("tok_upsert");
	});

	test("updateAll() redacts sensitive values in SET clause", async () => {
		await Account.create({
			email: "alice@test.com",
			passwordDigest: "old-hash",
		});

		const logs = await withQueryLogs(async () => {
			await Account.where({ email: "alice@test.com" }).updateAll({
				passwordDigest: "bulk-new-hash",
			});
		});

		const updateLog = logs.find((log) => log.text.includes("UPDATE"));
		expect(updateLog).toBeDefined();
		expect(updateLog?.values).not.toContain("bulk-new-hash");
		expect(updateLog?.values).toContain("[REDACTED]");
		// email in WHERE should still be visible
		expect(updateLog?.values).toContain("alice@test.com");
	});

	test("non-sensitive values are never redacted", async () => {
		const logs = await withQueryLogs(async () => {
			const account = await Account.create({
				email: "alice@test.com",
				passwordDigest: "hash",
			});
			await Account.where({ email: "alice@test.com" }).toArray();
			account.email = "newalice@test.com";
			await account.save();
		});

		// Every log entry should have email values visible
		const allLogValues = logs.flatMap((log) => log.values ?? []);
		expect(allLogValues).toContain("alice@test.com");
	});

	test("the actual data is persisted correctly despite redacted logs", async () => {
		await Account.create({
			email: "alice@test.com",
			passwordDigest: "real-hash-value",
			apiToken: "real-token",
		});

		const account = await Account.findBy({ email: "alice@test.com" });
		expect(account).not.toBeNull();
		expect(account?.passwordDigest).toBe("real-hash-value");
		expect(account?.apiToken).toBe("real-token");
	});
});

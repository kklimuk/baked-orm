import { describe, expect, test } from "bun:test";

import { QueryBuilder } from "../../src/model/query";
import type { TableDefinition } from "../../src/types";

class AccountsRow {
	declare id: string;
	declare balance: number;
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
		balance: {
			type: "int4",
			nullable: false,
			default: "0",
			columnName: "balance",
		},
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: AccountsRow,
};

describe("QueryBuilder.lock() — SQL generation", () => {
	test("lock() defaults to FOR UPDATE", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock();
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR UPDATE");
	});

	test("lock('FOR SHARE') appends FOR SHARE", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock("FOR SHARE");
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR SHARE");
	});

	test("lock('FOR NO KEY UPDATE') appends correct clause", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock("FOR NO KEY UPDATE");
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR NO KEY UPDATE");
	});

	test("lock('FOR KEY SHARE') appends correct clause", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock("FOR KEY SHARE");
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR KEY SHARE");
	});

	test("lock('FOR UPDATE NOWAIT') appends NOWAIT suffix", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock("FOR UPDATE NOWAIT");
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR UPDATE NOWAIT");
	});

	test("lock('FOR UPDATE SKIP LOCKED') appends SKIP LOCKED suffix", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.lock("FOR UPDATE SKIP LOCKED");
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR UPDATE SKIP LOCKED");
	});

	test("lock clause appears after LIMIT", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.limit(1)
			.lock();
		const { text } = query.toSQL();
		expect(text).toContain("LIMIT 1 FOR UPDATE");
	});

	test("lock clause appears after OFFSET", () => {
		const query = new QueryBuilder(accountsTableDef)
			.where({ id: "abc" })
			.limit(10)
			.offset(5)
			.lock();
		const { text } = query.toSQL();
		expect(text).toContain("OFFSET 5 FOR UPDATE");
	});

	test("lock is preserved through clone chain", () => {
		const query = new QueryBuilder(accountsTableDef)
			.lock()
			.where({ id: "abc" });
		const { text } = query.toSQL();
		expect(text).toEndWith("FOR UPDATE");
	});

	test("lock on recursive scope throws", () => {
		class PagesRow {
			declare id: string;
			declare parentId: string | null;
			declare title: string;
		}

		const pagesTableDef: TableDefinition<PagesRow> = {
			tableName: "pages",
			columns: {
				id: {
					type: "uuid",
					nullable: false,
					default: "gen_random_uuid()",
					columnName: "id",
				},
				parentId: {
					type: "uuid",
					nullable: true,
					columnName: "parent_id",
				},
				title: { type: "text", nullable: false, columnName: "title" },
			},
			primaryKey: ["id"],
			indexes: {},
			foreignKeys: {},
			rowClass: PagesRow,
		};

		const recursive = new QueryBuilder(pagesTableDef)
			.where({ id: "root" })
			.descendants({ via: "parentId" });

		expect(() => recursive.lock()).toThrow(
			"Cannot call lock() on a recursive query",
		);
	});
});

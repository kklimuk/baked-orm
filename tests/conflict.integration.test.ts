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

import { Model } from "../src/model/base";
import { connect } from "../src/model/connection";
import type { TableDefinition } from "../src/types";
import { getTestConnection, resetDatabase } from "./helpers/postgres";

let connection: SQL;

// --- Row classes ---

class ProductsRow {
	declare id: string;
	declare code: string;
	declare category: string;
	declare active: boolean;
	declare createdAt: Date;
}

const productsTableDef: TableDefinition<ProductsRow> = {
	tableName: "products",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		code: { type: "text", nullable: false, columnName: "code" },
		category: { type: "text", nullable: false, columnName: "category" },
		active: {
			type: "boolean",
			nullable: false,
			default: "true",
			columnName: "active",
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
	rowClass: ProductsRow,
};

const Product = Model(productsTableDef);

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
		CREATE TABLE products (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			code text NOT NULL,
			category text NOT NULL,
			active boolean NOT NULL DEFAULT true,
			created_at timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT uq_products_code_category UNIQUE (code, category)
		)
	`;
	// Partial unique indexes — same code can exist once per active/inactive
	await connection`
		CREATE UNIQUE INDEX idx_products_code_active
		ON products (code) WHERE active = true
	`;
	await connection`
		CREATE UNIQUE INDEX idx_products_code_inactive
		ON products (code) WHERE active = false
	`;
});

afterEach(async () => {
	await resetDatabase(connection);
});

// --- Tests ---

describe("conflict options", () => {
	describe("upsert with conflict.columns", () => {
		test("basic column-based upsert using multi-column constraint", async () => {
			await Product.create({ code: "ABC", category: "widgets" });
			const upserted = await Product.upsert(
				{ code: "ABC", category: "widgets", active: false },
				{ conflict: { columns: ["code", "category"] } },
			);
			expect(upserted.code).toBe("ABC");
			expect(upserted.active).toBe(false);
			expect(await Product.count()).toBe(1);
		});

		test("upsert inserts when no conflict", async () => {
			const product = await Product.upsert(
				{ code: "NEW", category: "widgets" },
				{ conflict: { columns: ["code", "category"] } },
			);
			expect(product.id).toBeDefined();
			expect(product.code).toBe("NEW");
		});
	});

	describe("upsert with conflict.where (partial index)", () => {
		test("upsert matches partial index with where clause", async () => {
			await Product.create({ code: "ABC", category: "widgets", active: true });

			const upserted = await Product.upsert(
				{ code: "ABC", category: "updated", active: true },
				{
					conflict: {
						columns: ["code"],
						where: { active: true },
					},
				},
			);

			expect(upserted.category).toBe("updated");
			expect(await Product.count()).toBe(1);
		});

		test("partial index isolation: active and inactive coexist", async () => {
			await Product.create({
				code: "ABC",
				category: "active-cat",
				active: true,
			});
			await Product.create({
				code: "ABC",
				category: "inactive-cat",
				active: false,
			});

			expect(await Product.count()).toBe(2);

			// Upsert targeting active partial index only updates the active row
			const upserted = await Product.upsert(
				{ code: "ABC", category: "active-updated", active: true },
				{
					conflict: {
						columns: ["code"],
						where: { active: true },
					},
				},
			);

			expect(upserted.category).toBe("active-updated");
			expect(await Product.count()).toBe(2);

			// Inactive row is untouched
			const inactive = await Product.findBy({ active: false });
			expect(inactive?.category).toBe("inactive-cat");
		});

		test("conflictWhere with null check for inactive partial index", async () => {
			await Product.create({ code: "ABC", category: "widgets", active: false });

			// where: { active: false } matches the idx_products_code_inactive index
			const upserted = await Product.upsert(
				{ code: "ABC", category: "updated", active: false },
				{
					conflict: {
						columns: ["code"],
						where: { active: false },
					},
				},
			);

			expect(upserted.category).toBe("updated");
		});
	});

	describe("upsertAll with conflict.where", () => {
		test("batch upsert with partial index", async () => {
			await Product.create({ code: "A", category: "old-a", active: true });
			await Product.create({ code: "B", category: "old-b", active: true });

			const results = await Product.upsertAll(
				[
					{ code: "A", category: "new-a", active: true },
					{ code: "B", category: "new-b", active: true },
					{ code: "C", category: "new-c", active: true },
				],
				{
					conflict: {
						columns: ["code"],
						where: { active: true },
					},
				},
			);

			expect(results).toHaveLength(3);
			expect(results.find((product) => product.code === "A")?.category).toBe(
				"new-a",
			);
			expect(results.find((product) => product.code === "B")?.category).toBe(
				"new-b",
			);
			expect(results.find((product) => product.code === "C")?.category).toBe(
				"new-c",
			);
			expect(await Product.count()).toBe(3);
		});
	});

	describe("upsert with conflict.constraint (named constraint)", () => {
		test("upsert via named constraint", async () => {
			await Product.create({ code: "ABC", category: "widgets" });

			const upserted = await Product.upsert(
				{ code: "ABC", category: "widgets", active: false },
				{ conflict: { constraint: "uq_products_code_category" } },
			);

			expect(upserted.active).toBe(false);
			expect(await Product.count()).toBe(1);
		});

		test("upsertAll via named constraint", async () => {
			await Product.create({ code: "X", category: "cat1" });

			const results = await Product.upsertAll(
				[
					{ code: "X", category: "cat1", active: false },
					{ code: "Y", category: "cat2", active: true },
				],
				{ conflict: { constraint: "uq_products_code_category" } },
			);

			expect(results).toHaveLength(2);
			expect(await Product.count()).toBe(2);
		});
	});

	describe("upsert with action override", () => {
		test("upsert with action: ignore throws when conflict matches", async () => {
			await Product.create({ code: "ABC", category: "original" });

			await expect(
				Product.upsert(
					{ code: "ABC", category: "original", active: false },
					{ conflict: { columns: ["code", "category"], action: "ignore" } },
				),
			).rejects.toThrow("no row returned");

			// Original row untouched
			const stored = await Product.findBy({ code: "ABC" });
			expect(stored?.active).toBe(true);
		});

		test("upsert with conflict: ignore throws when conflict matches", async () => {
			await Product.create({ code: "ABC", category: "original" });

			await expect(
				Product.upsert(
					{ code: "ABC", category: "original" },
					{ conflict: "ignore" },
				),
			).rejects.toThrow("no row returned");
		});

		test("upsert with action: ignore succeeds when no conflict", async () => {
			const product = await Product.upsert(
				{ code: "NEW", category: "widgets" },
				{ conflict: { columns: ["code", "category"], action: "ignore" } },
			);

			expect(product.id).toBeDefined();
			expect(product.code).toBe("NEW");
		});
	});

	describe("create with conflict", () => {
		test("create with conflict: ignore skips duplicate", async () => {
			await Product.create({ code: "ABC", category: "original" });

			const duplicate = await Product.create(
				{ code: "ABC", category: "original" },
				{ conflict: "ignore" },
			);

			// Instance should not be persisted since DO NOTHING returned no rows
			expect(duplicate.isNewRecord).toBe(true);
			expect(await Product.count()).toBe(1);
		});

		test("create with conflict inserts when no conflict", async () => {
			const product = await Product.create(
				{ code: "NEW", category: "widgets" },
				{ conflict: "ignore" },
			);

			expect(product.isNewRecord).toBe(false);
			expect(product.id).toBeDefined();
		});

		test("create with targeted conflict", async () => {
			await Product.create({ code: "ABC", category: "original" });

			const duplicate = await Product.create(
				{ code: "ABC", category: "original" },
				{ conflict: { columns: ["code", "category"] } },
			);

			expect(duplicate.isNewRecord).toBe(true);
			expect(await Product.count()).toBe(1);
		});
	});

	describe("createMany with conflict", () => {
		test("createMany with conflict: ignore skips duplicates", async () => {
			await Product.create({ code: "A", category: "existing" });

			const results = await Product.createMany(
				[
					{ code: "A", category: "existing" },
					{ code: "B", category: "new" },
				],
				{ conflict: "ignore" },
			);

			// Only the non-conflicting row is returned
			expect(results).toHaveLength(1);
			expect(results[0]?.code).toBe("B");
			expect(await Product.count()).toBe(2);
		});

		test("createMany with conflict: ignore when all duplicates", async () => {
			await Product.create({ code: "A", category: "existing" });

			const results = await Product.createMany(
				[{ code: "A", category: "existing" }],
				{ conflict: "ignore" },
			);

			expect(results).toHaveLength(0);
			expect(await Product.count()).toBe(1);
		});

		test("createMany with targeted conflict columns", async () => {
			await Product.create({ code: "A", category: "existing" });

			const results = await Product.createMany(
				[
					{ code: "A", category: "existing" },
					{ code: "B", category: "new" },
				],
				{ conflict: { columns: ["code", "category"] } },
			);

			expect(results).toHaveLength(1);
			expect(results[0]?.code).toBe("B");
		});

		test("createMany with conflict.where targets partial index", async () => {
			await Product.create({ code: "A", category: "active-cat", active: true });

			const results = await Product.createMany(
				[
					{ code: "A", category: "active-dup", active: true },
					{ code: "A", category: "inactive-new", active: false },
				],
				{
					conflict: {
						columns: ["code"],
						where: { active: true },
					},
				},
			);

			// Only the inactive row is inserted (active one conflicts on partial index)
			expect(results).toHaveLength(1);
			expect(results[0]?.active).toBe(false);
			expect(await Product.count()).toBe(2);
		});

		test("createMany with named constraint", async () => {
			await Product.create({ code: "A", category: "existing", active: true });

			const results = await Product.createMany(
				[
					{ code: "A", category: "existing", active: true },
					{ code: "B", category: "new", active: true },
				],
				{ conflict: { constraint: "uq_products_code_category" } },
			);

			expect(results).toHaveLength(1);
			expect(results[0]?.code).toBe("B");
		});
	});
});

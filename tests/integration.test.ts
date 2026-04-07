import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { SQL } from "bun";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
	ensureMigrationsTable,
	getAppliedVersions,
	migrateDown,
	migrateUp,
} from "../src/runner";
import type { ResolvedConfig } from "../src/types";
import { getTestConnection, resetDatabase } from "./helpers/postgres";

let connection: SQL;
let tempDir: string;

function makeConfig(migrationsPath: string): ResolvedConfig {
	return {
		migrationsPath,
		schemaPath: join(tempDir, "schema.ts"),
		modelsPath: "./models",
		frontendModelsPath: "./frontend/models",
	};
}

const CREATE_USERS_MIGRATION = `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
	await txn\`
		CREATE TABLE users (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name text NOT NULL,
			email text NOT NULL UNIQUE,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	\`;
}

export async function down(txn: TransactionSQL) {
	await txn\`DROP TABLE users\`;
}
`;

const CREATE_POSTS_MIGRATION = `import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
	await txn\`
		CREATE TABLE posts (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id uuid NOT NULL REFERENCES users(id),
			title text NOT NULL,
			body text,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	\`;
}

export async function down(txn: TransactionSQL) {
	await txn\`DROP TABLE posts\`;
}
`;

beforeAll(() => {
	connection = getTestConnection();
});

afterEach(async () => {
	await resetDatabase(connection);
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
	}
});

afterAll(async () => {
	await connection.close();
});

async function setupMigrations(
	...migrations: { version: string; name: string; content: string }[]
): Promise<string> {
	tempDir = join(tmpdir(), `baked-integ-${Date.now()}`);
	const migrationsDir = join(tempDir, "migrations");
	await mkdir(migrationsDir, { recursive: true });

	for (const migration of migrations) {
		const filename = `${migration.version}.${migration.name}.ts`;
		await writeFile(join(migrationsDir, filename), migration.content);
	}

	return migrationsDir;
}

describe("ensureMigrationsTable", () => {
	test("creates schema_migrations table", async () => {
		await ensureMigrationsTable(connection);

		const rows: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'schema_migrations'
		`;
		expect(rows).toHaveLength(1);
	});

	test("is idempotent", async () => {
		await ensureMigrationsTable(connection);
		await ensureMigrationsTable(connection);

		const rows: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'schema_migrations'
		`;
		expect(rows).toHaveLength(1);
	});
});

describe("migrateUp", () => {
	test("applies all pending migrations", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		const result = await migrateUp(connection, config, null);

		expect(result.applied).toBe(2);
		expect(result.version).toBe("20240101000001");

		// Verify tables exist
		const tables: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name IN ('users', 'posts')
			ORDER BY table_name
		`;
		expect(tables.map((row) => row.table_name)).toEqual(["posts", "users"]);
	});

	test("respects count parameter", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		const result = await migrateUp(connection, config, 1);

		expect(result.applied).toBe(1);
		expect(result.version).toBe("20240101000000");

		// Only users table should exist
		const tables: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name IN ('users', 'posts')
		`;
		expect(tables).toHaveLength(1);
		expect(tables[0]?.table_name).toBe("users");
	});

	test("skips already applied migrations", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		await migrateUp(connection, config, 1);
		const result = await migrateUp(connection, config, null);

		expect(result.applied).toBe(1);
		expect(result.version).toBe("20240101000001");
	});

	test("reports zero when nothing pending", async () => {
		const migrationsDir = await setupMigrations({
			version: "20240101000000",
			name: "create_users",
			content: CREATE_USERS_MIGRATION,
		});

		const config = makeConfig(migrationsDir);
		await migrateUp(connection, config, null);
		const result = await migrateUp(connection, config, null);

		expect(result.applied).toBe(0);
	});
});

describe("migrateDown", () => {
	test("rolls back last migration", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		await migrateUp(connection, config, null);

		const result = await migrateDown(connection, config, 1);
		expect(result.applied).toBe(1);
		expect(result.version).toBe("20240101000000");

		// Posts table should be gone, users should remain
		const tables: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name IN ('users', 'posts')
		`;
		expect(tables).toHaveLength(1);
		expect(tables[0]?.table_name).toBe("users");
	});

	test("rolls back multiple migrations", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		await migrateUp(connection, config, null);

		const result = await migrateDown(connection, config, 2);
		expect(result.applied).toBe(2);
		expect(result.version).toBeUndefined();

		const tables: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name IN ('users', 'posts')
		`;
		expect(tables).toHaveLength(0);
	});

	test("reports zero when nothing to rollback", async () => {
		const migrationsDir = await setupMigrations();
		const config = makeConfig(migrationsDir);
		await ensureMigrationsTable(connection);

		const result = await migrateDown(connection, config, 1);
		expect(result.applied).toBe(0);
	});
});

describe("getAppliedVersions", () => {
	test("returns applied versions after migration", async () => {
		const migrationsDir = await setupMigrations(
			{
				version: "20240101000000",
				name: "create_users",
				content: CREATE_USERS_MIGRATION,
			},
			{
				version: "20240101000001",
				name: "create_posts",
				content: CREATE_POSTS_MIGRATION,
			},
		);

		const config = makeConfig(migrationsDir);
		await migrateUp(connection, config, null);

		const versions = await getAppliedVersions(connection);
		expect(versions.size).toBe(2);
		expect(versions.has("20240101000000")).toBe(true);
		expect(versions.has("20240101000001")).toBe(true);
	});

	test("returns empty set when no migrations applied", async () => {
		await ensureMigrationsTable(connection);
		const versions = await getAppliedVersions(connection);
		expect(versions.size).toBe(0);
	});
});

describe("full migration lifecycle", () => {
	test("up → verify data → down → verify clean", async () => {
		const migrationsDir = await setupMigrations({
			version: "20240101000000",
			name: "create_users",
			content: CREATE_USERS_MIGRATION,
		});

		const config = makeConfig(migrationsDir);

		// Migrate up
		await migrateUp(connection, config, null);

		// Insert data
		await connection`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`;
		const users: { name: string }[] = await connection`SELECT name FROM users`;
		expect(users).toHaveLength(1);
		expect(users[0]?.name).toBe("Alice");

		// Migrate down
		await migrateDown(connection, config, 1);

		// Table should be gone
		const tables: { table_name: string }[] = await connection`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'users'
		`;
		expect(tables).toHaveLength(0);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { discoverMigrations } from "../src/runner";
import type { ResolvedConfig } from "../src/types";

function makeConfig(migrationsPath: string): ResolvedConfig {
	return { migrationsPath, schemaPath: "./db/schema.ts" };
}

describe("discoverMigrations", () => {
	test("discovers and sorts migration files by version", async () => {
		const tempDir = join(tmpdir(), `baked-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			await writeFile(
				join(tempDir, "20240115083100.create_posts.ts"),
				"export async function up() {} export async function down() {}",
			);
			await writeFile(
				join(tempDir, "20240115083045.create_users.ts"),
				"export async function up() {} export async function down() {}",
			);

			const migrations = await discoverMigrations(makeConfig(tempDir));

			expect(migrations).toHaveLength(2);
			expect(migrations[0]?.version).toBe("20240115083045");
			expect(migrations[0]?.name).toBe("create_users");
			expect(migrations[0]?.file).toBe("20240115083045.create_users.ts");
			expect(migrations[1]?.version).toBe("20240115083100");
			expect(migrations[1]?.name).toBe("create_posts");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("returns empty array for empty directory", async () => {
		const tempDir = join(tmpdir(), `baked-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const migrations = await discoverMigrations(makeConfig(tempDir));
			expect(migrations).toHaveLength(0);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("ignores non-ts files", async () => {
		const tempDir = join(tmpdir(), `baked-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			await writeFile(join(tempDir, "20240115083045.create_users.ts"), "");
			await writeFile(join(tempDir, "README.md"), "");
			await writeFile(join(tempDir, ".gitkeep"), "");

			const migrations = await discoverMigrations(makeConfig(tempDir));
			expect(migrations).toHaveLength(1);
			expect(migrations[0]?.version).toBe("20240115083045");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("throws on duplicate timestamps", async () => {
		const tempDir = join(tmpdir(), `baked-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			await writeFile(
				join(tempDir, "20240115083045.create_users.ts"),
				"export async function up() {} export async function down() {}",
			);
			await writeFile(
				join(tempDir, "20240115083045.create_posts.ts"),
				"export async function up() {} export async function down() {}",
			);

			expect(discoverMigrations(makeConfig(tempDir))).rejects.toThrow(
				"Migration timestamp conflict detected",
			);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("handles migration names with multiple dots", async () => {
		const tempDir = join(tmpdir(), `baked-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			await writeFile(join(tempDir, "20240115083045.create_users.v2.ts"), "");

			const migrations = await discoverMigrations(makeConfig(tempDir));
			expect(migrations).toHaveLength(1);
			expect(migrations[0]?.version).toBe("20240115083045");
			expect(migrations[0]?.name).toBe("create_users.v2");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

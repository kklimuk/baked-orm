import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const cliPath = join(import.meta.dir, "../src/cli.ts");

function runCli(
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
) {
	return Bun.spawn(["bun", "run", cliPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: options?.cwd,
		env: { ...process.env, ...options?.env },
	});
}

async function collectOutput(proc: ReturnType<typeof runCli>) {
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe("CLI", () => {
	test("shows usage when no namespace is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli([]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("shows usage for invalid namespace", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["invalid"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("lists namespaces in usage", async () => {
		const { stderr } = await collectOutput(runCli([]));
		expect(stderr).toContain("db");
		expect(stderr).toContain("model");
	});

	test("shows db usage when no db command is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["db"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage: bake db <command>");
	});
});

describe("CLI db generate", () => {
	test("shows error when no migration name is provided", async () => {
		const { exitCode, stderr } = await collectOutput(
			runCli(["db", "generate"]),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("creates migration file in temp directory", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		const migrationsDir = join(tempDir, "db", "migrations");
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode, stdout } = await collectOutput(
				runCli(["db", "generate", "create_users"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created");
			expect(stdout).toContain("create_users");

			const glob = new Bun.Glob("*.create_users.ts");
			const files: string[] = [];
			for await (const file of glob.scan(migrationsDir)) {
				files.push(file);
			}
			expect(files).toHaveLength(1);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("CLI db init", () => {
	test("creates baked.config.ts", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode, stdout } = await collectOutput(
				runCli(["db", "init"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created");
			expect(stdout).toContain("baked.config.ts");

			const configExists = await Bun.file(
				join(tempDir, "baked.config.ts"),
			).exists();
			expect(configExists).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("skips if baked.config.ts already exists", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			await writeFile(join(tempDir, "baked.config.ts"), "export default {};");

			const { exitCode, stderr } = await collectOutput(
				runCli(["db", "init"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);
			expect(stderr).toContain("already exists");

			const content = await Bun.file(join(tempDir, "baked.config.ts")).text();
			expect(content).toBe("export default {};");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("CLI db create/drop", () => {
	const testDbName = `baked_cli_test_${Date.now()}`;

	test("shows error when no database name is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["db", "create"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("creates a database", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["db", "create", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Created");
		expect(stdout).toContain(testDbName);
	});

	test("handles already-existing database gracefully", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["db", "create", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("already exists");
	});

	test("drops a database", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["db", "drop", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Dropped");
		expect(stdout).toContain(testDbName);
	});

	test("handles non-existent database gracefully", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["db", "drop", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("does not exist");
	});

	test("shows error when no database name is provided for drop", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["db", "drop"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});
});

describe("CLI model", () => {
	test("shows usage when no model name is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["model"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("generates backend and frontend model files", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode, stdout } = await collectOutput(
				runCli(["model", "User"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created");

			const backendFile = await Bun.file(
				join(tempDir, "models", "user.ts"),
			).text();
			expect(backendFile).toContain('import { Model } from "baked-orm"');
			expect(backendFile).toContain("import { users }");
			expect(backendFile).toContain("class User extends Model(users)");

			const frontendFile = await Bun.file(
				join(tempDir, "frontend", "models", "user.ts"),
			).text();
			expect(frontendFile).toContain(
				'import { FrontendModel } from "baked-orm/frontend"',
			);
			expect(frontendFile).toContain("import { users }");
			expect(frontendFile).toContain("class User extends FrontendModel(users)");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("generates with explicit --table flag", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode } = await collectOutput(
				runCli(["model", "User", "--table", "user_accounts"], {
					cwd: tempDir,
				}),
			);
			expect(exitCode).toBe(0);

			const backendFile = await Bun.file(
				join(tempDir, "models", "user.ts"),
			).text();
			expect(backendFile).toContain("import { user_accounts }");
			expect(backendFile).toContain("class User extends Model(user_accounts)");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("--no-frontend skips frontend model", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode } = await collectOutput(
				runCli(["model", "Post", "--no-frontend"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);

			const backendExists = await Bun.file(
				join(tempDir, "models", "post.ts"),
			).exists();
			expect(backendExists).toBe(true);

			const frontendExists = await Bun.file(
				join(tempDir, "frontend", "models", "post.ts"),
			).exists();
			expect(frontendExists).toBe(false);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("--no-backend skips backend model", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode } = await collectOutput(
				runCli(["model", "Post", "--no-backend"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);

			const backendExists = await Bun.file(
				join(tempDir, "models", "post.ts"),
			).exists();
			expect(backendExists).toBe(false);

			const frontendExists = await Bun.file(
				join(tempDir, "frontend", "models", "post.ts"),
			).exists();
			expect(frontendExists).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("--backend overrides output directory", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode } = await collectOutput(
				runCli(
					["model", "User", "--backend", "./app/models", "--no-frontend"],
					{ cwd: tempDir },
				),
			);
			expect(exitCode).toBe(0);

			const backendExists = await Bun.file(
				join(tempDir, "app", "models", "user.ts"),
			).exists();
			expect(backendExists).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("handles snake_case input name", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode } = await collectOutput(
				runCli(["model", "blog_post", "--no-frontend"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);

			const backendFile = await Bun.file(
				join(tempDir, "models", "blog_post.ts"),
			).text();
			expect(backendFile).toContain("class BlogPost extends Model");
			expect(backendFile).toContain("import { blog_posts }");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

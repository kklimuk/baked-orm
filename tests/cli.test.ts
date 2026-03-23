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
	test("shows usage when no command is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli([]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage: bun db <command>");
	});

	test("shows usage for invalid command", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["invalid"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage: bun db <command>");
	});

	test("lists available commands in usage", async () => {
		const { stderr } = await collectOutput(runCli([]));
		expect(stderr).toContain("init");
		expect(stderr).toContain("create");
		expect(stderr).toContain("drop");
		expect(stderr).toContain("generate");
		expect(stderr).toContain("migrate");
		expect(stderr).toContain("status");
	});
});

describe("CLI generate", () => {
	test("shows error when no migration name is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["generate"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("creates migration file in temp directory", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		const migrationsDir = join(tempDir, "db", "migrations");
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode, stdout } = await collectOutput(
				runCli(["generate", "create_users"], { cwd: tempDir }),
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

describe("CLI init", () => {
	test("creates baked.config.ts", async () => {
		const tempDir = join(tmpdir(), `baked-cli-test-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			const { exitCode, stdout } = await collectOutput(
				runCli(["init"], { cwd: tempDir }),
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
			await writeFile(join(tempDir, "baked.config.ts"), "existing");

			const { exitCode, stderr } = await collectOutput(
				runCli(["init"], { cwd: tempDir }),
			);
			expect(exitCode).toBe(0);
			expect(stderr).toContain("already exists");

			const content = await Bun.file(join(tempDir, "baked.config.ts")).text();
			expect(content).toBe("existing");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("CLI create/drop", () => {
	const testDbName = `baked_cli_test_${Date.now()}`;

	test("shows error when no database name is provided", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["create"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});

	test("creates a database", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["create", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Created");
		expect(stdout).toContain(testDbName);
	});

	test("handles already-existing database gracefully", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["create", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("already exists");
	});

	test("drops a database", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["drop", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Dropped");
		expect(stdout).toContain(testDbName);
	});

	test("handles non-existent database gracefully", async () => {
		const { exitCode, stdout } = await collectOutput(
			runCli(["drop", testDbName]),
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("does not exist");
	});

	test("shows error when no database name is provided for drop", async () => {
		const { exitCode, stderr } = await collectOutput(runCli(["drop"]));
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Usage:");
	});
});

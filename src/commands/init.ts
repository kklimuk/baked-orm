function buildConfigContent(): string {
	const url = Bun.env.POSTGRES_URL ?? Bun.env.DATABASE_URL;
	const hostname = Bun.env.PGHOST;
	const port = Bun.env.PGPORT;
	const username = Bun.env.PGUSERNAME ?? Bun.env.PGUSER;
	const password = Bun.env.PGPASSWORD;
	const database = Bun.env.PGDATABASE;

	let databaseBlock = "";
	if (url) {
		databaseBlock = `\tdatabase: Bun.env.POSTGRES_URL ?? Bun.env.DATABASE_URL,`;
	} else if (hostname || port || username || password || database) {
		const fields = [
			hostname && `\t\thostname: Bun.env.PGHOST,`,
			port && `\t\tport: Number(Bun.env.PGPORT),`,
			username && `\t\tusername: Bun.env.PGUSERNAME ?? Bun.env.PGUSER,`,
			password && `\t\tpassword: Bun.env.PGPASSWORD,`,
			database && `\t\tdatabase: Bun.env.PGDATABASE,`,
		]
			.filter(Boolean)
			.join("\n");
		databaseBlock = `\tdatabase: {\n${fields}\n\t},`;
	}

	return `import { defineConfig } from "baked-orm";

export default defineConfig({
\tmigrationsPath: "./db/migrations",
\tschemaPath: "./db/schema.ts",
${databaseBlock}
});
`;
}

export async function runInit() {
	const configPath = `${process.cwd()}/baked.config.ts`;

	if (await Bun.file(configPath).exists()) {
		console.warn(`\x1b[33mbaked.config.ts already exists.\x1b[0m Skipping.`);
		return;
	}

	await Bun.write(configPath, buildConfigContent());
	console.log(`\x1b[32mCreated\x1b[0m baked.config.ts`);
}

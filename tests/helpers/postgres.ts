import { SQL } from "bun";

const DATABASE = "baked_orm_test";

export function getTestConnection(): SQL {
	// Single connection ensures advisory locks are acquired and released
	// on the same session, matching how a real CLI invocation behaves.
	return new SQL({ database: DATABASE, max: 1 });
}

export async function resetDatabase(connection: SQL): Promise<void> {
	await connection`DROP SCHEMA public CASCADE`;
	await connection`CREATE SCHEMA public`;
}

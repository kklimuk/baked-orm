import { SQL } from "bun";

const DATABASE = "baked_orm_test";

export function getTestConnection(options?: { max?: number }): SQL {
	return new SQL({ database: DATABASE, max: options?.max ?? 10 });
}

export async function resetDatabase(connection: SQL): Promise<void> {
	await connection`DROP SCHEMA public CASCADE`;
	await connection`CREATE SCHEMA public`;
}

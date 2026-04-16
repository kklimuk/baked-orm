import { AsyncLocalStorage } from "async_hooks";
import type { SQL } from "bun";
import { getConnection, resolveConfig } from "../config";
import type { TransactionOptions } from "./types";

const transactionStorage = new AsyncLocalStorage<SQL>();

let activeConnection: SQL | null = null;
let queryLogger: QueryLogger | null = null;
let savepointCounter = 0;

const VALID_ISOLATION_LEVELS: Set<string> = new Set([
	"read committed",
	"repeatable read",
	"serializable",
]);

export type QueryLogEntry = {
	text: string;
	values?: unknown[];
	durationMs: number;
};

export type QueryLogger = (entry: QueryLogEntry) => void;

export type ConnectOptions = {
	onQuery?: QueryLogger;
};

export async function connect(
	connectionOrOptions?: SQL | ConnectOptions,
	options?: ConnectOptions,
): Promise<void> {
	if (connectionOrOptions && "unsafe" in connectionOrOptions) {
		activeConnection = connectionOrOptions as SQL;
		if (options?.onQuery) {
			queryLogger = options.onQuery;
		}
		return;
	}
	const connectOptions = connectionOrOptions as ConnectOptions | undefined;
	if (connectOptions?.onQuery) {
		queryLogger = connectOptions.onQuery;
	}
	const config = await resolveConfig();
	activeConnection = getConnection(config);
}

export function isInTransaction(): boolean {
	return transactionStorage.getStore() !== undefined;
}

export function getModelConnection(): SQL {
	const transactionConnection = transactionStorage.getStore();
	if (transactionConnection) return transactionConnection;

	if (!activeConnection) {
		throw new Error(
			"No connection established. Call connect() before using models.",
		);
	}
	return activeConnection;
}

export function getQueryLogger(): QueryLogger | null {
	return queryLogger;
}

export async function transaction<Result>(
	callback: () => Promise<Result>,
): Promise<Result>;
export async function transaction<Result>(
	options: TransactionOptions,
	callback: () => Promise<Result>,
): Promise<Result>;
export async function transaction<Result>(
	callbackOrOptions: TransactionOptions | (() => Promise<Result>),
	maybeCallback?: () => Promise<Result>,
): Promise<Result> {
	const options =
		typeof callbackOrOptions === "function" ? {} : callbackOrOptions;
	const callback =
		typeof callbackOrOptions === "function"
			? callbackOrOptions
			: (maybeCallback as () => Promise<Result>);

	const existingTransaction = transactionStorage.getStore();

	if (existingTransaction) {
		return executeNestedTransaction(existingTransaction, options, callback);
	}

	return executeTopLevelTransaction(options, callback);
}

export async function query<Result = Record<string, unknown>>(
	sqlText: string,
	values?: unknown[],
): Promise<Result[]> {
	const connection = getModelConnection();
	if (queryLogger) {
		const start = performance.now();
		const result = await connection.unsafe(sqlText, values);
		queryLogger({
			text: sqlText,
			values,
			durationMs: performance.now() - start,
		});
		return result as Result[];
	}
	return connection.unsafe(sqlText, values) as Promise<Result[]>;
}

export async function disconnect(): Promise<void> {
	if (activeConnection) {
		await activeConnection.close();
		activeConnection = null;
	}
	queryLogger = null;
	savepointCounter = 0;
}

function executeTopLevelTransaction<Result>(
	options: TransactionOptions,
	callback: () => Promise<Result>,
): Promise<Result> {
	const connection = getModelConnection();
	return connection.begin(async (transactionConnection) => {
		const typedConnection = transactionConnection as unknown as SQL;
		if (options.isolation) {
			validateIsolationLevel(options.isolation);
			await typedConnection.unsafe(
				`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`,
			);
		}
		return transactionStorage.run(typedConnection, callback);
	});
}

function executeNestedTransaction<Result>(
	transactionConnection: SQL,
	options: TransactionOptions,
	callback: () => Promise<Result>,
): Promise<Result> {
	if (options.isolation) {
		throw new Error(
			"Isolation level cannot be set on nested transactions. PostgreSQL only supports isolation levels on top-level transactions.",
		);
	}

	savepointCounter += 1;
	const savepointName = `sp_${savepointCounter}`;

	return executeSavepoint(transactionConnection, savepointName, callback);
}

async function executeSavepoint<Result>(
	transactionConnection: SQL,
	savepointName: string,
	callback: () => Promise<Result>,
): Promise<Result> {
	await transactionConnection.unsafe(`SAVEPOINT ${savepointName}`);
	try {
		const result = await callback();
		await transactionConnection.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
		return result;
	} catch (error) {
		await transactionConnection.unsafe(
			`ROLLBACK TO SAVEPOINT ${savepointName}`,
		);
		await transactionConnection.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
		throw error;
	}
}

function validateIsolationLevel(level: string): void {
	if (!VALID_ISOLATION_LEVELS.has(level)) {
		throw new Error(
			`Invalid isolation level "${level}". Must be one of: "read committed", "repeatable read", "serializable".`,
		);
	}
}

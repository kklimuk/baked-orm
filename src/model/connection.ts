import { AsyncLocalStorage } from "async_hooks";
import type { SQL } from "bun";
import { getConnection, resolveConfig } from "../config";

const transactionStorage = new AsyncLocalStorage<SQL>();

let activeConnection: SQL | null = null;
let queryLogger: QueryLogger | null = null;

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
): Promise<Result> {
	const connection = getModelConnection();
	return connection.begin(async (transactionConnection) => {
		return transactionStorage.run(
			transactionConnection as unknown as SQL,
			callback,
		);
	});
}

export async function disconnect(): Promise<void> {
	if (activeConnection) {
		await activeConnection.close();
		activeConnection = null;
	}
	queryLogger = null;
}

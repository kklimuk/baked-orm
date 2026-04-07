import type { ColumnDefinition } from "../types";

function isJsonType(type: string): boolean {
	return type === "json" || type === "jsonb";
}

/** Snapshot-based dirty tracking. Stores column values at a point in time and compares against current instance state. */
export class Snapshot {
	#data: Map<string, unknown> = new Map();
	#columns: Record<string, ColumnDefinition>;
	#primaryKeyField: string;
	#jsonColumns: Set<string>;

	constructor(
		columns: Record<string, ColumnDefinition>,
		primaryKeyField: string,
	) {
		this.#columns = columns;
		this.#primaryKeyField = primaryKeyField;
		this.#jsonColumns = new Set(
			Object.entries(columns)
				.filter(([, definition]) => isJsonType(definition.type))
				.map(([camelKey]) => camelKey),
		);
	}

	/** Store current column values from the instance. */
	capture(instance: Record<string, unknown>): void {
		this.#data.clear();
		for (const camelKey of Object.keys(this.#columns)) {
			const value = instance[camelKey];
			this.#data.set(
				camelKey,
				this.#jsonColumns.has(camelKey) && value != null
					? structuredClone(value)
					: value,
			);
		}
	}

	#hasChanged(camelKey: string, instance: Record<string, unknown>): boolean {
		const was = this.#data.get(camelKey);
		const now = instance[camelKey];
		if (this.#jsonColumns.has(camelKey)) {
			return !Bun.deepEquals(was, now);
		}
		return was !== now;
	}

	/** Check if a specific field (or any non-PK field) has changed since last capture. */
	changed(instance: Record<string, unknown>, fieldName?: string): boolean {
		if (fieldName !== undefined) {
			return this.#hasChanged(fieldName, instance);
		}
		for (const camelKey of Object.keys(this.#columns)) {
			if (camelKey === this.#primaryKeyField) continue;
			if (this.#hasChanged(camelKey, instance)) return true;
		}
		return false;
	}

	/** Return `{ field: { was, now } }` for all changed non-PK fields. */
	changedAttributes(
		instance: Record<string, unknown>,
	): Record<string, { was: unknown; now: unknown }> {
		const changes: Record<string, { was: unknown; now: unknown }> = {};
		for (const camelKey of Object.keys(this.#columns)) {
			if (camelKey === this.#primaryKeyField) continue;
			if (this.#hasChanged(camelKey, instance)) {
				changes[camelKey] = {
					was: this.#data.get(camelKey),
					now: instance[camelKey],
				};
			}
		}
		return changes;
	}

	/** Return `[camelKey, ColumnDefinition]` entries for dirty columns. Used by `#performUpdate`. */
	dirtyEntries(
		instance: Record<string, unknown>,
	): [string, ColumnDefinition][] {
		return Object.entries(this.#columns).filter(
			([camelKey]) =>
				camelKey !== this.#primaryKeyField &&
				this.#hasChanged(camelKey, instance),
		);
	}
}

import type { ColumnDefinition } from "../types";

/** Snapshot-based dirty tracking. Stores column values at a point in time and compares against current instance state. */
export class Snapshot {
	#data: Map<string, unknown> = new Map();
	#columns: Record<string, ColumnDefinition>;
	#primaryKeyField: string;

	constructor(
		columns: Record<string, ColumnDefinition>,
		primaryKeyField: string,
	) {
		this.#columns = columns;
		this.#primaryKeyField = primaryKeyField;
	}

	/** Store current column values from the instance. */
	capture(instance: Record<string, unknown>): void {
		this.#data.clear();
		for (const camelKey of Object.keys(this.#columns)) {
			this.#data.set(camelKey, instance[camelKey]);
		}
	}

	/** Check if a specific field (or any non-PK field) has changed since last capture. */
	changed(instance: Record<string, unknown>, fieldName?: string): boolean {
		if (fieldName !== undefined) {
			return this.#data.get(fieldName) !== instance[fieldName];
		}
		for (const camelKey of Object.keys(this.#columns)) {
			if (camelKey === this.#primaryKeyField) continue;
			if (this.#data.get(camelKey) !== instance[camelKey]) return true;
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
			const was = this.#data.get(camelKey);
			const now = instance[camelKey];
			if (was !== now) changes[camelKey] = { was, now };
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
				this.#data.get(camelKey) !== instance[camelKey],
		);
	}
}

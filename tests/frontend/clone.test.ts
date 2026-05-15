import { afterEach, describe, expect, test } from "bun:test";

import { FrontendModel } from "../../src/frontend/model";
import {
	getFrontendRegistry,
	registerModels,
} from "../../src/frontend/registry";
import { Snapshot } from "../../src/model/snapshot";
import type { ColumnDefinition, TableDefinition } from "../../src/types";

class PagesRow {
	[key: string]: unknown;
	declare id: string;
	declare title: string;
}

const pagesTableDef: TableDefinition<PagesRow> = {
	tableName: "pages",
	columns: {
		id: {
			type: "uuid",
			nullable: false,
			default: "gen_random_uuid()",
			columnName: "id",
		},
		title: { type: "text", nullable: false, columnName: "title" },
	},
	primaryKey: ["id"],
	indexes: {},
	foreignKeys: {},
	rowClass: PagesRow,
};

class Page extends FrontendModel(pagesTableDef) {
	get titleUpper(): string {
		return this.title.toUpperCase();
	}
	following: boolean | null = null;
}

registerModels({ Page });

afterEach(() => {
	const registry = getFrontendRegistry();
	if (!registry.has("Page")) registerModels({ Page });
});

describe("FrontendBase.clone", () => {
	test("clone of a persisted record stays persisted and clean", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();

		const next = page.clone();
		expect(next).toBeInstanceOf(Page);
		expect(next).not.toBe(page);
		expect(next.isNewRecord).toBe(false);
		expect(next.changed()).toBe(false);
	});

	test("clone of an unpersisted record stays a new record", () => {
		const page = new Page({ id: "1", title: "A" });

		const next = page.clone();
		expect(next.isNewRecord).toBe(true);
	});

	test("clone with a column override is dirty against the original baseline", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();

		const next = page.clone({ title: "B" });
		expect(next.title).toBe("B");
		expect(next.isNewRecord).toBe(false);
		expect(next.changed()).toBe(true);
		expect(next.changed("title")).toBe(true);
		expect(next.changedAttributes()).toEqual({
			title: { was: "A", now: "B" },
		});
	});

	test("dirty tracking keeps working when the clone is mutated further", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();

		const next = page.clone({ title: "B" });
		next.title = "C";
		expect(next.changed("title")).toBe(true);
		expect(next.changedAttributes()).toEqual({
			title: { was: "A", now: "C" },
		});
	});

	test("clone and original have independent snapshots", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();
		const next = page.clone();

		next.title = "B";
		expect(next.changed()).toBe(true);
		expect(page.changed()).toBe(false);

		page.title = "Z";
		const fresh = page.clone();
		fresh.title = "A";
		expect(fresh.changed()).toBe(false);
		expect(page.changed()).toBe(true);
	});

	test("clone re-baselines after markPersisted", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();

		const next = page.clone({ title: "B" });
		expect(next.changed()).toBe(true);
		next.markPersisted();
		expect(next.changed()).toBe(false);
	});

	test("settable virtuals are carried onto the clone", () => {
		const page = new Page({ id: "1", title: "A" });
		page.following = true;

		const next = page.clone();
		expect(next.following).toBe(true);
	});

	test("settable virtuals can be overridden on the clone", () => {
		const page = new Page({ id: "1", title: "A" });
		page.following = true;

		const next = page.clone({ following: false });
		expect(next.following).toBe(false);
		expect(page.following).toBe(true);
	});

	test("computed virtuals still evaluate on the clone", () => {
		const page = new Page({ id: "1", title: "hello" });
		const next = page.clone({ title: "world" });
		expect(next.titleUpper).toBe("WORLD");
	});

	test("clone errors are fresh even when the original has errors", () => {
		const page = new Page({ id: "1", title: "A" });
		page.errors.add("title", "is bad");
		expect(page.errors.isEmpty).toBe(false);

		const next = page.clone();
		expect(next.errors.isEmpty).toBe(true);
	});

	test("clone serializes without touching private state of a bare copy", () => {
		const page = new Page({ id: "1", title: "A" });
		page.markPersisted();

		const next = page.clone({ title: "B" });
		const json = next.toJSON();
		expect(json.__typename).toBe("Page");
		expect(json.title).toBe("B");
		expect(json.titleUpper).toBe("B");
	});
});

describe("Snapshot.clone", () => {
	const columns: Record<string, ColumnDefinition> = {
		id: { type: "uuid", nullable: false, columnName: "id" },
		title: { type: "text", nullable: false, columnName: "title" },
	};

	test("produces an independent baseline", () => {
		const original = new Snapshot(columns, "id");
		original.capture({ id: "1", title: "A" });

		const copy = original.clone();
		expect(copy.changed({ id: "1", title: "A" })).toBe(false);
		expect(copy.changed({ id: "1", title: "B" })).toBe(true);

		// Re-capturing the copy must not affect the original's baseline.
		copy.capture({ id: "1", title: "B" });
		expect(original.changed({ id: "1", title: "A" })).toBe(false);
		expect(copy.changed({ id: "1", title: "A" })).toBe(true);
	});
});

import { afterEach, describe, expect, test } from "bun:test";

import { hydrate } from "../../src/frontend/hydrate";
import { FrontendModel } from "../../src/frontend/model";
import {
	getFrontendRegistry,
	registerModels,
} from "../../src/frontend/registry";
import type { TableDefinition } from "../../src/types";

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
	// Frontend registry is module-global; clean up to avoid leaks between files
	const registry = getFrontendRegistry();
	if (!registry.has("Page")) registerModels({ Page });
});

describe("frontend virtual attributes", () => {
	test("computed getter is included in toJSON", () => {
		const page = new Page({ id: "1", title: "hello" });
		const json = page.toJSON();
		expect(json.titleUpper).toBe("HELLO");
		expect(json.title).toBe("hello");
	});

	test("settable virtual default appears in toJSON", () => {
		const page = new Page({ id: "1", title: "hello" });
		const json = page.toJSON();
		expect(json).toHaveProperty("following");
		expect(json.following).toBeNull();
	});

	test("settable virtual after assignment appears in toJSON", () => {
		const page = new Page({ id: "1", title: "hello" });
		page.following = true;
		const json = page.toJSON();
		expect(json.following).toBe(true);
	});

	test("hydrate carries plain virtual values onto the instance", () => {
		const json = {
			__typename: "Page",
			id: "1",
			title: "hello",
			following: true,
		};
		const page = hydrate<Page>(json);
		expect(page.title).toBe("hello");
		expect(page.following).toBe(true);
		expect(page.titleUpper).toBe("HELLO");
	});

	test("hydrated virtual round-trips through toJSON", () => {
		const json = {
			__typename: "Page",
			id: "1",
			title: "hi",
			following: true,
		};
		const page = hydrate<Page>(json);
		const back = page.toJSON();
		expect(back.following).toBe(true);
		expect(back.titleUpper).toBe("HI");
	});

	test("setting a virtual does not mark the instance as dirty", () => {
		const page = new Page({ id: "1", title: "hi" });
		page.markPersisted();
		expect(page.changed()).toBe(false);
		page.following = true;
		expect(page.changed()).toBe(false);
	});

	test("__typename uses registered name (not class name)", () => {
		const page = new Page({ id: "1", title: "hi" });
		const json = page.toJSON();
		expect(json.__typename).toBe("Page");
	});
});

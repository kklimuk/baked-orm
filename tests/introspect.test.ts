import { describe, expect, test } from "bun:test";

import {
	groupBy,
	mapPgType,
	parseIndexColumns,
	toPascalCase,
} from "../src/introspect";

describe("mapPgType", () => {
	test("maps string-like types to string", () => {
		expect(mapPgType("uuid")).toBe("string");
		expect(mapPgType("text")).toBe("string");
		expect(mapPgType("character varying")).toBe("string");
		expect(mapPgType("varchar")).toBe("string");
		expect(mapPgType("char")).toBe("string");
	});

	test("maps integer types to number", () => {
		expect(mapPgType("integer")).toBe("number");
		expect(mapPgType("int")).toBe("number");
		expect(mapPgType("int4")).toBe("number");
		expect(mapPgType("smallint")).toBe("number");
		expect(mapPgType("serial")).toBe("number");
	});

	test("maps bigint types to bigint", () => {
		expect(mapPgType("bigint")).toBe("bigint");
		expect(mapPgType("int8")).toBe("bigint");
		expect(mapPgType("bigserial")).toBe("bigint");
	});

	test("maps boolean types", () => {
		expect(mapPgType("boolean")).toBe("boolean");
		expect(mapPgType("bool")).toBe("boolean");
	});

	test("maps timestamp types to Date", () => {
		expect(mapPgType("timestamp with time zone")).toBe("Date");
		expect(mapPgType("timestamp without time zone")).toBe("Date");
		expect(mapPgType("timestamptz")).toBe("Date");
		expect(mapPgType("timestamp")).toBe("Date");
		expect(mapPgType("date")).toBe("Date");
	});

	test("maps json types to unknown", () => {
		expect(mapPgType("json")).toBe("unknown");
		expect(mapPgType("jsonb")).toBe("unknown");
	});

	test("maps numeric/decimal to string", () => {
		expect(mapPgType("numeric")).toBe("string");
		expect(mapPgType("decimal")).toBe("string");
	});

	test("maps float types to number", () => {
		expect(mapPgType("real")).toBe("number");
		expect(mapPgType("float4")).toBe("number");
		expect(mapPgType("double precision")).toBe("number");
		expect(mapPgType("float8")).toBe("number");
	});

	test("maps bytea to Uint8Array", () => {
		expect(mapPgType("bytea")).toBe("Uint8Array");
	});

	test("maps array types recursively", () => {
		expect(mapPgType("text[]")).toBe("string[]");
		expect(mapPgType("integer[]")).toBe("number[]");
		expect(mapPgType("boolean[]")).toBe("boolean[]");
	});

	test("maps ARRAY prefix to unknown[]", () => {
		expect(mapPgType("ARRAY")).toBe("unknown[]");
	});

	test("maps composite types when provided", () => {
		const compositeNames = new Set(["address", "coordinates"]);
		expect(mapPgType("address", compositeNames)).toBe("AddressComposite");
		expect(mapPgType("coordinates", compositeNames)).toBe(
			"CoordinatesComposite",
		);
	});

	test("falls back to unknown for unrecognized types", () => {
		expect(mapPgType("some_custom_type")).toBe("unknown");
	});

	test("strips precision from type before lookup", () => {
		expect(mapPgType("numeric(10,2)")).toBe("string");
		expect(mapPgType("character varying(255)")).toBe("string");
	});
});

describe("toPascalCase", () => {
	test("converts single word", () => {
		expect(toPascalCase("users")).toBe("Users");
	});

	test("converts snake_case", () => {
		expect(toPascalCase("user_roles")).toBe("UserRoles");
	});

	test("converts multi-segment snake_case", () => {
		expect(toPascalCase("org_team_members")).toBe("OrgTeamMembers");
	});

	test("handles already capitalized segments", () => {
		expect(toPascalCase("User")).toBe("User");
	});
});

describe("parseIndexColumns", () => {
	test("parses single-column index", () => {
		const result = parseIndexColumns(
			"CREATE INDEX idx_users_email ON public.users USING btree (email)",
		);
		expect(result).toEqual({ columns: ["email"], unique: false });
	});

	test("parses unique index", () => {
		const result = parseIndexColumns(
			"CREATE UNIQUE INDEX idx_users_email ON public.users USING btree (email)",
		);
		expect(result).toEqual({ columns: ["email"], unique: true });
	});

	test("parses multi-column index", () => {
		const result = parseIndexColumns(
			"CREATE INDEX idx_users_name ON public.users USING btree (first_name, last_name)",
		);
		expect(result).toEqual({
			columns: ["first_name", "last_name"],
			unique: false,
		});
	});

	test("strips quoted column names", () => {
		const result = parseIndexColumns(
			'CREATE INDEX idx ON public.t USING btree ("order", "group")',
		);
		expect(result).toEqual({ columns: ["order", "group"], unique: false });
	});

	test("returns empty columns when no parens found", () => {
		const result = parseIndexColumns("CREATE INDEX idx ON public.t");
		expect(result).toEqual({ columns: [], unique: false });
	});
});

describe("groupBy", () => {
	test("groups array of objects by key", () => {
		const items = [
			{ table: "users", column: "id" },
			{ table: "users", column: "name" },
			{ table: "posts", column: "id" },
		];
		expect(groupBy(items, "table")).toEqual({
			users: [
				{ table: "users", column: "id" },
				{ table: "users", column: "name" },
			],
			posts: [{ table: "posts", column: "id" }],
		});
	});

	test("returns empty object for empty array", () => {
		expect(groupBy([], "key")).toEqual({});
	});

	test("handles single-item groups", () => {
		const items = [
			{ category: "a", value: 1 },
			{ category: "b", value: 2 },
			{ category: "c", value: 3 },
		];
		const result = groupBy(items, "category");
		expect(Object.keys(result)).toHaveLength(3);
	});
});

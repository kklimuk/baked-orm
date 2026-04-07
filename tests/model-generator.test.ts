import { describe, expect, test } from "bun:test";

import { inferTableName, toSnakeCase } from "../src/commands/model";

describe("toSnakeCase", () => {
	test("converts PascalCase", () => {
		expect(toSnakeCase("User")).toBe("user");
		expect(toSnakeCase("BlogPost")).toBe("blog_post");
		expect(toSnakeCase("UserProfile")).toBe("user_profile");
	});

	test("converts camelCase", () => {
		expect(toSnakeCase("blogPost")).toBe("blog_post");
		expect(toSnakeCase("userProfile")).toBe("user_profile");
	});

	test("preserves snake_case", () => {
		expect(toSnakeCase("blog_post")).toBe("blog_post");
		expect(toSnakeCase("user")).toBe("user");
	});

	test("handles consecutive uppercase (acronyms)", () => {
		expect(toSnakeCase("HTMLParser")).toBe("html_parser");
		expect(toSnakeCase("APIToken")).toBe("api_token");
	});

	test("handles single word", () => {
		expect(toSnakeCase("user")).toBe("user");
		expect(toSnakeCase("User")).toBe("user");
	});
});

describe("inferTableName", () => {
	test("converts PascalCase and pluralizes", () => {
		expect(inferTableName("User")).toBe("users");
		expect(inferTableName("Post")).toBe("posts");
		expect(inferTableName("BlogPost")).toBe("blog_posts");
	});

	test("converts snake_case and pluralizes", () => {
		expect(inferTableName("blog_post")).toBe("blog_posts");
	});

	test("converts camelCase and pluralizes", () => {
		expect(inferTableName("blogPost")).toBe("blog_posts");
	});
});

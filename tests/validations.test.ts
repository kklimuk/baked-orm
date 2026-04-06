import { describe, expect, test } from "bun:test";

import { ValidationError, ValidationErrors } from "../src/model/errors";
import {
	collectValidationErrors,
	defineValidator,
	validate,
	validates,
} from "../src/model/validations";

describe("ValidationErrors", () => {
	test("starts empty", () => {
		const errors = new ValidationErrors();
		expect(errors.isEmpty).toBe(true);
		expect(errors.size).toBe(0);
	});

	test("add and get errors", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		errors.add("name", "is too short");
		errors.add("email", "is invalid");

		expect(errors.get("name")).toEqual(["can't be blank", "is too short"]);
		expect(errors.get("email")).toEqual(["is invalid"]);
		expect(errors.get("missing")).toEqual([]);
	});

	test("has checks field presence", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");

		expect(errors.has("name")).toBe(true);
		expect(errors.has("email")).toBe(false);
	});

	test("isEmpty and size", () => {
		const errors = new ValidationErrors();
		expect(errors.isEmpty).toBe(true);
		expect(errors.size).toBe(0);

		errors.add("name", "can't be blank");
		expect(errors.isEmpty).toBe(false);
		expect(errors.size).toBe(1);

		errors.add("email", "is invalid");
		expect(errors.size).toBe(2);
	});

	test("fullMessages capitalizes field names", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		errors.add("email", "is invalid");

		expect(errors.fullMessages()).toEqual([
			"Name can't be blank",
			"Email is invalid",
		]);
	});

	test("fullMessages passes base errors through without prefix", () => {
		const errors = new ValidationErrors();
		errors.add("base", "something went wrong");
		errors.add("name", "can't be blank");

		expect(errors.fullMessages()).toEqual([
			"something went wrong",
			"Name can't be blank",
		]);
	});

	test("fullMessagesFor returns formatted messages for a field", () => {
		const errors = new ValidationErrors();
		errors.add("email", "is invalid");
		errors.add("email", "is too long");

		expect(errors.fullMessagesFor("email")).toEqual([
			"Email is invalid",
			"Email is too long",
		]);
		expect(errors.fullMessagesFor("missing")).toEqual([]);
	});

	test("fullMessagesFor base errors", () => {
		const errors = new ValidationErrors();
		errors.add("base", "record is invalid");

		expect(errors.fullMessagesFor("base")).toEqual(["record is invalid"]);
	});

	test("fullMessages humanizes camelCase field names", () => {
		const errors = new ValidationErrors();
		errors.add("createdAt", "can't be blank");
		errors.add("userId", "is invalid");

		expect(errors.fullMessages()).toEqual([
			"Created at can't be blank",
			"User id is invalid",
		]);
	});

	test("toJSON serializes to plain object", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		errors.add("email", "is invalid");
		errors.add("email", "is too long");

		expect(errors.toJSON()).toEqual({
			name: ["can't be blank"],
			email: ["is invalid", "is too long"],
		});
	});

	test("iterator yields field-messages pairs", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		errors.add("email", "is invalid");

		const entries = [...errors];
		expect(entries).toEqual([
			["name", ["can't be blank"]],
			["email", ["is invalid"]],
		]);
	});
});

describe("ValidationError", () => {
	test("formats message with model name and full messages", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		errors.add("email", "is invalid");

		const error = new ValidationError("User", errors);
		expect(error.message).toBe(
			"Validation failed for User: Name can't be blank, Email is invalid",
		);
		expect(error.name).toBe("ValidationError");
		expect(error.modelName).toBe("User");
		expect(error.errors).toBe(errors);
	});

	test("is an instance of Error", () => {
		const errors = new ValidationErrors();
		errors.add("name", "can't be blank");
		const error = new ValidationError("User", errors);
		expect(error).toBeInstanceOf(Error);
	});
});

describe("Built-in validators", () => {
	describe("presence", () => {
		test("rejects null, undefined, and empty string", () => {
			for (const value of [null, undefined, ""]) {
				const errors = collectValidationErrors({ name: value }, "create", {
					validations: { name: validates("presence") },
				});
				expect(errors.isEmpty).toBe(false);
				expect(errors.get("name")).toEqual(["can't be blank"]);
			}
		});

		test("accepts 0, false, and non-empty strings", () => {
			for (const value of [0, false, "hello"]) {
				const errors = collectValidationErrors({ name: value }, "create", {
					validations: { name: validates("presence") },
				});
				expect(errors.isEmpty).toBe(true);
			}
		});

		test("custom message", () => {
			const errors = collectValidationErrors({ name: null }, "create", {
				validations: {
					name: validates("presence", { message: "is required" }),
				},
			});
			expect(errors.get("name")).toEqual(["is required"]);
		});
	});

	describe("length", () => {
		test("minimum", () => {
			const rule = validates("length", { minimum: 3 });
			const errors = collectValidationErrors({ name: "ab" }, "create", {
				validations: { name: rule },
			});
			expect(errors.get("name")).toEqual([
				"is too short (minimum is 3 characters)",
			]);
		});

		test("maximum", () => {
			const rule = validates("length", { maximum: 5 });
			const errors = collectValidationErrors({ name: "toolong" }, "create", {
				validations: { name: rule },
			});
			expect(errors.get("name")).toEqual([
				"is too long (maximum is 5 characters)",
			]);
		});

		test("exact length with is", () => {
			const rule = validates("length", { is: 4 });
			const errors = collectValidationErrors({ code: "abc" }, "create", {
				validations: { code: rule },
			});
			expect(errors.get("code")).toEqual([
				"is the wrong length (should be 4 characters)",
			]);
		});

		test("passes when within bounds", () => {
			const rule = validates("length", { minimum: 2, maximum: 10 });
			const errors = collectValidationErrors({ name: "hello" }, "create", {
				validations: { name: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});

		test("skips null/undefined values", () => {
			const rule = validates("length", { minimum: 3 });
			const errors = collectValidationErrors({ name: null }, "create", {
				validations: { name: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});
	});

	describe("numericality", () => {
		test("rejects non-numeric values", () => {
			const rule = validates("numericality");
			const errors = collectValidationErrors({ age: "abc" }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["is not a number"]);
		});

		test("integer option", () => {
			const rule = validates("numericality", { integer: true });
			const errors = collectValidationErrors({ age: 3.5 }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["must be an integer"]);
		});

		test("greaterThan", () => {
			const rule = validates("numericality", { greaterThan: 0 });
			const errors = collectValidationErrors({ age: 0 }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["must be greater than 0"]);
		});

		test("greaterThanOrEqualTo", () => {
			const rule = validates("numericality", { greaterThanOrEqualTo: 1 });
			const errors = collectValidationErrors({ age: 0 }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["must be greater than or equal to 1"]);
		});

		test("lessThan", () => {
			const rule = validates("numericality", { lessThan: 100 });
			const errors = collectValidationErrors({ age: 100 }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["must be less than 100"]);
		});

		test("lessThanOrEqualTo", () => {
			const rule = validates("numericality", { lessThanOrEqualTo: 99 });
			const errors = collectValidationErrors({ age: 100 }, "create", {
				validations: { age: rule },
			});
			expect(errors.get("age")).toEqual(["must be less than or equal to 99"]);
		});

		test("equalTo", () => {
			const rule = validates("numericality", { equalTo: 42 });
			const errors = collectValidationErrors({ answer: 43 }, "create", {
				validations: { answer: rule },
			});
			expect(errors.get("answer")).toEqual(["must be equal to 42"]);
		});

		test("passes valid numbers", () => {
			const rule = validates("numericality", {
				greaterThan: 0,
				integer: true,
			});
			const errors = collectValidationErrors({ age: 25 }, "create", {
				validations: { age: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});

		test("skips null/undefined values", () => {
			const rule = validates("numericality", { greaterThan: 0 });
			const errors = collectValidationErrors({ age: null }, "create", {
				validations: { age: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});

		test("per-check messages override general message", () => {
			const rule = validates("numericality", {
				integer: true,
				greaterThan: 0,
				message: "is wrong",
				notAnIntegerMessage: "must be whole",
				notANumberMessage: "must be numeric",
			});

			const nanErrors = collectValidationErrors({ age: "abc" }, "create", {
				validations: { age: rule },
			});
			expect(nanErrors.get("age")).toEqual(["must be numeric"]);

			const floatErrors = collectValidationErrors({ age: 3.5 }, "create", {
				validations: { age: rule },
			});
			expect(floatErrors.get("age")).toEqual(["must be whole"]);

			// greaterThan has no per-check message, so falls back to general message
			const rangeErrors = collectValidationErrors({ age: 0 }, "create", {
				validations: { age: rule },
			});
			expect(rangeErrors.get("age")).toEqual(["is wrong"]);
		});
	});

	describe("format", () => {
		test("rejects non-matching strings", () => {
			const rule = validates("format", { pattern: /^\d+$/ });
			const errors = collectValidationErrors({ code: "abc" }, "create", {
				validations: { code: rule },
			});
			expect(errors.get("code")).toEqual(["is invalid"]);
		});

		test("passes matching strings", () => {
			const rule = validates("format", { pattern: /^\d+$/ });
			const errors = collectValidationErrors({ code: "123" }, "create", {
				validations: { code: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});

		test("rejects non-string values", () => {
			const rule = validates("format", { pattern: /^\d+$/ });
			const errors = collectValidationErrors({ code: 123 }, "create", {
				validations: { code: rule },
			});
			expect(errors.get("code")).toEqual(["is invalid"]);
		});

		test("skips null/undefined", () => {
			const rule = validates("format", { pattern: /^\d+$/ });
			const errors = collectValidationErrors({ code: null }, "create", {
				validations: { code: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});
	});

	describe("inclusion", () => {
		test("rejects values not in list", () => {
			const rule = validates("inclusion", {
				in: ["admin", "user"],
			});
			const errors = collectValidationErrors({ role: "superadmin" }, "create", {
				validations: { role: rule },
			});
			expect(errors.get("role")).toEqual(["is not included in the list"]);
		});

		test("passes values in list", () => {
			const rule = validates("inclusion", {
				in: ["admin", "user"],
			});
			const errors = collectValidationErrors({ role: "admin" }, "create", {
				validations: { role: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});

		test("skips null/undefined", () => {
			const rule = validates("inclusion", { in: ["a", "b"] });
			const errors = collectValidationErrors({ role: null }, "create", {
				validations: { role: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});
	});

	describe("exclusion", () => {
		test("rejects values in disallowed list", () => {
			const rule = validates("exclusion", {
				in: ["root", "admin"],
			});
			const errors = collectValidationErrors({ username: "root" }, "create", {
				validations: { username: rule },
			});
			expect(errors.get("username")).toEqual(["is reserved"]);
		});

		test("passes values not in list", () => {
			const rule = validates("exclusion", {
				in: ["root", "admin"],
			});
			const errors = collectValidationErrors({ username: "alice" }, "create", {
				validations: { username: rule },
			});
			expect(errors.isEmpty).toBe(true);
		});
	});

	describe("email", () => {
		test("rejects invalid emails", () => {
			for (const value of ["notanemail", "@missing.user", "missing@", ""]) {
				const errors = collectValidationErrors({ email: value }, "create", {
					validations: { email: validates("email") },
				});
				expect(errors.isEmpty).toBe(false);
			}
		});

		test("accepts valid emails", () => {
			for (const value of [
				"user@example.com",
				"first.last@domain.org",
				"user+tag@example.co.uk",
			]) {
				const errors = collectValidationErrors({ email: value }, "create", {
					validations: { email: validates("email") },
				});
				expect(errors.isEmpty).toBe(true);
			}
		});

		test("skips null/undefined", () => {
			const errors = collectValidationErrors({ email: null }, "create", {
				validations: { email: validates("email") },
			});
			expect(errors.isEmpty).toBe(true);
		});
	});
});

describe("Conditional validations", () => {
	test("on: create only runs on create context", () => {
		const rule = validates("presence", { on: "create" });

		const createErrors = collectValidationErrors({ name: null }, "create", {
			validations: { name: rule },
		});
		expect(createErrors.isEmpty).toBe(false);

		const updateErrors = collectValidationErrors({ name: null }, "update", {
			validations: { name: rule },
		});
		expect(updateErrors.isEmpty).toBe(true);
	});

	test("on: update only runs on update context", () => {
		const rule = validates("presence", { on: "update" });

		const createErrors = collectValidationErrors({ name: null }, "create", {
			validations: { name: rule },
		});
		expect(createErrors.isEmpty).toBe(true);

		const updateErrors = collectValidationErrors({ name: null }, "update", {
			validations: { name: rule },
		});
		expect(updateErrors.isEmpty).toBe(false);
	});

	test("if condition controls whether validation runs", () => {
		const rule = validates("presence", {
			if: (record) => record.role === "admin",
		});

		const adminErrors = collectValidationErrors(
			{ name: null, role: "admin" },
			"create",
			{ validations: { name: rule } },
		);
		expect(adminErrors.isEmpty).toBe(false);

		const userErrors = collectValidationErrors(
			{ name: null, role: "user" },
			"create",
			{ validations: { name: rule } },
		);
		expect(userErrors.isEmpty).toBe(true);
	});
});

describe("Multiple validations on same field", () => {
	test("collects all errors", () => {
		const rules = [validates("presence"), validates("length", { minimum: 3 })];
		const errors = collectValidationErrors({ name: "" }, "create", {
			validations: { name: rules },
		});
		expect(errors.get("name")).toEqual([
			"can't be blank",
			"is too short (minimum is 3 characters)",
		]);
	});
});

describe("Custom validations", () => {
	test("record-level validate()", () => {
		const customValidation = validate((record) => {
			if (record.password !== record.passwordConfirmation) {
				return { passwordConfirmation: "doesn't match password" };
			}
		});

		const errors = collectValidationErrors(
			{ password: "secret", passwordConfirmation: "wrong" },
			"create",
			{ customValidations: [customValidation] },
		);
		expect(errors.get("passwordConfirmation")).toEqual([
			"doesn't match password",
		]);
	});

	test("validate() returns nothing when valid", () => {
		const customValidation = validate((record) => {
			if (record.password !== record.passwordConfirmation) {
				return { passwordConfirmation: "doesn't match password" };
			}
		});

		const errors = collectValidationErrors(
			{ password: "secret", passwordConfirmation: "secret" },
			"create",
			{ customValidations: [customValidation] },
		);
		expect(errors.isEmpty).toBe(true);
	});

	test("validate() can return multiple errors", () => {
		const customValidation = validate(() => {
			return {
				base: "record is invalid",
				name: ["too short", "too boring"],
			};
		});

		const errors = collectValidationErrors({}, "create", {
			customValidations: [customValidation],
		});
		expect(errors.get("base")).toEqual(["record is invalid"]);
		expect(errors.get("name")).toEqual(["too short", "too boring"]);
	});

	test("validate() respects on: condition", () => {
		const customValidation = validate(() => ({ base: "nope" }), {
			on: "create",
		});

		const createErrors = collectValidationErrors({}, "create", {
			customValidations: [customValidation],
		});
		expect(createErrors.isEmpty).toBe(false);

		const updateErrors = collectValidationErrors({}, "update", {
			customValidations: [customValidation],
		});
		expect(updateErrors.isEmpty).toBe(true);
	});

	test("field-level custom validator", () => {
		const rule = validates("custom", {
			validate: (value) => {
				if (typeof value === "string" && value.includes("bad")) {
					return "contains forbidden word";
				}
			},
		});

		const errors = collectValidationErrors({ name: "bad name" }, "create", {
			validations: { name: rule },
		});
		expect(errors.get("name")).toEqual(["contains forbidden word"]);
	});
});

describe("defineValidator", () => {
	test("registers and uses custom validator", () => {
		defineValidator("hex", (value, _record, options) => {
			if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
				return (options.message as string) ?? "is not a valid hex color";
			}
			return undefined;
		});

		const rule = validates("hex");

		const invalidErrors = collectValidationErrors({ color: "red" }, "create", {
			validations: { color: rule },
		});
		expect(invalidErrors.get("color")).toEqual(["is not a valid hex color"]);

		const validErrors = collectValidationErrors(
			{ color: "#ff0000" },
			"create",
			{ validations: { color: rule } },
		);
		expect(validErrors.isEmpty).toBe(true);
	});

	test("throws on unknown validator", () => {
		const rule = validates("nonexistent");
		expect(() =>
			collectValidationErrors({ field: "value" }, "create", {
				validations: { field: rule },
			}),
		).toThrow("Unknown validator: nonexistent");
	});
});

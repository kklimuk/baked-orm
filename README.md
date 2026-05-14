# baked-orm

A convention-over-configuration ORM and migration tool for Bun. TypeScript-first, PostgreSQL-native.

baked-orm is built around a single idea: **migrations build the schema, introspection generates a typed `db/schema.ts`, and that one schema feeds both your backend models and your frontend hydration.** You write the SQL once. The types follow.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [1. Schema](#1-schema)
  - [Database config](#database-config)
  - [Create or drop a database](#create-or-drop-a-database)
  - [Writing migrations](#writing-migrations)
  - [Running migrations](#running-migrations)
  - [Generated schema file](#generated-schema-file)
  - [Connection pool](#connection-pool)
- [2. Models](#2-models)
  - [Generating a model](#generating-a-model)
  - [Defining a model](#defining-a-model)
  - [Associations](#associations)
  - [Polymorphic belongsTo](#polymorphic-belongsto)
  - [Validations](#validations)
  - [Callbacks](#callbacks)
  - [Dirty tracking](#dirty-tracking)
  - [Enum support](#enum-support)
  - [Virtual attributes](#virtual-attributes)
- [3. Querying](#3-querying)
  - [CRUD and upserts](#crud-and-upserts)
  - [Query builder](#query-builder)
  - [Subqueries in where()](#subqueries-in-where)
  - [Lazy and eager loading](#lazy-and-eager-loading)
  - [Scoped associations](#scoped-associations)
  - [Aggregations](#aggregations)
  - [Recursive tree traversal](#recursive-tree-traversal)
  - [Pluck and distinct](#pluck-and-distinct)
  - [Raw SQL](#raw-sql)
  - [Transactions](#transactions)
  - [Pessimistic locking](#pessimistic-locking)
  - [Batch processing](#batch-processing)
  - [Soft deletes](#soft-deletes)
- [4. Serializing and frontend hydration](#4-serializing-and-frontend-hydration)
  - [Backend serialization](#backend-serialization)
  - [Frontend models](#frontend-models)
  - [Hydrating API responses](#hydrating-api-responses)
  - [Forms with dirty tracking and validation](#forms-with-dirty-tracking-and-validation)
- [Plugins](#plugins)
- [Development](#development)
- [Editor setup](#editor-setup)
- [License](#license)

## Install

```bash
bun add baked-orm
```

The `bake` CLI is installed as a bin — run it directly with `bun bake <command>` from any project that has baked-orm as a dependency.

## Quick start

The whole pipeline in one place: a migration produces `db/schema.ts`, a backend model wraps the generated row class, a frontend model wraps the *same* row class, and `__typename` carries the wiring between them.

```bash
# 1. Schema
bun add baked-orm
echo "DATABASE_URL=postgres://localhost/myapp" > .env
bun bake db create
bun bake db generate create_users          # edit migrations, then:
bun bake db generate create_posts          # posts.user_id references users.id
bun bake db migrate up                     # writes db/schema.ts
bun bake model User
bun bake model Post
```

```ts
// 2. Backend: models/user.ts + models/post.ts — declare the association
import { Model, hasMany, belongsTo } from "baked-orm";
import { users, posts } from "../db/schema";
import type { Post } from "./post";
import type { User } from "./user";

export class User extends Model(users, {
  posts: hasMany<Post>("Post"),
}) {
  static sensitiveFields = ["passwordDigest"];   // excluded from JSON + redacted in logs
}

export class Post extends Model(posts, {
  author: belongsTo<User>("User", { foreignKey: "userId" }),
}) {}

// 2b. Backend: app.ts — eager-load, exclude secrets, project just the post fields you need
import { connect } from "baked-orm";
import { User } from "./models/user";

await connect();
const user = await User.where({ id }).includes("posts").first();
return Response.json(user.serialize({
  include: { posts: { only: ["id", "title"] } },
}));
//   { __typename: "User", id, name, email, ...,         ← no passwordDigest
//     posts: [{ __typename: "Post", id, title }, ...] } ← only the two columns
```

```ts
// 3. Frontend: frontend/models/user.ts + post.ts — same schema, same association shape
import { FrontendModel, registerModels } from "baked-orm/frontend";
import { users, posts } from "../db/schema";       // same schema file the backend uses

export class User extends FrontendModel(users) {
  declare posts: Post[];
}

export class Post extends FrontendModel(posts) {
  declare author: User;
}

registerModels({ User, Post });

// 3b. Frontend: app.tsx — hydrate the nested payload and walk the association
const payload = await fetch("/api/users/1").then((response) => response.json());
const user = User.fromJSON(payload);

user.createdAt;                  // Temporal.Instant (auto-converted from ISO)
user.posts[0];                   // Post instance — fully typed, not a plain object
user.posts[0].title;             // string
user.posts[0].changed("title");  // dirty tracking works on the nested instance too
```

Migrations build the schema, introspection generates `db/schema.ts`, both backend and frontend models wrap those same types, and `__typename` carries the wiring across the wire. Everything else in this README is a refinement of those four steps.

## 1. Schema

### Database config

In most cases, paste the connection URL your hosting provider gave you into `.env` and you're done:

```env
DATABASE_URL=postgres://user:pass@host:5432/myapp
```

baked-orm checks `POSTGRES_URL`, `DATABASE_URL`, then `PGURL` (and falls back to discrete `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` if you'd rather split them out). That's enough to run with zero configuration.

To override paths, tune the connection pool, or add hooks, generate a `baked.config.ts`:

```bash
bun bake db init
```

The generated file uses `defineConfig` and is pre-populated from your env vars:

```ts
import { defineConfig } from "baked-orm";

export default defineConfig({
  database: Bun.env.DATABASE_URL,
  // or, for finer-grained control:
  // database: { hostname: ..., port: ..., username: ..., password: ..., database: ... },
  migrationsPath: "./db/migrations",
  schemaPath: "./db/schema.ts",
  modelsPath: "./models",
  frontendModelsPath: "./frontend/models",
});
```

`connect()` can also take an `onQuery` callback for logging:

```ts
await connect({
  onQuery: ({ text, values, durationMs }) => {
    console.log(`[${durationMs.toFixed(1)}ms] ${text}`);
  },
});
```

### Create or drop a database

```bash
bun bake db create myapp           # explicit name
bun bake db create                 # name resolved from config / env
bun bake db drop myapp
bun bake db drop                   # resolves name, then prompts you to type it
bun bake db drop --yes             # skip the prompt
```

Both commands connect to the `postgres` maintenance database. `bake db drop` without an explicit name prompts for a type-to-confirm; pass `--yes` to skip (useful in CI where the target is pinned by env).

### Writing migrations

```bash
bun bake db generate <name>
```

Creates `db/migrations/{timestamp}.<name>.ts`. The generator picks a template based on the naming prefix:

| Prefix | Generates |
|---|---|
| `create_enum_<name>` | `CREATE TYPE <name> AS ENUM (...)` + `DROP TYPE` |
| `create_<table>` | `CREATE TABLE` with id, timestamps, `set_updated_at` trigger + `DROP TABLE` |
| `soft_delete_<table>` | `ADD COLUMN discarded_at` + partial index + `DROP COLUMN` |
| `update_<table>`, `alter_<table>` | `ALTER TABLE ADD COLUMN` + `DROP COLUMN` |
| `delete_<table>`, `drop_<table>` | `DROP TABLE` + `CREATE TABLE` stub |
| (none) | Blank `up`/`down` |

Example generated `create_users`:

```ts
import type { TransactionSQL } from "bun";

export async function up(txn: TransactionSQL) {
  await txn`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function down(txn: TransactionSQL) {
  await txn`DROP TABLE users`;
}
```

### Running migrations

```bash
bun bake db migrate up              # all pending
bun bake db migrate up --count=1    # next pending only
bun bake db migrate down            # rollback last
bun bake db migrate down --count=3  # rollback last 3
bun bake db status                  # applied vs. pending
```

Every migration runs inside a transaction guarded by `pg_advisory_xact_lock` — concurrent runs serialize safely, and any failure rolls the whole step back. If two developers generate migrations with the same-second timestamp, baked-orm refuses to run them; rename one to resolve.

### Generated schema file

After every `migrate`, baked-orm introspects the database and rewrites `db/schema.ts` with:

- **Enum types** — PostgreSQL enums introspected from `pg_enum`, emitted as TypeScript string union types plus runtime `XxxValues` const arrays.
- **Row classes** — typed classes with `declare`'d camelCase properties matching your columns. You extend these with `Model()` (backend) and `FrontendModel()` (frontend).
- **Table definitions** — column metadata, primary keys, indexes (including partial-index `where` predicates and functional-index expressions), foreign keys, and enum values.
- **Composite types** — standalone `CREATE TYPE ... AS (...)` composites as classes. Table row composites that PostgreSQL auto-creates are excluded.

This file is the single source of truth for both backend and frontend types — don't edit it by hand.

### Connection pool

When using object-style database config, you can tune Bun's connection pool:

```ts
export default defineConfig({
  database: {
    hostname: "localhost",
    database: "myapp",
    max: 20,                // max connections (default: 10)
    idleTimeout: 30,        // seconds before closing idle (default: 0)
    maxLifetime: 3600,      // max connection lifetime (default: 0)
    connectionTimeout: 10,  // seconds to wait for a connection (default: 30)
  },
});
```

URL-style `database` strings use Bun's defaults.

## 2. Models

### Generating a model

```bash
bun bake model User                          # infers table "users"
bun bake model BlogPost                      # infers table "blog_posts"
bun bake model User --table user_accounts    # explicit table name
```

Generates both backend and frontend files:

```
models/user.ts              ← import { Model } from "baked-orm"
frontend/models/user.ts     ← import { FrontendModel } from "baked-orm/frontend"
```

| Flag | Description |
|------|-------------|
| `--table <name>` | Explicit table name (default: inferred) |
| `--backend <path>` | Override backend output directory |
| `--frontend <path>` | Override frontend output directory |
| `--no-frontend` | Skip frontend model |
| `--no-backend` | Skip backend model |

### Defining a model

`Model(tableDefinition, associations?)` returns a class extending the generated row class with CRUD, queries, validations, callbacks, and dirty tracking:

```ts
// models/user.ts
import { Model } from "baked-orm";
import { users } from "../db/schema";

export class User extends Model(users) {
  get initials() {
    return this.name.split(" ").map((word) => word[0]).join("");
  }
}
```

All snake_case DB column names are auto-converted to camelCase on the row class (`user_id` → `userId`). The original DB name is preserved on the column definition for the query builder to translate back — you never write snake_case in TypeScript.

### Associations

Four kinds: `hasMany`, `hasOne`, `belongsTo`, `hasManyThrough`. The preferred style uses string-based model references with `import type` to dodge circular imports:

```ts
// models/user.ts
import { Model, hasMany } from "baked-orm";
import { users } from "../db/schema";
import type { Post } from "./post";
import type { Comment } from "./comment";

export class User extends Model(users, {
  posts: hasMany<Post>("Post"),
  comments: hasMany<Comment>("Comment", { as: "commentable" }),
}) {}
```

```ts
// models/post.ts
import { Model, belongsTo, hasMany, hasManyThrough } from "baked-orm";
import { posts } from "../db/schema";
import type { User } from "./user";
import type { Comment } from "./comment";
import type { Tag } from "./tag";

export class Post extends Model(posts, {
  author: belongsTo<User>("User", { foreignKey: "userId" }),
  comments: hasMany<Comment>("Comment", { as: "commentable" }),
  tags: hasManyThrough<Tag>("Tag", { through: "taggings" }),
}) {}
```

Types are fully inferred: `user.load("posts")` returns `Promise<Post[]>`, `post.load("author")` returns `Promise<User | null>`. String refs resolve through the model registry at runtime.

Alternative forms when a string registry isn't a good fit:

- **Thunk refs** for same-file models: `hasMany(() => Post)` — TypeScript infers the target from the thunk.
- **Static + `declare`** for same-file circular references: `static posts = User.hasMany(() => Post)` paired with `declare posts: Post[]`. Needed because TypeScript can't resolve circular base expressions inline.

### Polymorphic belongsTo

A polymorphic `belongsTo` resolves to one of several target types at runtime via a `_type` column on the child table. It's a flavor of `belongsTo`, not a fifth association kind:

```ts
// models/comment.ts
import { Model, belongsTo } from "baked-orm";
import { comments } from "../db/schema";
import type { Post } from "./post";
import type { User } from "./user";

export class Comment extends Model(comments, {
  commentable: belongsTo<Post | User>({ polymorphic: true }),
}) {}
```

`comment.load("commentable")` returns `Promise<Post | User | null>`. The class name stored in `commentable_type` is looked up in the model registry — make sure every potential target's `Model()` factory has run at load time. Polymorphic `defaultScope` builders take a second argument (the resolved target class) so the scope can branch on capabilities; see [Scoped associations](#scoped-associations).

### Validations

Declared as a static property, Rails-style, with structured errors:

```ts
import { Model, validates, validate } from "baked-orm";

class User extends Model(users) {
  static validations = {
    name: validates("presence"),
    email: [
      validates("presence"),
      validates("email"),
      validates("length", { maximum: 255 }),
    ],
    age: validates("numericality", { greaterThanOrEqualTo: 0, integer: true }),
    role: validates("inclusion", { in: ["admin", "user", "moderator"] }),
  };

  static customValidations = [
    validate((record) => {
      if (record.name === record.email) {
        return { name: "must be different from email" };
      }
    }),
  ];
}
```

If you want TypeScript to flag typos in field names, add `satisfies ValidationConfig<User>` to the end of the literal — it's purely opt-in.

Built-in validators: `presence`, `length`, `numericality`, `format`, `inclusion`, `exclusion`, `email`. All accept `message?`, `on?: "create" | "update"`, and `if?: (record) => boolean`:

```ts
validates("presence", { on: "create" })
validates("presence", { if: (record) => record.role === "admin" })
```

Register your own:

```ts
import { defineValidator, validates } from "baked-orm";

defineValidator("companyEmail", (value, record, options) => {
  if (typeof value !== "string" || !value.endsWith("@company.com")) {
    return options.message ?? "must be a company email address";
  }
});

class Employee extends Model(employees) {
  static validations = { email: validates("companyEmail") };
}
```

Errors are structured:

```ts
try {
  await user.save();
} catch (error) {
  if (error instanceof ValidationError) {
    error.errors.get("email");         // ["is not a valid email address"]
    error.errors.fullMessages();       // ["Email is not a valid email address"]
    error.errors.toJSON();             // { email: ["is not a valid email address"] }
  }
}

if (!(await user.isValid())) {
  console.log(user.errors.fullMessages());
}
```

Bulk operations (`createMany`, `upsertAll`, `updateAll`, `deleteAll`) skip validations and callbacks.

### Callbacks

Lifecycle hooks declared as static arrays:

```ts
class User extends Model(users) {
  static beforeSave = [(record) => { record.email = record.email.toLowerCase(); }];

  static afterCreate = [async (record) => {
    await AuditLog.create({ action: "user_created", userId: record.id });
  }];

  static beforeDestroy = [async (record) => { await record.load("posts"); }];
}
```

Execution order:

- **Save:** `beforeValidation` → validations → `afterValidation` → `beforeSave` → `beforeCreate`/`beforeUpdate` → SQL → `afterCreate`/`afterUpdate` → `afterSave`
- **Destroy:** `beforeDestroy` → SQL → `afterDestroy`
- **Discard:** `beforeDiscard` → SQL → `afterDiscard`
- **Undiscard:** `beforeUndiscard` → SQL → `afterUndiscard`

A throwing `before*` callback aborts the operation.

### Dirty tracking

Only modified columns are sent in `UPDATE` queries — no last-write-wins on concurrent requests:

```ts
const user = await User.find(id);
user.changed();               // false
user.name = "New Name";
user.changed();               // true
user.changed("name");         // true
user.changedAttributes();     // { name: { was: "Old", now: "New" } }
await user.save();            // UPDATE users SET "name" = $1 WHERE "id" = $2
```

Saving a persisted record with no changes skips the UPDATE entirely.

**JSON/JSONB columns.** The generated schema types `json`/`jsonb` columns as `unknown`. Narrow with `declare`:

```ts
interface UserSettings {
  theme: "light" | "dark";
  notifications: { email: boolean; push: boolean };
}

class User extends Model(users) {
  declare settings: UserSettings;
}

user.settings.theme;                    // "light" | "dark"
user.settings.notifications.email;      // boolean
```

Dirty tracking detects in-place mutations on JSON columns via `structuredClone` on capture and `Bun.deepEquals` on comparison:

```ts
const user = await User.find(id);
user.settings.theme = "dark";           // mutate in place
user.changed("settings");               // true
await user.save();                      // SET "settings" = $1
```

For very large JSON blobs, replace the reference (`user.settings = { ...newValue }`) to avoid the deep-comparison cost. The same pattern works on `FrontendModel`.

### Enum support

PostgreSQL enums are first-class. After running the migration, the generated schema includes:

```ts
// db/schema.ts
export type Status = "active" | "inactive" | "archived";
export const StatusValues = ["active", "inactive", "archived"] as const;

export class UsersRow {
  declare id: string;
  declare status: Status;
}
// columnDefinition.status.enumValues === StatusValues
```

Enum columns are **auto-validated** — no `validates("inclusion")` needed:

```ts
const user = new User({ status: "deleted" });
await user.isValid();              // false
user.errors.get("status");         // ["is not a valid value (must be one of: active, inactive, archived)"]
```

Generate an enum migration with `bun bake db generate create_enum_status`.

### Virtual attributes

Attach computed or query-derived fields and have them serialized automatically — no registry, no decorators. Two flavors, both auto-detected:

```ts
class Page extends Model(pages, { statuses: hasMany<PageStatus>("PageStatus") }) {
  // Computed virtual: a class getter — always called and serialized
  get fullTitle(): string {
    return `${this.section}: ${this.title}`;
  }

  // Settable virtual: a class field with a default — settable via SQL alias,
  // findBySql, or runtime assignment
  following: boolean | null = null;
}

const page = await Page.find(1);
page.toJSON();
// → { __typename: "Page", id: 1, title: "...", section: "...",
//     fullTitle: "Section A: Hello", following: null }

// Populate `following` via a SQL annotation:
const [annotated] = await Page.findBySql(`
  SELECT pages.*, EXISTS(
    SELECT 1 FROM page_statuses WHERE page_id = pages.id AND user_id = $1
  ) AS following
  FROM pages WHERE id = $2
`, [userId, pageId]);
annotated.following;            // true (assigned during hydration)
annotated.toJSON().following;   // true
```

**Frontend models declare virtuals the same way.** `FrontendModel` shares the auto-detection and serialization machinery with the backend `Model`. Computed getters re-derive from the hydrated columns; settable virtuals are populated by `hydrate()` from the JSON payload the server sent:

```ts
// client — frontend/models/page.ts
import { FrontendModel } from "baked-orm/frontend";
import { pages } from "../db/schema";

class Page extends FrontendModel(pages) {
  get fullTitle(): string {
    return `${this.section}: ${this.title}`;
  }
  following: boolean | null = null;
}

const page = Page.fromJSON(await fetch("/api/page/1").then((r) => r.json()));
page.following;   // true (carried from the server payload during hydration)
page.fullTitle;   // computed on the frontend
page.toJSON();    // { __typename, id, title, section, fullTitle, following }
```

You only need to declare a settable virtual on the frontend if you want a typed default or want the field to appear in `toJSON()` output even when the server didn't send it. Server-only fields that always arrive in the payload will still hydrate and serialize through the instance's index signature — they just won't have a named type.

Detection is mechanical: computed virtuals are getters declared on your own subclass prototype (plugin-added getters like `isDiscarded` live on a parent prototype and aren't picked up); settable virtuals are own-properties that aren't columns or associations. Names starting with `_` are skipped by convention. Virtuals never participate in dirty tracking or UPDATE SQL.

`only`/`except`/`sensitiveFields` filters apply to virtuals uniformly:

```ts
page.serialize({ only: ["id", "fullTitle"] });
page.serialize({ except: ["following"] });

class Page extends Model(pages) {
  get internalToken() { return derive(this.id); }
  static sensitiveFields = ["internalToken"];
}
```

For a one-off serialization without declaring a virtual, `serialize({ methods: [...] })` is the Rails `as_json(methods:)` equivalent:

```ts
class Page extends Model(pages) {
  computeBadge(): string { return `★ ${this.title}`; }
}
page.serialize({ methods: ["computeBadge"] });
// → { __typename, ...columns, computeBadge: "★ Hello" }
```

## 3. Querying

### CRUD and upserts

```ts
// Create
const user = await User.create({ name: "Alice", email: "alice@example.com" });

// Mass create
await User.createMany([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
]);

// Find
const found = await User.find(id);              // throws RecordNotFoundError
const maybe = await User.findBy({ email });     // null if missing

// Update
await user.update({ name: "Alice Smith" });

// Save (INSERT if new, UPDATE if persisted)
const fresh = new User({ name: "Alice" });
await fresh.save();

// Destroy
await user.destroy();
```

Upserts share a unified `conflict` option, available on `create`, `createMany`, `upsert`, `upsertAll`. `ConflictTarget` accepts either `{ columns }` (optionally with a `where` for partial unique indexes) or `{ constraint }` (named constraint, no `where`):

```ts
// Column-based conflict
await User.upsert(
  { email: "alice@example.com", name: "Alice Updated" },
  { conflict: { columns: ["email"] } },
);

// Partial unique index
await Share.upsertAll(rows, {
  conflict: {
    columns: ["resourceType", "resourceId", "userId"],
    where: { sourceShareId: { ne: null } },
  },
});

// Named constraint
await Share.upsertAll(rows, { conflict: { constraint: "shares_inherited_unique" } });

// Insert-or-skip
await User.createMany(rows, { conflict: "ignore" });
await User.create(attrs, { conflict: "ignore" });
```

`upsert`/`upsertAll` default to `action: "update"`; `create`/`createMany` default to `action: "ignore"`. With `DO NOTHING`, returned arrays may be shorter than input (and `create` may leave the instance un-persisted).

### Query builder

Chainable, immutable, thenable — `await User.where(...)` executes:

```ts
const results = await User.where({ name: "Alice" }).order({ createdAt: "DESC" }).limit(10);
const count = await User.where({ active: true }).count();
const exists = await User.exists({ email: "alice@example.com" });

// Mass operations
await User.where({ active: false }).updateAll({ deletedAt: now });
await User.where({ active: false }).deleteAll();

// Raw fragments
await User.whereRaw('"age" > $1', [18]).order({ name: "ASC" });
```

**`where()` value forms:** scalar (equality, `null` → `IS NULL`), array (`IN`, `[]` → `FALSE`), or an operator record `{ eq, ne, gt, ... }`. Multiple operators on the same column AND together. Top-level keys are joined with AND; nest `or:` / `and:` for arbitrary grouping.

```ts
await User.where({ name: "Alice" });
await User.where({ deletedAt: null });
await User.where({ id: ["a", "b", "c"] });

// Comparison and range
await User.where({ age: { gte: 18 } });
await User.where({ age: { gte: 18, lte: 65 } });

// IN / NOT IN
await User.where({ id: { in: ["a", "b"] } });
await User.where({ status: { not_in: ["deleted", "banned"] } });

// String matching
await User.where({ email: { ilike: "%@example.com" } });
await User.where({ name: { contains: "ali" } });       // LIKE %ali%
await User.where({ name: { starts_with: "Al" } });     // LIKE Al%

// Mixed scalar + operator
await User.where({
  active: true,
  age: { gte: 18 },
  email: { ilike: "%@company.com" },
});

// OR / AND grouping
await User.where({
  or: [{ name: { ilike: "%alice%" } }, { email: { ilike: "%alice%" } }],
}).limit(20);

await User.where({
  active: true,
  or: [{ role: "admin" }, { role: "owner" }],
});
```

| Operator | SQL |
|---|---|
| `eq` | `=` (or `IS NULL`) |
| `ne` | `!=` (or `IS NOT NULL`) |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` |
| `in` | `IN (...)` — empty array → `FALSE` |
| `not_in` | `NOT IN (...)` — empty array → `TRUE` |
| `like`, `ilike` | `LIKE` / `ILIKE` — wildcards passed through |
| `contains`, `starts_with`, `ends_with` | Sugar over `LIKE` that wraps with `%` |

Range and string operators are statically constrained by column type — `where({ active: { ilike: "x" } })` fails to typecheck on a boolean.

**JSON/JSONB:** an object value is always treated as a literal, never an operator record. `where({ metadata: { eq: 5 } })` on a JSONB column inserts that object as the bound value.

**Timestamps:** equality operators on `timestamptz`/`timestamp` columns wrap the column in `date_trunc('milliseconds', col)` so JS `Date` values round-trip against PostgreSQL's microsecond storage. Range operators use the bare column for index-friendliness.

**Edge case:** a column literally named `or` or `and` collides with the grouping keys — fall back to `whereRaw` for those.

### Subqueries in where()

Pass a `QueryBuilder` as a `where()` value to emit `IN (SELECT ...)` — one round trip instead of two:

```ts
// Default projection → primary key
await Post.where({ userId: User.where({ active: true }) });
// → WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "active" = $1)

// Explicit single-column projection
await Post.where({ userId: User.where({ active: true }).select("id") });

// NOT IN via operator
await Post.where({ userId: { not_in: User.where({ active: true }) } });

// Composes with or/and groups, and with inner order/limit/distinct
await Post.where({
  or: [
    { userId: User.where({ active: true }).order({ name: "ASC" }).limit(10) },
    { title: "public" },
  ],
});
```

Without `.select()`, the projection defaults to the primary key (single-PK tables only). Multi-column `.select()` throws. Recursive CTE scopes cannot be subqueries — materialize with `pluck()` first.

### Lazy and eager loading

Load on demand:

```ts
const posts = await user.load("posts");           // Post[]
const author = await post.load("author");         // User | null
const target = await comment.load("commentable"); // Post | User | null
```

Results are cached on the instance — a second `load()` returns the same data without a query.

Eager-load via `includes()` to avoid N+1:

```ts
const users = await User.where({ active: true }).includes("posts").toArray();
// users[0].posts is already populated

const deep = await User.all()
  .includes("posts.comments", "posts.author", "profile")
  .toArray();
// every level loaded with one extra query per level
```

### Scoped associations

`hasMany`, `hasOne`, `hasManyThrough`, `belongsTo`, and polymorphic `belongsTo` accept a `defaultScope` builder that filters, orders, or transforms the loaded query — applied during both eager (`includes`) and lazy (`load`) loading:

```ts
class Thread extends Model(threads) {
  static softDelete = true;
  static comments = Thread.hasMany(() => Comment, {
    defaultScope: (query) => query.kept().order({ createdAt: "ASC" }),
  });
}

// thread.comments is already filtered + ordered — no JS post-processing
const threads = await Thread.kept().includes("comments").toArray();
```

`hasManyThrough` additionally accepts `defaultThroughScope` for filtering the join table independently:

```ts
class Post extends Model(posts) {
  static taggings = Post.hasMany(() => Tagging);
  static tags = Post.hasManyThrough(() => Tag, {
    through: "taggings",
    defaultThroughScope: (query) => query.kept(),         // filter join table
    defaultScope: (query) => query.where({ active: true }), // filter target
  });
}
```

When a scope sets `.limit(N)` or `.offset(N)`, the eager loader rewrites the batched query as `ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY <scope_order>)` so the limit applies per-parent — `.limit(3)` returns up to 3 rows for *each* parent, not 3 total. Lazy loaders use limit normally since the query is already per-parent.

One-off overrides via `includes(path, options)`. `false` bypasses the scope; a function replaces it:

```ts
// Include discarded rows just this once
await Thread.all().includes("comments", { scope: false }).toArray();

// Only discarded
await Thread.all()
  .includes("comments", { scope: (query) => query.discarded() })
  .toArray();
```

Overrides apply only to the top-level association (path's first segment). To override a nested level, declare a second association without the scope and `includes()` that one.

Polymorphic scopes must be target-agnostic — the scope's second argument is the resolved target class. Branch on it when some targets aren't soft-delete-enabled (see [Polymorphic belongsTo](#polymorphic-belongsto)):

```ts
static commentable = Comment.belongsTo({
  polymorphic: true,
  defaultScope: (query, target) => (target.softDelete ? query.kept() : query),
});
```

### Aggregations

Rails-style calculations — `count`, `sum`, `avg`, `min`, `max` — plus `group(...)`, `havingRaw(...)`, and an `aggregate({...})` escape hatch for non-standard aggregates. Available on both `Model` statics and `QueryBuilder`:

```ts
// Scalar (no group()) — Promise<number | null>
await Order.sum("total");                                // 750
await Order.where({ status: "active" }).sum("total");    // 650
await Order.avg("total");                                // 125
await Order.min("createdAt");                            // earliest Date | null
await Order.max("total");                                // 300
// .count() returns Promise<number> (0 for empty sets) — unchanged

// Grouped — Array<{ ...groupCols, fn }>
await Order.group("status").count();
//   [{ status: "active", count: 4 }, { status: "cancelled", count: 2 }]

await Order.group("userId").sum("total");

// Multi-column group
await Order.group("userId", "status").count();

// HAVING — post-aggregation filter (escape hatch, raw SQL)
await Order.group("userId").havingRaw("COUNT(*) > $1", [1]).count();

// Non-standard aggregates
await Order.group("userId").aggregate({
  totalSum: "SUM(total)",
  orderCount: "COUNT(*)",
  itemIds: "ARRAY_AGG(id)",
});
```

Array-of-objects (not `Map`) because JS `Map` uses reference equality, which makes multi-column tuple keys awkward.

Composes with the rest of the builder:

```ts
await Order.kept().group("userId").sum("total");

await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .group("kind")
  .count();

// "scalar subquery" via materialize-then-use
const avg = await Order.avg("total");
const aboveAvg = await Order.where({ total: { gt: avg as number } }).count();
```

Guards (thrown at the terminal call):

- `group() + lock()` → Postgres rejects `FOR UPDATE` on aggregates.
- `group() + distinct()` → ambiguous; use `aggregate({ ct: "COUNT(DISTINCT col)" })`.
- `group() + includes()` → eager loading on aggregated rows is meaningless.
- `sum`/`avg` on a non-numeric column → throws with the column name and type.
- `havingRaw()` without `group()` → Postgres rejects HAVING without GROUP BY.
- Aggregate-active builder used as a `where()` subquery operand → projection conflict; materialize with `await` first.

### Recursive tree traversal

For self-referential tables, `descendants()` and `ancestors()` walk the tree via `WITH RECURSIVE`. The current scope's predicates seed the anchor and propagate at every recursive level:

```ts
// Walk down from a root
const subtreeIds = await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .pluck("id");

// Walk up from a leaf
const chainIds = await Page.where({ id: leafId })
  .ancestors({ via: "parentId" })
  .pluck("id");

// Scope predicates propagate to every level — multi-tenant safe
await Page.kept()
  .where({ orgId: tenant.id, id: rootId })
  .descendants({ via: "parentId" })
  .toArray();

// Predicates added AFTER the recursive call apply to the outer SELECT only
// — they filter the result without pruning the walk
await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .where({ title: "TODO" })
  .count();
```

- **Cycle safety:** `UNION` (set semantics) by default — cycles terminate naturally. Pass `setSemantics: false` to `recursiveOn` for `UNION ALL` when you can guarantee acyclicity.
- **Soft delete interaction:** `Page.kept().descendants(...)` filters discarded rows *and* blocks subtree traversal through them.
- **Limitations:** the seed scope can't have `order`/`limit`/`offset`; `descendants`/`ancestors` require a single-column PK; `updateAll`/`deleteAll`/`discardAll` throw on a recursive scope.

`recursiveOn({ from, to })` is the underlying primitive — use it directly for non-tree edges.

### Pluck and distinct

```ts
const emails = await User.where({ active: true }).pluck("email");      // string[]
const rows = await User.pluck("id", "email");                          // [string, string][]
const userIds = await Post.distinct().pluck("userId");
```

`pluck`, `count`, `exists`, and `toArray` all share a single SQL builder parameterized by projection — so plugins like `recursive-cte` and `aggregates` compose with all of them transparently.

### Raw SQL

`findBySql` returns fully hydrated model instances with dirty tracking, `save()`, and the full ORM surface:

```ts
const users = await User.findBySql("SELECT * FROM users WHERE name = $1", ["Alice"]);

const activePosters = await User.findBySql(`
  SELECT u.* FROM users u
  JOIN posts p ON p.user_id = u.id
  GROUP BY u.id
  HAVING COUNT(p.id) > $1
`, [5]);

activePosters[0].name = "Updated";
await activePosters[0].save();
```

`query<T>()` returns typed plain objects — use it for aggregates, groupings, or cross-table queries that don't map to a single model:

```ts
import { query } from "baked-orm";

const departments = await query("SELECT department, COUNT(*) FROM users GROUP BY department");

type DeptCount = { department: string; count: number };
const deptCounts = await query<DeptCount>(
  "SELECT department, COUNT(*)::int as count FROM users GROUP BY department",
);

const totals = await query<{ total: number }>(
  "SELECT COUNT(*)::int as total FROM users WHERE active = $1",
  [true],
);
```

Both `findBySql` and `query` are transaction-aware — they automatically use the current transaction connection.

### Transactions

All queries inside a `transaction()` block share a connection:

```ts
import { transaction } from "baked-orm";

await transaction(async () => {
  const user = await User.create({ name: "Alice" });
  await Post.create({ title: "Hello", userId: user.id });
  // auto-rollback on any error
});
```

Isolation levels via an options object as the first argument — `"read committed"` (default), `"repeatable read"`, `"serializable"`:

```ts
await transaction({ isolation: "serializable" }, async () => { ... });
```

Nested `transaction()` calls automatically use PostgreSQL savepoints — inner errors roll back only the inner block:

```ts
await transaction(async () => {
  await User.create({ name: "Alice" });

  try {
    await transaction(async () => {
      await User.create({ name: "Bob" });
      throw new Error("rollback inner only");
    });
  } catch {
    // Alice persists, Bob rolls back
  }
});
```

Isolation levels can't be set on nested transactions (PostgreSQL limitation).

### Pessimistic locking

Lock rows for safe read-modify-write under concurrency:

```ts
// Instance withLock() — the most ergonomic path
await account.withLock(async (account) => {
  account.balance -= 100;
  await account.save();
});

// Instance lock() — when you're already in a transaction
await transaction(async () => {
  await account.lock();
  account.balance -= 100;
  await account.save();
});

// QueryBuilder lock() — for query chains
await transaction(async () => {
  const locked = await Account.where({ id: 1 }).lock().first();
});

// Lock modes + suffixes
await account.lock("FOR NO KEY UPDATE");
await account.lock("FOR SHARE");
await account.lock("FOR UPDATE NOWAIT");

// SKIP LOCKED — job queue pattern
await transaction(async () => {
  const jobs = await Job.where({ status: "pending" })
    .lock("FOR UPDATE SKIP LOCKED")
    .limit(10)
    .toArray();
});
```

`lock()` outside a transaction throws — the lock would release immediately. `lock()` on a recursive CTE scope also throws (Postgres doesn't allow `FOR UPDATE` on CTEs). `withLock(callback, mode?)` opens a transaction, locks, runs the callback, and rolls back on error.

### Batch processing

Process large tables without loading everything into memory. Cursor-based pagination, safe under concurrent modification:

```ts
// One record at a time, fetched in batches of 1000 (default)
for await (const user of User.where({ active: true }).findEach({ batchSize: 1000 })) {
  await sendEmail(user.email);
}

// Or work with batches directly
for await (const batch of User.all().findInBatches({ batchSize: 500 })) {
  await bulkIndex(batch);
}

// Custom order — cursor comparison flips automatically for DESC
for await (const user of User.all().findEach({ order: { createdAt: "DESC" } })) {
  console.log(user.createdAt);
}
```

Default cursor is the primary key ascending.

### Soft deletes

Opt in with `static softDelete = true`. Follows the Ruby [discard](https://github.com/jhawthorn/discard) pattern — `destroy()` is not overridden, no default scope, no hidden WHERE clauses:

```ts
class Post extends Model(posts) {
  static softDelete = true;
}

await post.discard();
post.isDiscarded;          // true
post.isKept;               // false
await post.undiscard();
await post.destroy();      // still hard-deletes
```

Query scopes are explicit:

```ts
await Post.all();                                       // everything
await Post.kept();                                      // not discarded
await Post.kept().where({ authorId: user.id }).order({ createdAt: "DESC" });
await Post.discarded();                                 // only discarded

// Bulk (skip callbacks)
await Post.where({ authorId: user.id }).discardAll();
await Post.discarded().undiscardAll();
```

Lifecycle callbacks: `beforeDiscard` / `afterDiscard` / `beforeUndiscard` / `afterUndiscard`. They do **not** run save validations.

Add the column to an existing table with `bun bake db generate soft_delete_posts`.

## 4. Serializing and frontend hydration

The full server-to-client pipeline: backend serializes to JSON, frontend hydrates into typed `FrontendModel` instances. Every serialized object includes `__typename` (GraphQL-style) so the frontend knows which class to hydrate into.

### Backend serialization

Mark sensitive fields once — they're excluded from JSON output *and* redacted from query logs:

```ts
// models/user.ts (server)
import { Model, hasMany } from "baked-orm";
import { users } from "../db/schema";
import type { Post } from "./post";

export class User extends Model(users, { posts: hasMany<Post>("Post") }) {
  static sensitiveFields = ["passwordDigest"];
}
```

`toJSON()` returns all non-sensitive columns plus `__typename`. For associations and field control, use `serialize()` with Rails-style options:

```ts
const user = await User.find(id);
await user.load("posts");

user.toJSON();
// → { __typename: "User", id, name, email, createdAt }

user.serialize({ include: ["posts", "posts.comments"] });

user.serialize({
  only: ["id", "name", "email"],
  include: {
    posts: { only: ["id", "title"], include: { comments: { except: ["spam"] } } },
  },
});
```

### Frontend models

Import from `baked-orm/frontend` — a lightweight entrypoint with no server dependencies. Frontend models share the same `db/schema.ts` and support dirty tracking, validations, and hydration:

```ts
// frontend/models/user.ts (client)
import { FrontendModel, registerModels, validates } from "baked-orm/frontend";
import { users, posts } from "../db/schema";

class User extends FrontendModel(users) {
  static validations = { name: validates("presence"), email: validates("email") };
  declare posts: Post[];
}

class Post extends FrontendModel(posts) {
  declare author: User;
}

// Register once at app startup so hydrate() can resolve __typename.
// The object key becomes the class's stable `typename` — it survives JS minification,
// unlike `class.name` under `minify.identifiers`.
registerModels({ User, Post });
```

### Hydrating API responses

`fromJSON()` (the static) and `hydrate()` (the standalone) convert date strings to `Temporal.Instant`, resolve nested associations via `__typename`, populate virtual attributes carried in the payload, and mark instances as persisted:

```ts
const data = await fetch("/api/users/1").then((response) => response.json());
const user = User.fromJSON(data);

user.createdAt;              // Temporal.Instant (auto-converted from ISO)
user.posts[0];               // Post instance, not a plain object
user.isNewRecord;            // false (came from server)
```

### Forms with dirty tracking and validation

```ts
user.name = "Updated";
user.changed("name");        // true
user.changedAttributes();    // { name: { was: "Old", now: "Updated" } }

user.name = "";
user.isValid();              // false
user.errors.fullMessages();  // ["Name can't be blank"]

// Back to JSON for the API request
user.toJSON();
// → { __typename: "User", id, name: "", email, createdAt: Temporal.Instant }
```

## Plugins

baked-orm has a plugin system for extending `Model`, `QueryBuilder`, and auto-serialized virtuals with custom methods, getters, and fields. The built-in features — **soft delete**, **pessimistic locking**, **recursive CTEs**, **batch iteration**, and **aggregations** — are all implemented as plugins using the same public API. They auto-register on `import "baked-orm"`; you don't need to wire them up.

To author your own plugin or read the canonical examples, see the full guide at [src/plugins/README.md](src/plugins/README.md).

## Development

```bash
bun install

# Integration tests require a local PostgreSQL database
bun bake db create baked_orm_test

bun test           # run tests
bun run check      # biome + knip + tsc
bun run format     # auto-fix lint issues
```

## Editor setup

For SQL syntax highlighting inside template literals, install the [SQL tagged template literals](https://marketplace.visualstudio.com/items?itemName=frigus02.vscode-sql-tagged-template-literals-syntax-only) VS Code extension. It highlights SQL in tagged templates like `` txn`SELECT * FROM users` ``.

## License

MIT

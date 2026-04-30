# baked-orm

A convention-over-configuration ORM and migration tool for Bun. TypeScript-first, PostgreSQL-native, with auto-generated typed schemas, ActiveRecord-inspired querying, validations, callbacks, and dirty tracking.

## Install

```bash
bun add baked-orm
```

## Setup

Add a script alias to your `package.json`:

```json
{
  "scripts": {
    "bake": "bake"
  }
}
```

Bun automatically reads your `.env` file for database configuration:

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=password
PGDATABASE=myapp
```

## Commands

### Initialize config (optional)

```bash
bun bake db init
```

Generates a `baked.config.ts` with default settings, pre-populated with database connection details from your environment variables. This is optional — baked-orm works with zero configuration.

### Create or drop a database

```bash
bun bake db create myapp           # Create the database
bun bake db drop myapp             # Drop the database
bun bake db create                 # Use database name from config / env
bun bake db drop                   # Type-to-confirm prompt before dropping
bun bake db drop --yes             # Skip the confirmation prompt
```

Connects to the `postgres` maintenance database to run `CREATE DATABASE` or `DROP DATABASE`. Uses connection details from your config or `PG*` env vars. If no database name is passed, falls back to the one resolved from `baked.config.ts` or the `POSTGRES_URL` / `DATABASE_URL` / `PGDATABASE` env vars.

**Drop is destructive.** When `bake db drop` is run without an explicit name, it prompts you to type the resolved database name to confirm. Mismatched input aborts. Pass `--yes` (or `-y`) to skip the prompt — useful for CI/automation where you've intentionally pinned the target via env. Explicit `bake db drop <name>` does not prompt: typing the name on the command line counts as the confirmation.

### Generate a migration

```bash
bun bake db generate <migration_name>
```

Creates a timestamped migration file at `db/migrations/{timestamp}.<name>.ts`.

The generator recognizes naming conventions and scaffolds contextual templates:

| Command | Generates |
|---|---|
| `bun bake db generate create_enum_status` | `CREATE TYPE status AS ENUM (...)` + `DROP TYPE` |
| `bun bake db generate create_users` | `CREATE TABLE users` with id, timestamps, `updated_at` trigger + `DROP TABLE` |
| `bun bake db generate soft_delete_posts` | `ADD COLUMN discarded_at` + partial index + `DROP COLUMN` |
| `bun bake db generate update_users` | `ALTER TABLE users ADD COLUMN` + `DROP COLUMN` |
| `bun bake db generate alter_users` | Same as `update_` |
| `bun bake db generate delete_users` | `DROP TABLE users` + `CREATE TABLE` stub |
| `bun bake db generate drop_users` | Same as `delete_` |
| `bun bake db generate add_indexes` | Blank `up`/`down` template |

Example generated file for `create_users`:

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

### Run migrations

```bash
bun bake db migrate up              # Run all pending migrations
bun bake db migrate up --count=1    # Run next pending migration
bun bake db migrate down            # Rollback last migration
bun bake db migrate down --count=3  # Rollback last 3 migrations
```

All migrations run inside a transaction with an advisory lock to prevent concurrent execution. If any step fails, the entire migration is rolled back.

**Conflict detection:** If two developers generate migrations with the same timestamp (same second), baked-orm detects the duplicate and throws an error before running. Rename one of the conflicting files to resolve.

### Check status

```bash
bun bake db status
```

Shows which migrations have been applied and which are pending.

### Generate a model

```bash
bun bake model User                          # infers table "users"
bun bake model BlogPost                      # infers table "blog_posts"
bun bake model User --table user_accounts    # explicit table name
```

Generates both backend and frontend model files:

```
models/user.ts              ← import { Model } from "baked-orm"
frontend/models/user.ts     ← import { FrontendModel } from "baked-orm/frontend"
```

Options:

| Flag | Description |
|------|-------------|
| `--table <name>` | Explicit table name (default: inferred) |
| `--backend <path>` | Override backend output directory |
| `--frontend <path>` | Override frontend output directory |
| `--no-frontend` | Skip frontend model |
| `--no-backend` | Skip backend model |

Output directories default to `modelsPath` and `frontendModelsPath` from `baked.config.ts`.

## Schema file

After each migration, baked-orm introspects your database and generates a typed schema file at `db/schema.ts`. This file contains:

- **Enum types** — PostgreSQL enum types introspected from `pg_enum`, generated as TypeScript string union types with runtime const arrays for validation
- **Row classes** — typed classes with `declare`'d properties matching your table columns, extendable in your own code
- **Table definitions** — column metadata, primary keys, indexes (including partial-index `where` predicates and functional-index expressions), foreign keys, and enum values
- **Composite types** — standalone `CREATE TYPE ... AS (...)` composite types generated as classes (table row types are excluded — only user-declared composites appear here)

## ORM

baked-orm includes an ActiveRecord-inspired ORM. Define models by wrapping the generated table definitions with `Model()`:

### Setup

```ts
import { connect } from "baked-orm";

await connect(); // reads baked.config.ts, establishes connection

// Or with query logging:
await connect({
  onQuery: ({ text, values, durationMs }) => {
    console.log(`[${durationMs.toFixed(1)}ms] ${text}`);
  },
});
```

### Define models

Each model lives in its own file. Use string-based model references with `import type` to avoid circular imports — TypeScript infers the association types automatically:

```ts
// models/user.ts
import { Model, hasMany } from "baked-orm";
import { users } from "../db/schema";
import type { Post } from "./post";
import type { Comment } from "./comment";

export class User extends Model(users, {
  posts: hasMany<Post>("Post"),
  comments: hasMany<Comment>("Comment", { as: "commentable" }),
}) {
  get initials() {
    return this.name.split(" ").map(word => word[0]).join("");
  }
}
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

```ts
// models/comment.ts — polymorphic
import { Model, belongsTo } from "baked-orm";
import { comments } from "../db/schema";
import type { Post } from "./post";
import type { User } from "./user";

export class Comment extends Model(comments, {
  commentable: belongsTo<Post | User>({ polymorphic: true }),
}) {}
```

Association types are fully inferred: `user.load("posts")` returns `Promise<Post[]>`, `post.load("author")` returns `Promise<User | null>` — no manual type declarations needed. String-based refs (`"Post"` instead of `() => Post`) resolve from the model registry at runtime, and `import type` ensures no circular import issues.

### CRUD

```ts
// Create
const user = await User.create({ name: "Alice", email: "alice@example.com" });

// Mass create
const users = await User.createMany([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
]);

// Find
const found = await User.find(id);           // throws RecordNotFoundError
const maybe = await User.findBy({ email });   // null if missing

// Update
await user.update({ name: "Alice Smith" });

// Save (INSERT if new, UPDATE if persisted)
const user = new User({ name: "Alice" });
await user.save();

// Destroy
await user.destroy();

// Upsert (insert or update on conflict)
await User.upsert(
  { email: "alice@example.com", name: "Alice Updated" },
  { conflict: { columns: ["email"] } },
);

// Upsert with partial unique index
await Share.upsertAll(rows, {
  conflict: {
    columns: ["resourceType", "resourceId", "userId"],
    where: { sourceShareId: { ne: null } },
  },
});

// Upsert with named constraint
await Share.upsertAll(rows, {
  conflict: { constraint: "shares_inherited_unique" },
});

// Insert-or-skip (ON CONFLICT DO NOTHING)
await User.createMany(rows, { conflict: "ignore" });
await User.create(attrs, { conflict: "ignore" });
```

### Query builder

Chainable, immutable, and thenable — `await User.where(...)` executes directly:

```ts
const results = await User.where({ name: "Alice" }).order({ createdAt: "DESC" }).limit(10);
const count = await User.where({ active: true }).count();
const exists = await User.exists({ email: "alice@example.com" });

// Mass operations
await User.where({ active: false }).updateAll({ deletedAt: now });
await User.where({ active: false }).deleteAll();

// Raw SQL fragments
await User.whereRaw('"age" > $1', [18]).order({ name: "ASC" });

// Pluck raw column values (no model hydration)
const emails = await User.where({ active: true }).pluck("email"); // string[]
const rows = await User.pluck("id", "email");                     // [string, string][]

// Distinct
const userIds = await Post.distinct().pluck("userId");
```

#### where() — operators and grouping

`where()` accepts a scalar (equality), an array (`IN`), `null` (`IS NULL`), or an operator record `{ eq, ne, gt, ... }`. Multiple operators on the same column AND together. Top-level keys are joined with AND; nest `or:` / `and:` for arbitrary groupings.

```ts
// Scalar equality, null, and IN — all type-safe
await User.where({ name: "Alice" });
await User.where({ deletedAt: null });
await User.where({ id: ["a", "b", "c"] });   // string[] — no casts

// Comparison operators
await User.where({ age: { gte: 18 } });
await User.where({ createdAt: { lt: cutoff } });

// Range query — multiple operators AND on one column
await User.where({ age: { gte: 18, lte: 65 } });

// IN / NOT IN
await User.where({ id: { in: ["a", "b"] } });
await User.where({ status: { not_in: ["deleted", "banned"] } });

// String matching
await User.where({ email: { ilike: "%@example.com" } });
await User.where({ name: { contains: "ali" } });        // → LIKE %ali%
await User.where({ name: { starts_with: "Al" } });      // → LIKE Al%
await User.where({ name: { ends_with: "ce" } });        // → LIKE %ce

// Mixed scalar + operator on the same call (ANDed together)
await User.where({
  active: true,
  age: { gte: 18 },
  email: { ilike: "%@company.com" },
});

// OR / AND grouping (arbitrary nesting)
await User.where({
  or: [
    { name: { ilike: "%alice%" } },
    { email: { ilike: "%alice%" } },
  ],
}).limit(20);

// Nested: top-level AND with an OR group
await User.where({
  active: true,
  or: [{ role: "admin" }, { role: "owner" }],
});
```

Operator reference:

| Operator | SQL |
|---|---|
| `eq` | `=` (or `IS NULL` if value is null) |
| `ne` | `!=` (or `IS NOT NULL` if value is null) |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` |
| `in` | `IN (...)` — empty array → `FALSE` |
| `not_in` | `NOT IN (...)` — empty array → `TRUE` |
| `like`, `ilike` | `LIKE` / `ILIKE` (case-insensitive) — wildcards passed through |
| `contains`, `starts_with`, `ends_with` | Sugar over `LIKE` that wraps the value with `%` |

Range operators (`gt`/`gte`/`lt`/`lte`) and string operators (`like`/`ilike`/`contains`/`starts_with`/`ends_with`) are statically constrained by the column's TypeScript type — `where({ active: { ilike: "x" } })` fails to typecheck on a boolean column.

JSON/JSONB columns: an object value is always treated as a literal, never an operator record — so `where({ metadata: { eq: 5 } })` on a JSONB column inserts that object as the bound value.

Timestamp columns: equality operators (`=`, `!=`, `IN`, `NOT IN`) on `timestamptz`/`timestamp` columns automatically truncate to millisecond precision via `date_trunc('milliseconds', col)`, so JS `Date` values round-trip correctly despite PostgreSQL's microsecond storage. Range operators use the bare column for index-friendliness.

Limitation: a column literally named `or` or `and` collides with the grouping keys. Fall back to `whereRaw` for those cases.

#### Subqueries in where()

Pass a `QueryBuilder` directly as a `where()` value to emit an `IN (SELECT ...)` subquery — one roundtrip instead of two:

```ts
// Default projection → primary key
const activePosts = await Post.where({ userId: User.where({ active: true }) });
// → WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "active" = $1)

// Explicit single-column projection
await Post.where({ userId: User.where({ active: true }).select("id") });

// NOT IN via operator
await Post.where({ userId: { not_in: User.where({ active: true }) } });

// Composes with or/and groups
await Post.where({
  or: [
    { userId: User.where({ active: true }) },
    { title: "public" },
  ],
});

// Inner scope composes with order/limit/distinct
await Post.where({
  userId: User.where({ active: true }).order({ name: "ASC" }).limit(10),
});
```

Notes:

- No `.select()` → defaults to primary key (single-PK tables only).
- `.select()` with >1 column → throws (SQL `IN (SELECT a, b)` is not supported).
- Recursive CTE scopes cannot be used as subqueries — use `pluck()` to materialize first.

### Aggregations

Rails-style "calculations" — `count`, `sum`, `avg`, `min`, `max` — plus `group(...)`, `havingRaw(...)`, and an `aggregate({...})` escape hatch. Available on both `Model` statics and `QueryBuilder`, so `User.sum("balance")` and `User.where({ active: true }).sum("balance")` both work.

```ts
// Scalar (no group()) — returns Promise<number | null>
await Order.sum("total");                                // 750
await Order.where({ status: "active" }).sum("total");    // 650
await Order.avg("total");                                // 125
await Order.min("createdAt");                            // earliest Date | null
await Order.max("total");                                // 300
// .count() unchanged — Promise<number> (returns 0 for empty sets)

// Grouped — returns Array<{ ...groupCols, fn }>
await Order.group("status").count();
//   [{ status: "active", count: 4 }, { status: "cancelled", count: 2 }]

await Order.group("userId").sum("total");
//   [{ userId: "...", sum: 175 }, { userId: "...", sum: 275 }, ...]

// Multi-column group
await Order.group("userId", "status").count();
//   [{ userId, status, count }, ...]

// HAVING — post-aggregation filtering (escape hatch, raw SQL fragment)
await Order.group("userId").havingRaw("COUNT(*) > $1", [1]).count();

// aggregate({ alias: sqlFragment }) — for non-standard aggregates
// (array_agg, string_agg, stddev, etc.) on the grouped builder
await Order.group("userId").aggregate({
  totalSum: "SUM(total)",
  orderCount: "COUNT(*)",
  itemIds: "ARRAY_AGG(id)",
});
```

Result shape — array-of-objects, not `Map`. JS `Map` keys use reference equality, which makes multi-column tuple keys awkward (`m.get(["a", "b"])` won't find an entry stored under a structurally-equal-but-different-reference array). Drizzle and Prisma both ship array-of-objects for the same reason.

Composes with the rest of the query builder:

```ts
// Soft-delete filter pre-aggregation
await Order.kept().group("userId").sum("total");

// Recursive CTE then aggregate
await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .group("kind")
  .count();

// Materialize-then-use for "scalar subquery" patterns
const avg = await Order.avg("total");
const aboveAvg = await Order.where({ total: { gt: avg as number } }).count();
```

Guards (thrown at terminal-method invocation):

- `group() + lock()` → throws (Postgres rejects `FOR UPDATE` on aggregate queries)
- `group() + distinct()` → throws (use `aggregate({ ct: "COUNT(DISTINCT col)" })` instead)
- `group() + includes()` → throws (eager loading on aggregated rows is meaningless)
- `sum/avg` on a non-numeric column → throws with column name + type
- `havingRaw()` without `group()` → throws (Postgres rejects HAVING without GROUP BY)
- Aggregate-active QueryBuilder used as a `where()` subquery operand → throws (projection conflict; materialize with `await` first)

Out of scope for v1 (planned for v2): structured `having({ count: { gt: 5 } })`, multi-aggregate-per-query terminal (`pluck(count(), sum(...))`), scalar-form `aggregate({...})` (which would also unlock `ROW_NUMBER() OVER (...)`-style window expressions), single-round-trip scalar subqueries.

### Associations

Load associations explicitly. Return types are inferred from the model definition:

```ts
const posts = await user.load("posts");           // Post[]
const author = await post.load("author");         // User | null
const target = await comment.load("commentable"); // Post | User | null
const tags = await post.load("tags");             // Tag[]
```

Results are cached — calling `load()` again returns the same data without a query.

### Eager loading (N+1 prevention)

```ts
const users = await User.where({ active: true }).includes("posts").toArray();
// users[0].posts is already loaded — no extra query
```

Nested eager loading uses dotted paths:

```ts
const users = await User.all()
  .includes("posts.comments", "posts.author", "profile")
  .toArray();
// users[0].posts[0].comments — loaded in one query per level
// users[0].posts[0].author   — also loaded
```

### Scoped associations

`hasMany`, `hasOne`, `hasManyThrough`, `belongsTo`, and polymorphic `belongsTo` accept an optional `defaultScope` builder that filters, orders, or otherwise transforms the loaded query — applied during both eager (`includes`) and lazy (`load`) loading:

```ts
class Thread extends Model(threads) {
  static softDelete = true;
  static comments = Thread.hasMany(() => Comment, {
    defaultScope: (query) => query.kept().order({ createdAt: "ASC" }),
  });
}

// thread.comments is already filtered to kept rows in createdAt order — no JS post-processing
const threads = await Thread.kept().includes("comments").toArray();
```

`hasManyThrough` additionally accepts `defaultThroughScope` for filtering the join table independently:

```ts
class Post extends Model(posts) {
  static taggings = Post.hasMany(() => Tagging);
  static tags = Post.hasManyThrough(() => Tag, {
    through: "taggings",
    defaultThroughScope: (query) => query.kept(), // filter the join table
    defaultScope: (query) => query.where({ active: true }), // filter the target
  });
}
```

When a scope sets `.limit(N)` or `.offset(N)`, the eager loader rewrites the batched query as `ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY <scope_order>)` so the limit applies per-parent — `.limit(3)` returns up to 3 rows for *each* parent, not 3 total. Lazy loading uses limit normally because the query is already per-parent.

For one-off overrides (e.g. an admin view that wants discarded rows), pass a `scope` option to `.includes()`. `false` bypasses the declared scope; a function replaces it:

```ts
// All comments including discarded ones, just for this query
const threads = await Thread.all()
  .includes("comments", { scope: false })
  .toArray();

// Only discarded comments
const auditView = await Thread.all()
  .includes("comments", { scope: (query) => query.discarded() })
  .toArray();
```

The override applies only to the **top-level** association (the path's first segment). Nested levels in dotted paths (e.g. `"posts.comments"`) keep their declared scopes — to override a nested level, declare a second association without the scope and `.includes()` that one instead.

Polymorphic scopes must be target-agnostic — the same scope runs against every possible target type. The scope's second argument is the resolved target model class:

```ts
static commentable = Comment.belongsTo({
  polymorphic: true,
  defaultScope: (query, target) => target.softDelete ? query.kept() : query,
});
```

### Recursive tree traversal

For self-referential tables (e.g. a `pages` table with `parent_id`), `descendants()` and `ancestors()` walk the tree using a recursive CTE. The current scope's predicates seed the anchor and propagate to every recursive level:

```ts
// Walk down from a root page
const subtreeIds = await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .pluck("id");

// Walk up from a leaf
const chainIds = await Page.where({ id: leafId })
  .ancestors({ via: "parentId" })
  .pluck("id");

// Scope predicates propagate at every level — multi-tenant safe
const orgSubtree = await Page.kept()
  .where({ orgId: tenant.id, id: rootId })
  .descendants({ via: "parentId" })
  .toArray();

// Predicates added AFTER the recursive call apply to the outer query —
// they filter the result without pruning the walk
const matchingDescendants = await Page.where({ id: rootId })
  .descendants({ via: "parentId" })
  .where({ title: "TODO" })
  .count();
```

Notes:

- **Cycle safety:** uses `UNION` (set semantics) by default — cycles terminate naturally. Pass `setSemantics: false` to `recursiveOn` for `UNION ALL` if you can guarantee acyclicity.
- **Soft delete:** `Page.kept().descendants(...)` filters discarded rows AND blocks subtree traversal through them — a discarded mid-tree row hides its subtree from the walk.
- **Generic primitive:** `recursiveOn({ from, to })` is the underlying primitive. `descendants({ via })` is sugar for `recursiveOn({ from: via, to: <pk> })`; `ancestors({ via })` is sugar for `recursiveOn({ from: <pk>, to: via })`. Use `recursiveOn` directly for non-tree edges.
- **Limitations:** the seed scope cannot have `order/limit/offset` (apply ordering after the recursive scope), `descendants`/`ancestors` require a single-column primary key, and `updateAll`/`deleteAll`/`discardAll` are not supported on a recursive scope.

### Dirty tracking

Only modified columns are sent in UPDATE queries. This prevents last-write-wins on concurrent requests:

```ts
const user = await User.find(id);
user.changed();               // false
user.name = "New Name";
user.changed();               // true
user.changed("name");         // true
user.changed("email");        // false
user.changedAttributes();     // { name: { was: "Old", now: "New" } }
await user.save();            // UPDATE users SET "name" = $1 WHERE "id" = $2
// Only the "name" column is sent — not all columns
```

Saving a persisted record with no changes skips the UPDATE entirely.

#### JSON/JSONB columns

The generated schema types `json`/`jsonb` columns as `unknown`. Narrow the type with `declare` on your model:

```ts
// Define the shape of your JSON column
interface UserSettings {
  theme: "light" | "dark";
  notifications: { email: boolean; push: boolean };
}

// Generated schema (don't edit):
// export class UsersRow {
//   declare id: string;
//   declare settings: unknown;  // ← jsonb
// }

// Your model — narrow the type:
class User extends Model(users) {
  declare settings: UserSettings;
}

// Now fully typed:
user.settings.theme;                    // "light" | "dark"
user.settings.notifications.email;      // boolean
```

Dirty tracking works for in-place mutations of JSON columns — no need to replace the entire object:

```ts
const user = await User.find(id);
user.settings.theme = "dark";           // mutate in place
user.changed("settings");               // true — detected via deep comparison
await user.save();                      // UPDATE users SET "settings" = $1 WHERE "id" = $2
```

This uses `structuredClone` on capture and `Bun.deepEquals` on comparison. For very large JSON blobs, replacing the reference (`user.settings = { ...newValue }`) avoids the deep comparison cost.

The same pattern works with frontend models — `FrontendModel` shares the same `Snapshot` engine:

```ts
// frontend/models/user.ts
class User extends FrontendModel(users) {
  declare settings: UserSettings;
}

const user = User.fromJSON(apiResponse);
user.settings.theme = "dark";
user.changed("settings");               // true
```

### Transactions

All queries inside a `transaction()` block automatically use the same connection:

```ts
import { transaction } from "baked-orm";

await transaction(async () => {
  const user = await User.create({ name: "Alice" });
  await Post.create({ title: "Hello", userId: user.id });
  // Auto-rollback on any error
});
```

#### Isolation levels

Control the transaction isolation level by passing an options object as the first argument:

```ts
await transaction({ isolation: "serializable" }, async () => {
  // Runs at SERIALIZABLE isolation
});

await transaction({ isolation: "repeatable read" }, async () => {
  // Runs at REPEATABLE READ isolation
});
```

Supported levels: `"read committed"` (PostgreSQL default), `"repeatable read"`, `"serializable"`.

#### Nested transactions (savepoints)

Calling `transaction()` inside another `transaction()` automatically uses PostgreSQL savepoints. Inner errors roll back only the inner block:

```ts
await transaction(async () => {
  await User.create({ name: "Alice" });

  try {
    await transaction(async () => {
      await User.create({ name: "Bob" });
      throw new Error("rollback inner only");
    });
  } catch {
    // User "Alice" persists, "Bob" is rolled back
  }
});
```

Multiple levels of nesting are supported. Isolation levels cannot be set on nested transactions (PostgreSQL limitation).

### Pessimistic locking

Lock rows with `SELECT ... FOR UPDATE` to safely perform read-modify-write operations under concurrency:

```ts
import { transaction } from "baked-orm";

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
  const account = await Account.where({ id: 1 }).lock().first();
  // row is locked until the transaction commits
});

// Lock modes
await account.lock("FOR NO KEY UPDATE");
await account.lock("FOR SHARE");

// NOWAIT — throw immediately if the row is already locked
await transaction(async () => {
  await account.lock("FOR UPDATE NOWAIT");
});

// SKIP LOCKED — skip locked rows (job queue pattern)
await transaction(async () => {
  const jobs = await Job.where({ status: "pending" })
    .lock("FOR UPDATE SKIP LOCKED")
    .limit(10)
    .toArray();
});
```

Lock rules:
- **Requires a transaction** — calling `lock()` outside a transaction throws (the lock would release immediately)
- **Not allowed on recursive CTEs** — PostgreSQL doesn't support `FOR UPDATE` on CTEs
- `withLock(callback, mode?)` opens a transaction, locks the record, runs the callback, and returns the result. Rolls back on error

### Raw SQL

#### Model queries — `findBySql`

Execute raw SQL and get back fully hydrated model instances with dirty tracking, `save()`, and all ORM features:

```ts
// Basic query
const users = await User.findBySql("SELECT * FROM users WHERE name = $1", ["Alice"]);
// users: User[] — full model instances

// Complex SQL that the query builder can't express
const activePosters = await User.findBySql(`
  SELECT u.* FROM users u
  JOIN posts p ON p.user_id = u.id
  GROUP BY u.id
  HAVING COUNT(p.id) > $1
`, [5]);

// Returned instances work like any other model
activePosters[0].name = "Updated";
await activePosters[0].save();
```

#### Arbitrary queries — `query<T>()`

Execute raw SQL and get back typed plain objects — for aggregates, groupings, cross-table joins, and anything that doesn't map to a single model:

```ts
import { query } from "baked-orm";

// Untyped — returns Record<string, unknown>[]
const departments = await query("SELECT department, COUNT(*) as count FROM users GROUP BY department");

// Typed — returns DeptCount[]
type DeptCount = { department: string; count: number };
const deptCounts = await query<DeptCount>(
  "SELECT department, COUNT(*)::int as count FROM users GROUP BY department"
);

// Parameterized
const totals = await query<{ total: number }>(
  "SELECT COUNT(*)::int as total FROM users WHERE active = $1",
  [true]
);
```

Both `findBySql` and `query` are transaction-aware — they automatically use the current transaction connection when called inside a `transaction()` block.

### Batch processing

Process large tables without loading everything into memory:

```ts
// Iterate one record at a time, fetched in batches of 1000 (default)
for await (const user of User.where({ active: true }).findEach({ batchSize: 1000 })) {
  await sendEmail(user.email);
}

// Or work with batches directly
for await (const batch of User.all().findInBatches({ batchSize: 500 })) {
  await bulkIndex(batch);
}

// Custom ordering — cursor comparison flips automatically for DESC
for await (const user of User.all().findEach({ order: { createdAt: "DESC" } })) {
  console.log(user.createdAt);
}
```

Both use cursor-based pagination (keyset pagination) — safe for large tables and concurrent modifications. Defaults to primary key ascending; pass `order` to paginate by a different column.

### Validations

Declare field-level validations as static properties — Rails-style, with structured error handling:

```ts
import { Model, validates, validate } from "baked-orm";

class User extends Model(users, {
  posts: hasMany<Post>("Post"),
}) {
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

  // Record-level custom validations
  static customValidations = [
    validate((record) => {
      if (record.name === record.email) {
        return { name: "must be different from email" };
      }
    }),
  ];
}
```

Built-in validators: `presence`, `length`, `numericality`, `format`, `inclusion`, `exclusion`, `email`.

All validators accept `message?`, `on?: "create" | "update"`, and `if?: (record) => boolean` for conditional execution.

```ts
// Conditional: only on create
validates("presence", { on: "create" })

// Conditional: only when a condition is met
validates("presence", { if: (record) => record.role === "admin" })
```

Register your own reusable validators:

```ts
import { defineValidator, validates } from "baked-orm";

defineValidator("companyEmail", (value, record, options) => {
  if (typeof value !== "string" || !value.endsWith("@company.com")) {
    return options.message ?? "must be a company email address";
  }
});

// Use like any built-in
class Employee extends Model(employees) {
  static validations = {
    email: validates("companyEmail"),
  };
}
```

Validation errors are structured and inspectable:

```ts
import { ValidationError } from "baked-orm";

try {
  await user.save();
} catch (error) {
  if (error instanceof ValidationError) {
    error.errors.get("email");         // ["is not a valid email address"]
    error.errors.fullMessages();       // ["Email is not a valid email address"]
    error.errors.toJSON();             // { email: ["is not a valid email address"] }
  }
}

// Or check without throwing:
if (!await user.isValid()) {
  console.log(user.errors.fullMessages());
}
```

**Note:** Bulk operations (`createMany`, `upsertAll`, `updateAll`, `deleteAll`) skip validations and callbacks for performance.

### Enum support

PostgreSQL enum types are first-class citizens. After running migrations, the generated schema includes typed enums:

```ts
// Generated in db/schema.ts
export type Status = "active" | "inactive" | "archived";
export const StatusValues = ["active", "inactive", "archived"] as const;

export class UsersRow {
  declare id: string;
  declare status: Status;
}

// Column definition includes enumValues for runtime validation
// status: { type: "USER-DEFINED", nullable: false, columnName: "status", enumValues: StatusValues },
```

Enum columns are **auto-validated** — no need to manually declare `validates("inclusion")`. Invalid values produce clear error messages:

```ts
const user = new User({ status: "deleted" });
await user.isValid(); // false
user.errors.get("status"); // ["is not a valid value (must be one of: active, inactive, archived)"]
```

Generate an enum migration:

```bash
bun bake db generate create_enum_status
```

### Soft deletes (discard pattern)

Opt-in soft deletes that don't override `destroy()` and don't add default scopes — inspired by Ruby's [discard](https://github.com/jhawthorn/discard) gem:

```ts
class Post extends Model(posts) {
  static softDelete = true;
}

// Soft delete — sets discarded_at, does NOT delete the row
await post.discard();
post.isDiscarded;                        // true
post.isKept;                             // false

// Restore
await post.undiscard();

// Hard delete — still works, actually removes the row
await post.destroy();
```

Query scopes are explicit — no default scope, no hidden WHERE clauses:

```ts
// All records (including discarded)
await Post.all();

// Only non-discarded records
await Post.kept();
await Post.kept().where({ authorId: user.id }).order({ createdAt: "DESC" });

// Only discarded records
await Post.discarded();

// Bulk operations (skip callbacks)
await Post.where({ authorId: user.id }).discardAll();
await Post.discarded().undiscardAll();
```

Lifecycle callbacks:

```ts
class Post extends Model(posts) {
  static softDelete = true;
  static beforeDiscard = [(record) => {
    console.log(`Discarding post ${record.id}`);
  }];
  static afterUndiscard = [(record) => {
    console.log(`Restored post ${record.id}`);
  }];
}
```

Generate a migration to add the `discarded_at` column to an existing table:

```bash
bun bake db generate soft_delete_posts
```

### Callbacks

Lifecycle callbacks are declared as static arrays on the model class:

```ts
class User extends Model(users) {
  static beforeSave = [(record) => {
    record.email = record.email.toLowerCase();
  }];

  static afterCreate = [async (record) => {
    await AuditLog.create({ action: "user_created", userId: record.id });
  }];

  static beforeDestroy = [async (record) => {
    await record.load("posts");
  }];
}
```

Available hooks (in execution order):

**Save:** `beforeValidation` → validations → `afterValidation` → `beforeSave` → `beforeCreate`/`beforeUpdate` → SQL → `afterCreate`/`afterUpdate` → `afterSave`

**Destroy:** `beforeDestroy` → SQL → `afterDestroy`

**Discard:** `beforeDiscard` → SQL → `afterDiscard`

**Undiscard:** `beforeUndiscard` → SQL → `afterUndiscard`

If a `before*` callback throws, the operation aborts.

### Serialization & frontend hydration

baked-orm supports a full server-to-client data pipeline: serialize models to JSON on the backend, hydrate them into typed frontend model instances on the client. Every serialized object includes a `__typename` field (like GraphQL) so the frontend knows which model to hydrate into.

#### 1. Backend: define models with sensitive fields

Sensitive fields are excluded from serialization and redacted in query logs — passwords never leak to the client or into your log files:

```ts
// models/user.ts (server)
import { Model, hasMany } from "baked-orm";
import { users } from "../db/schema";
import type { Post } from "./post";

export class User extends Model(users, { posts: hasMany<Post>("Post") }) {
  static sensitiveFields = ["passwordDigest"];
}
```

#### 2. Backend: serialize for the API response

`toJSON()` includes all non-sensitive columns plus `__typename`. For associations and field control, use `serialize()` with Rails-style options:

```ts
// API handler
const user = await User.find(id);
await user.load("posts");

// Default — all non-sensitive columns + __typename
user.toJSON();
// → { __typename: "User", id: "...", name: "...", email: "...", createdAt: Date }

// With associations
user.serialize({ include: ["posts", "posts.comments"] });

// Column filtering + nested association options
user.serialize({
  only: ["id", "name", "email"],
  include: {
    posts: { only: ["id", "title"], include: { comments: { except: ["spam"] } } }
  }
});
```

#### 3. Frontend: define models and register them

Import from `baked-orm/frontend` — a lightweight entrypoint with no server dependencies. Frontend models share the same `db/schema.ts` table definitions and support dirty tracking, validations, and hydration:

```ts
// models/user.ts (client)
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
// The object key becomes the class's stable `typename` (used by `toJSON`) —
// object keys survive JavaScript minification, unlike `class.name`.
registerModels({ User, Post });
```

#### 4. Frontend: hydrate API responses

`fromJSON()` / `hydrate()` automatically converts date strings to `Temporal.Instant`, resolves nested associations via `__typename`, and marks instances as persisted:

```ts
const data = await fetch("/api/users/1").then(r => r.json());
const user = User.fromJSON(data);

user.createdAt;              // Temporal.Instant (auto-converted from ISO string)
user.posts[0];               // Post instance (not a plain object)
user.isNewRecord;            // false (came from server)
```

#### 5. Frontend: forms with dirty tracking and validation

```ts
// Track changes for forms
user.name = "Updated";
user.changed("name");        // true
user.changedAttributes();    // { name: { was: "Old", now: "Updated" } }

// Validate before submitting
user.name = "";
user.isValid();              // false
user.errors.fullMessages();  // ["Name can't be blank"]

// Serialize back for the API request
user.toJSON();
// → { __typename: "User", id: "...", name: "", email: "...", createdAt: Temporal.Instant }
```

### camelCase convention

All snake_case DB column names are automatically converted to camelCase in generated Row classes. You never write `user_id` — always `userId`. The actual DB column name is stored in `ColumnDefinition.columnName` for the query builder to translate back.

## Configuration

By default, baked-orm uses:

- **Migrations path**: `./db/migrations`
- **Schema path**: `./db/schema.ts`
- **Models path**: `./models`
- **Frontend models path**: `./frontend/models`
- **Database**: Bun's built-in SQL driver (reads from `PG*` env vars)

Override with `baked.config.ts`:

```ts
import { defineConfig } from "baked-orm";

// Connect with a URL:
export default defineConfig({
  database: Bun.env.POSTGRES_URL ?? Bun.env.DATABASE_URL,
});

// Or with individual options:
export default defineConfig({
  migrationsPath: "./db/migrations",
  schemaPath: "./db/schema.ts",
  modelsPath: "./models",
  frontendModelsPath: "./frontend/models",
  database: {
    hostname: Bun.env.PGHOST,
    port: Number(Bun.env.PGPORT),
    username: Bun.env.PGUSERNAME ?? Bun.env.PGUSER,
    password: Bun.env.PGPASSWORD,
    database: Bun.env.PGDATABASE,
  },
});
```

If `database` is omitted, Bun's default SQL driver is used (reads `PG*` env vars from `.env`).

### Connection pool

When using object-style database configuration, you can tune the connection pool:

```ts
export default defineConfig({
  database: {
    hostname: "localhost",
    database: "myapp",
    max: 20,                // Max connections (default: 10)
    idleTimeout: 30,        // Seconds before closing idle connections (default: 0)
    maxLifetime: 3600,      // Max connection lifetime in seconds (default: 0)
    connectionTimeout: 10,  // Seconds to wait for a connection (default: 30)
  },
});
```

Pool options are passed directly to Bun's SQL driver. URL-style `database` strings use Bun's defaults.

## Plugins

baked-orm has a plugin system for extending Model and QueryBuilder behavior. Built-in features like soft deletes, pessimistic locking, recursive CTEs, and batch iteration are all implemented as plugins using the same public API.

### Using a plugin

Import the plugin before creating any models — the import triggers `definePlugin()` which patches the prototypes:

```ts
// Import third-party or your own plugins before models
import "baked-orm-audit-log";
import "./plugins/my-custom-plugin";

// Now create models — they'll have the plugin methods
import { Model } from "baked-orm";
import { users } from "./db/schema";

class User extends Model(users) {}
```

Built-in plugins (soft-delete, locking, recursive-cte, batch-iteration) are imported automatically — you don't need to import them yourself.

### Writing a plugin

```ts
import { definePlugin } from "baked-orm";

definePlugin({
  name: "myPlugin",
  instance: { /* methods added to model instances */ },
  static: { /* methods added to model classes */ },
  queryBuilder: { /* methods added to QueryBuilder.prototype */ },
});
```

Add TypeScript types via declaration merging:

```ts
declare module "baked-orm" {
  interface BaseModel {
    myMethod(): Promise<void>;
  }
  interface QueryBuilder<Row> {
    myQueryMethod(): QueryBuilder<Row>;
  }
}
```

Call `definePlugin()` at module top-level so plugins register before models are created. See [`src/plugins/README.md`](src/plugins/README.md) for the full authoring guide, and the built-in plugins in `src/plugins/` for canonical examples.

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

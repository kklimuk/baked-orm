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
    "db": "bake"
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
bun db init
```

Generates a `baked.config.ts` with default settings, pre-populated with database connection details from your environment variables. This is optional — baked-orm works with zero configuration.

### Create or drop a database

```bash
bun db create myapp           # Create the database
bun db drop myapp             # Drop the database
```

Connects to the `postgres` maintenance database to run `CREATE DATABASE` or `DROP DATABASE`. Uses connection details from your config or `PG*` env vars.

### Generate a migration

```bash
bun db generate <migration_name>
```

Creates a timestamped migration file at `db/migrations/{timestamp}.<name>.ts`.

The generator recognizes naming conventions and scaffolds contextual templates:

| Command | Generates |
|---|---|
| `bun db generate create_users` | `CREATE TABLE users` with id, timestamps + `DROP TABLE` |
| `bun db generate update_users` | `ALTER TABLE users ADD COLUMN` + `DROP COLUMN` |
| `bun db generate alter_users` | Same as `update_` |
| `bun db generate delete_users` | `DROP TABLE users` + `CREATE TABLE` stub |
| `bun db generate drop_users` | Same as `delete_` |
| `bun db generate add_indexes` | Blank `up`/`down` template |

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
bun db migrate up              # Run all pending migrations
bun db migrate up --count=1    # Run next pending migration
bun db migrate down            # Rollback last migration
bun db migrate down --count=3  # Rollback last 3 migrations
```

All migrations run inside a transaction with an advisory lock to prevent concurrent execution. If any step fails, the entire migration is rolled back.

**Conflict detection:** If two developers generate migrations with the same timestamp (same second), baked-orm detects the duplicate and throws an error before running. Rename one of the conflicting files to resolve.

### Check status

```bash
bun db status
```

Shows which migrations have been applied and which are pending.

## Schema file

After each migration, baked-orm introspects your database and generates a typed schema file at `db/schema.ts`. This file contains:

- **Row classes** — typed classes with `declare`'d properties matching your table columns, extendable in your own code
- **Table definitions** — column metadata, primary keys, indexes, and foreign keys
- **Composite types** — Postgres composite types introspected from `pg_type` and generated as classes

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

Each model lives in its own file. Pass associations directly to `Model()` — TypeScript infers the types automatically:

```ts
// models/user.ts
import { Model, hasMany } from "baked-orm";
import { users } from "../db/schema";

export class User extends Model(users, {
  posts: hasMany(() => Post),
  comments: hasMany(() => Comment, { as: "commentable" }),
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

export class Post extends Model(posts, {
  author: belongsTo(() => User, { foreignKey: "userId" }),
  comments: hasMany(() => Comment, { as: "commentable" }),
  tags: hasManyThrough(() => Tag, { through: "taggings" }),
}) {}
```

```ts
// models/comment.ts — polymorphic
import { Model, belongsTo } from "baked-orm";
import { comments } from "../db/schema";

export class Comment extends Model(comments, {
  commentable: belongsTo<Post | User>({ polymorphic: true }),
}) {}
```

Association types are fully inferred: `user.load("posts")` returns `Promise<Post[]>`, `post.load("author")` returns `Promise<User | null>` — no manual type declarations needed.

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

// Upsert
await User.upsert(
  { email: "alice@example.com", name: "Alice Updated" },
  { conflictColumns: ["email"] },
);
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
```

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

### Batch processing

Process large tables without loading everything into memory:

```ts
// Iterate one record at a time, fetched in batches of 1000 (default)
await User.where({ active: true }).findEach(async (user) => {
  await sendEmail(user.email);
}, { batchSize: 1000 });

// Or work with batches directly
await User.all().findInBatches(async (batch) => {
  await bulkIndex(batch);
}, { batchSize: 500 });
```

Both use cursor-based pagination (keyset pagination on the primary key) — safe for large tables and concurrent modifications.

### Validations

Declare field-level validations as static properties — Rails-style, with structured error handling:

```ts
import { Model, validates, validate } from "baked-orm";

class User extends Model(users, {
  posts: hasMany(() => Post),
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

If a `before*` callback throws, the operation aborts.

### camelCase convention

All snake_case DB column names are automatically converted to camelCase in generated Row classes. You never write `user_id` — always `userId`. The actual DB column name is stored in `ColumnDefinition.columnName` for the query builder to translate back.

## Configuration

By default, baked-orm uses:

- **Migrations path**: `./db/migrations`
- **Schema path**: `./db/schema.ts`
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

## Development

```bash
bun install

# Integration tests require a local PostgreSQL database
bun db create baked_orm_test

bun test           # run tests
bun run check      # biome + knip + tsc
bun run format     # auto-fix lint issues
```

## Editor setup

For SQL syntax highlighting inside template literals, install the [SQL tagged template literals](https://marketplace.visualstudio.com/items?itemName=frigus02.vscode-sql-tagged-template-literals-syntax-only) VS Code extension. It highlights SQL in tagged templates like `` txn`SELECT * FROM users` ``.

## License

MIT

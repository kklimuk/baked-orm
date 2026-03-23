# baked-orm

A convention-over-configuration database migration tool for Bun. TypeScript-first, PostgreSQL-native, with auto-generated typed schemas.

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

Row classes are extendable:

```ts
import { UsersRow } from "./db/schema";

class User extends UsersRow {
  get initials() {
    return this.name.split(" ").map(n => n[0]).join("");
  }
}
```

## Configuration

By default, baked-orm uses:

- **Migrations path**: `./db/migrations`
- **Schema path**: `./db/schema.ts`
- **Database**: Bun's built-in SQL driver (reads from `PG*` env vars)

Override with `baked.config.ts`:

```ts
import { defineConfig } from "baked-orm";

export default defineConfig({
  migrationsPath: "./db/migrations",
  schemaPath: "./db/schema.ts",
  // Connect with a URL
  database: Bun.env.POSTGRES_URL ?? Bun.env.DATABASE_URL,
  // Or with individual options
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

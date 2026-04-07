# baked-orm

Database migration tool and ORM for Bun. PostgreSQL only via `Bun.sql`.

## Commands

- `bun run check` — runs biome, knip, and tsc
- `bun test` — runs unit and integration tests (requires local `baked_orm_test` database)
- `bun run format` — auto-fix biome issues
- `bun bake db <command>` — database CLI (requires `"bake": "bake"` script alias)
- `bun bake model <Name>` — generate backend + frontend model files

## Code style

- Bun-first: use `Bun.file`, `Bun.write`, `Bun.env`, `Bun.$` over Node.js equivalents
- Import builtins without `node:` prefix (`import { resolve } from "path"`, not `"node:path"`)
- No single or two-letter variable names. Use descriptive names (`connection` not `db`, `txn` not `tx`, `row` not `r`)
- Use `@js-temporal/polyfill` for date/time operations, not `Date` constructors
- Tabs for indentation, double quotes for strings (enforced by biome)
- camelCase for all JS/TS property names; snake_case DB columns are auto-converted

## Tooling

- **Biome** for linting and formatting. `useNodejsImportProtocol` and `noThisInStatic` rules are disabled
- **Knip** for unused exports/deps detection. Run with `knip-bun` (not `knip`) due to ESM compat
- **Husky** pre-commit hook runs all three checks
- **TypeScript** strict mode, `noUncheckedIndexedAccess` enabled
- **Bun test** for unit and integration tests. Tests live in `tests/`

## Conventions

Migration name prefixes scaffold contextual templates:
- `create_enum_<name>` — CREATE TYPE AS ENUM + DROP TYPE
- `create_<table>` — CREATE TABLE with id, created_at, updated_at + `set_updated_at()` trigger + DROP TABLE
- `soft_delete_<table>` — ADD COLUMN discarded_at + partial index + DROP COLUMN
- `update_<table>` or `alter_<table>` — ALTER TABLE ADD COLUMN + DROP COLUMN
- `delete_<table>` or `drop_<table>` — DROP TABLE + CREATE TABLE stub
- No prefix — blank up/down template

IMPORTANT: always update CLAUDE.md and README.md before committing.

## Architecture

### CLI
- `src/cli.ts` — CLI entry with namespace routing. `bake db <command>` for migrations, `bake model <Name>` for model generation
- `src/commands/model.ts` — `runModel()` generates backend and frontend model files. Uses `toPascalCase` for class names, `toSnakeCase` for file/table names, infers table name by lowercasing + "s". Supports `--table`, `--backend`, `--frontend`, `--no-frontend`, `--no-backend` flags

### Migration system
- `src/config.ts` — loads `baked.config.ts`, provides `getConnection()` for DB access
- `src/runner.ts` — migration discovery, advisory locking, transactional up/down execution, duplicate timestamp detection
- `src/introspect.ts` — queries `information_schema` + `pg_type` to generate typed `db/schema.ts` with camelCase properties and `columnName` mapping. Introspects PostgreSQL enum types (`pg_enum`) and emits TypeScript string union types + `Values` const arrays in the schema. Enum columns use `udt_name` for type resolution when `data_type` is `USER-DEFINED`
- `src/commands/` — one file per CLI command (init, create, drop, generate, migrate, status)

### ORM layer
- `src/model/base.ts` — `Model()` mixin function. Returns a class extending the generated Row class with CRUD, query, association, validation, callback, and dirty tracking methods. Uses `this` in static methods for polymorphic subclass support. `save()` runs validation + callback lifecycle; `#performUpdate()` only sends dirty columns. `assignAttributes()` sets multiple fields without saving (used by `update()` internally)
- `src/model/query.ts` — immutable, chainable `QueryBuilder`. Uses parameterized queries via `executeQuery()` for SQL injection safety. Thenable via `then()`. Includes `findEach`/`findInBatches` for cursor-based batch processing
- `src/model/associations.ts` — `loadAssociation()` and `preloadAssociations()` for belongsTo, hasOne, hasMany, hasManyThrough, and polymorphic associations. Supports nested eager loading via dotted paths (`includes("posts.comments")`). Model registry maps class names to constructors for polymorphic resolution
- `src/model/validations.ts` — `validates()` factory for field-level rules (presence, length, numericality, format, inclusion, exclusion, email), `validate()` for record-level custom validators, `defineValidator()` registry for user-defined validators, `collectValidationErrors()` runner. Enum columns with `enumValues` in their `ColumnDefinition` are auto-validated without explicit `validates("inclusion")` — invalid values produce `"is not a valid value (must be one of: ...)"` errors
- `src/model/callbacks.ts` — `runCallbacks()` discovers and executes lifecycle callback arrays from static properties on the model class
- `src/model/errors.ts` — `ValidationError` (thrown by `save()` on failure) and `ValidationErrors` (Rails-like Map-backed error collection with `add`, `get`, `fullMessages`, `fullMessagesFor`, `toJSON`)
- `src/model/connection.ts` — connection singleton wrapping existing config system. `AsyncLocalStorage` scopes transactions. Supports `onQuery` callback for query logging
- `src/model/utils.ts` — shared utilities: `quoteIdentifier`, `resolveColumnName`, `buildReverseColumnMap`, `mapRowToModel`, `hydrateInstance`, `executeQuery` (with logging + sensitive column redaction), `buildConflictClause`, `buildSensitiveColumns`
- `src/model/types.ts` — `ModelStatic<Row>`, `BaseModel`, `AnyModelStatic`, `AssociationDefinition`, `RecordNotFoundError`. Also exports branded association types (`HasManyDef`, `HasOneDef`, `BelongsToDef`, `HasManyThroughDef`) and standalone factory functions (`hasMany`, `hasOne`, `belongsTo`, `hasManyThrough`) for the `Model(table, associations)` API. Factory functions accept either string model names (resolved from registry) or thunks (`() => Model`); string overloads take an explicit generic for type inference: `hasMany<Post>("Post")`

### Association declaration patterns
- **Preferred (separate files):** `Model(table, { posts: hasMany<Post>("Post") })` with `import type { Post }` — string-based model refs resolve from the registry at runtime, `import type` avoids circular imports, branded defs + `AssociationProperties` mapped type infer instance types automatically
- **Same-file (no circular imports):** `Model(table, { posts: hasMany(() => Post) })` — thunk-based refs work when both models are in the same file or there are no circular dependencies. TypeScript infers the target type from the thunk
- **Same-file circular refs:** `static posts = User.hasMany(() => Post)` + `declare posts: Post[]` — TypeScript can't resolve circular base expressions in the same file, so one side of a bidirectional relationship needs the static property + declare pattern

### Enum support
- PostgreSQL `CREATE TYPE ... AS ENUM` types are introspected from `pg_enum` and emitted in `db/schema.ts` as TypeScript string union types (`type Status = "active" | "inactive"`) plus runtime const arrays (`const StatusValues = ["active", "inactive"] as const`)
- `ColumnDefinition` has optional `enumValues?: readonly string[]` — populated automatically for enum columns in the generated schema, referencing the `Values` const
- Enum columns are auto-validated: `collectValidationErrors()` checks `enumValues` on column definitions, so models get enum validation for free without explicit `validates("inclusion")`
- Migration template: `create_enum_<name>` scaffolds `CREATE TYPE <name> AS ENUM (...)` + `DROP TYPE <name>`
- `mapPgType()` accepts an optional `enumNames` set — when a type name matches, it maps to the PascalCase TypeScript type name

### Soft deletes (discard pattern)
- Opt-in via `static softDelete = true` on the model class. Follows the Ruby `discard` gem pattern, NOT the `paranoia` pattern
- `destroy()` is NOT overridden — it still hard-deletes. Soft delete uses separate `discard()` / `undiscard()` verbs
- No default scope — `Model.where(...)` returns all records. Use `Model.kept()` / `Model.discarded()` for explicit filtering
- Column convention: `discarded_at` timestamptz (nullable), camelCase `discardedAt`
- Instance methods: `discard()` (sets `discarded_at = now()`), `undiscard()` (sets `discarded_at = NULL`), `isDiscarded` / `isKept` getters
- Static scopes: `Model.kept()` and `Model.discarded()` return `QueryBuilder` with WHERE clause pre-applied, chainable with `.where()`, `.order()`, etc.
- Own callback lifecycle: `beforeDiscard`/`afterDiscard`, `beforeUndiscard`/`afterUndiscard` — does NOT run save validations or save callbacks
- Bulk operations: `QueryBuilder.discardAll()` / `undiscardAll()` — skip callbacks, consistent with `updateAll`/`deleteAll`
- All soft-delete methods throw if `softDelete` is not enabled on the model
- Migration template: `soft_delete_<table>` scaffolds `ADD COLUMN discarded_at` + partial index `WHERE discarded_at IS NULL`

### Timestamps
- `create_<table>` migration template includes a shared `set_updated_at()` PostgreSQL trigger function (idempotent via `CREATE OR REPLACE`) and a per-table `trg_<table>_updated_at` trigger that auto-sets `updated_at = now()` on every UPDATE
- The trigger function is NOT dropped in migration `down` since other tables may reference it

### Validation and callback patterns
- **Associations** stay in `Model()` for type inference: `Model(table, { posts: hasMany<Post>("Post") })`
- **Validations** are declared as static properties: `static validations = { name: validates("presence") }`
- **Callbacks** are declared as static arrays: `static beforeSave = [(record) => { ... }]`
- Built-in validators: `presence`, `length`, `numericality`, `format`, `inclusion`, `exclusion`, `email`
- Custom validators: `defineValidator("name", fn)` then `validates("name")`
- Record-level custom validations: `static customValidations = [validate((record) => { ... })]`
- All validators accept `message?`, `on?: "create" | "update"`, `if?: (record) => boolean`. `numericality` also supports `notANumberMessage?` and `notAnIntegerMessage?` for per-check messages
- Type-safe field names via `static validations = { ... } satisfies ValidationConfig<Row>`
- Callback lifecycle (save): beforeValidation -> validations -> afterValidation -> beforeSave -> beforeCreate/beforeUpdate -> SQL -> afterCreate/afterUpdate -> afterSave
- Callback lifecycle (destroy): beforeDestroy -> SQL -> afterDestroy
- Callback lifecycle (discard): beforeDiscard -> SQL -> afterDiscard
- Callback lifecycle (undiscard): beforeUndiscard -> SQL -> afterUndiscard
- Bulk operations (`createMany`, `upsertAll`, `updateAll`, `deleteAll`) skip validations and callbacks

### Serialization
- `src/model/serializer.ts` — `serialize()` function produces JSON-ready objects with `__typename` (GraphQL-style type discriminator). Supports `only`/`except` column filtering, `sensitiveFields` (always excluded), and nested `include` for associations (string[] shorthand or per-association options)
- `toJSON()` delegates to `serialize()` without options — includes `__typename` + all non-sensitive columns
- `serialize({ include: ["posts.comments"], except: ["passwordDigest"] })` for explicit control
- `sensitiveFields` also redacts values in query logs — `executeQuery` accepts per-query `sensitiveColumns: Set<string>` (DB column names) and parses the SQL to match `$N` parameters to column names, redacting matches with `[REDACTED]`. Covers INSERT, UPDATE SET, WHERE, and batch operations. Per-model scoping via `buildSensitiveColumns()` with WeakMap caching — no global state

### Dirty tracking
- `src/model/snapshot.ts` — `Snapshot` class encapsulates snapshot-based dirty tracking. Shared between backend `Model` and frontend `FrontendModel`
- `Snapshot` methods: `capture(instance)`, `changed(instance, fieldName?)`, `changedAttributes(instance)`, `dirtyEntries(instance)`
- Both `ModelBase` and `FrontendBase` own a private `#snapshot: Snapshot` and delegate to it
- `save()` on a persisted record with no changes skips the UPDATE SQL entirely (callbacks still fire)
- Snapshot resets after `save()`, `reload()`, `markPersisted()` (called by `hydrateInstance`)
- JSON/JSONB columns use deep dirty tracking: `capture()` stores `structuredClone(value)` for JSON columns, `changed()` and `dirtyEntries()` use `Bun.deepEquals()` instead of `!==`. This detects in-place mutations like `user.metadata.theme = "dark"`. Non-JSON columns still use reference equality
- JSON column detection is automatic from `ColumnDefinition.type` (`"json"` or `"jsonb"`), computed once in the `Snapshot` constructor
- Users narrow `unknown` JSON column types via `declare` on their model subclass: `declare settings: UserSettings`

### Connection pool
- `DatabaseConfig` in `src/types.ts` accepts `max`, `idleTimeout`, `maxLifetime`, `connectionTimeout` — passed directly to `Bun.sql`

### Frontend model layer
- `src/frontend/model.ts` — `FrontendModel()` factory. Returns a class with dirty tracking (via `Snapshot`), validations (reuses `collectValidationErrors`), and `toJSON()` — but no CRUD, query builder, callbacks, or DB connection
- `src/frontend/hydrate.ts` — `hydrate()` function. Uses `__typename` to resolve model class from frontend registry, converts date columns to `Temporal.Instant`/`Temporal.PlainDate` using `TableDefinition.columns` type metadata, recursively hydrates nested associations
- `src/frontend/index.ts` — `baked-orm/frontend` entrypoint. Exports `FrontendModel`, `hydrate`, `registerModels`, plus re-exports of validation/error types
- Frontend models import `db/schema.ts` directly — no separate manifest needed. Column type info from `TableDefinition.columns` drives hydration type conversion
- `FrontendModel(tableDefinition)` mirrors `Model(tableDefinition)` API shape for consistency
- `registerModels(User, Post, ...)` must be called before `hydrate()` so the registry can resolve `__typename` to model classes. Models also auto-register on first instantiation

### Tests
- `tests/` — unit tests for pure functions, integration tests for migrations and ORM (CRUD, queries, associations, transactions, eager loading, nested eager loading, validations, callbacks, dirty tracking)

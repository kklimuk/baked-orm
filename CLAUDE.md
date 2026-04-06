# baked-orm

Database migration tool and ORM for Bun. PostgreSQL only via `Bun.sql`.

## Commands

- `bun run check` — runs biome, knip, and tsc
- `bun test` — runs unit and integration tests (requires local `baked_orm_test` database)
- `bun run format` — auto-fix biome issues
- `bun db <command>` — CLI entry point (requires `"db": "bake"` script alias)

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
- `create_<table>` — CREATE TABLE with id, created_at, updated_at + DROP TABLE
- `update_<table>` or `alter_<table>` — ALTER TABLE ADD COLUMN + DROP COLUMN
- `delete_<table>` or `drop_<table>` — DROP TABLE + CREATE TABLE stub
- No prefix — blank up/down template

IMPORTANT: always update CLAUDE.md and README.md before committing.

## Architecture

### Migration system
- `src/cli.ts` — CLI entry, parses commands via `util.parseArgs`
- `src/config.ts` — loads `baked.config.ts`, provides `getConnection()` for DB access
- `src/runner.ts` — migration discovery, advisory locking, transactional up/down execution, duplicate timestamp detection
- `src/introspect.ts` — queries `information_schema` + `pg_type` to generate typed `db/schema.ts` with camelCase properties and `columnName` mapping
- `src/commands/` — one file per CLI command (init, create, drop, generate, migrate, status)

### ORM layer
- `src/model/base.ts` — `Model()` mixin function. Returns a class extending the generated Row class with CRUD, query, association, validation, callback, and dirty tracking methods. Uses `this` in static methods for polymorphic subclass support. `save()` runs validation + callback lifecycle; `#performUpdate()` only sends dirty columns
- `src/model/query.ts` — immutable, chainable `QueryBuilder`. Uses parameterized queries via `executeQuery()` for SQL injection safety. Thenable via `then()`. Includes `findEach`/`findInBatches` for cursor-based batch processing
- `src/model/associations.ts` — `loadAssociation()` and `preloadAssociations()` for belongsTo, hasOne, hasMany, hasManyThrough, and polymorphic associations. Supports nested eager loading via dotted paths (`includes("posts.comments")`). Model registry maps class names to constructors for polymorphic resolution
- `src/model/validations.ts` — `validates()` factory for field-level rules (presence, length, numericality, format, inclusion, exclusion, email), `validate()` for record-level custom validators, `defineValidator()` registry for user-defined validators, `collectValidationErrors()` runner
- `src/model/callbacks.ts` — `runCallbacks()` discovers and executes lifecycle callback arrays from static properties on the model class
- `src/model/errors.ts` — `ValidationError` (thrown by `save()` on failure) and `ValidationErrors` (Rails-like Map-backed error collection with `add`, `get`, `fullMessages`, `fullMessagesFor`, `toJSON`)
- `src/model/connection.ts` — connection singleton wrapping existing config system. `AsyncLocalStorage` scopes transactions. Supports `onQuery` callback for query logging
- `src/model/utils.ts` — shared utilities: `quoteIdentifier`, `resolveColumnName`, `buildReverseColumnMap`, `mapRowToModel`, `hydrateInstance`, `executeQuery` (with logging), `buildConflictClause`
- `src/model/types.ts` — `ModelStatic<Row>`, `BaseModel`, `AnyModelStatic`, `AssociationDefinition`, `RecordNotFoundError`. Also exports branded association types (`HasManyDef`, `HasOneDef`, `BelongsToDef`, `HasManyThroughDef`) and standalone factory functions (`hasMany`, `hasOne`, `belongsTo`, `hasManyThrough`) for the `Model(table, associations)` API

### Association declaration patterns
- **Preferred (separate files):** `Model(table, { posts: hasMany(() => Post) })` — associations passed to `Model()`, types inferred via branded defs + `AssociationProperties` mapped type. No `declare` needed
- **Same-file circular refs:** `static posts = User.hasMany(() => Post)` + `declare posts: Post[]` — TypeScript can't resolve circular base expressions in the same file, so one side of a bidirectional relationship needs the static property + declare pattern

### Validation and callback patterns
- **Associations** stay in `Model()` for type inference: `Model(table, { posts: hasMany(() => Post) })`
- **Validations** are declared as static properties: `static validations = { name: validates("presence") }`
- **Callbacks** are declared as static arrays: `static beforeSave = [(record) => { ... }]`
- Built-in validators: `presence`, `length`, `numericality`, `format`, `inclusion`, `exclusion`, `email`
- Custom validators: `defineValidator("name", fn)` then `validates("name")`
- Record-level custom validations: `static customValidations = [validate((record) => { ... })]`
- All validators accept `message?`, `on?: "create" | "update"`, `if?: (record) => boolean`. `numericality` also supports `notANumberMessage?` and `notAnIntegerMessage?` for per-check messages
- Type-safe field names via `static validations = { ... } satisfies ValidationConfig<Row>`
- Callback lifecycle (save): beforeValidation -> validations -> afterValidation -> beforeSave -> beforeCreate/beforeUpdate -> SQL -> afterCreate/afterUpdate -> afterSave
- Callback lifecycle (destroy): beforeDestroy -> SQL -> afterDestroy
- Bulk operations (`createMany`, `upsertAll`, `updateAll`, `deleteAll`) skip validations and callbacks

### Dirty tracking
- Snapshot-based: after each load/save, a snapshot of column values is stored. `#performUpdate()` diffs current values against the snapshot and only sends dirty columns
- `changed(fieldName?)` — returns whether any (or a specific) field has been modified since last save/load
- `changedAttributes()` — returns `{ fieldName: { was, now } }` for all modified fields
- `save()` on a persisted record with no changes skips the UPDATE SQL entirely (callbacks still fire)
- Snapshot resets after `save()`, `reload()`, `markPersisted()` (called by `hydrateInstance`)

### Connection pool
- `DatabaseConfig` in `src/types.ts` accepts `max`, `idleTimeout`, `maxLifetime`, `connectionTimeout` — passed directly to `Bun.sql`

### Tests
- `tests/` — unit tests for pure functions, integration tests for migrations and ORM (CRUD, queries, associations, transactions, eager loading, nested eager loading, validations, callbacks, dirty tracking)

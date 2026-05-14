# Architecture

Internal design notes, invariants, and API references for baked-orm. Read this when you need depth beyond what `src/` reveals at a glance.

## CLI
- `src/cli.ts` — CLI entry with namespace routing. `bake db <command>` for migrations, `bake model <Name>` for model generation
- `src/commands/model.ts` — `runModel()` generates backend and frontend model files. Uses `toPascalCase` for class names, `toSnakeCase` for file/table names, infers table name by lowercasing + "s". Supports `--table`, `--backend`, `--frontend`, `--no-frontend`, `--no-backend` flags

## Migration system
- `src/config.ts` — loads `baked.config.ts`, provides `getConnection()` for DB access. `getConfiguredDatabaseName()` resolves a database name from `config.database` (string URL, `DatabaseConfig.database`, or `DatabaseConfig.url`), falling back to `POSTGRES_URL` / `DATABASE_URL` / `PGURL` / `PGDATABASE` env vars — used by `bake db create` / `bake db drop` to default the target db when no name is passed
- `src/commands/drop.ts` — when `bake db drop` runs without an explicit name (i.e. the name is resolved from config/env), it requires a type-to-confirm prompt before dropping. `--yes` / `-y` skips the prompt. Explicit `bake db drop <name>` does not prompt. Implemented with `readline.createInterface` so it works in both TTY and piped-stdin contexts (tests pipe the answer in via `Bun.spawn`)
- `src/runner.ts` — migration discovery, transaction-scoped advisory locking (`pg_advisory_xact_lock`), transactional up/down execution, duplicate timestamp detection
- `src/introspect.ts` — queries `information_schema` + `pg_type` to generate typed `db/schema.ts` with camelCase properties and `columnName` mapping. Introspects PostgreSQL enum types (`pg_enum`) and emits TypeScript string union types + `Values` const arrays in the schema. Enum columns use `udt_name` for type resolution when `data_type` is `USER-DEFINED`. Composite-type introspection joins `pg_class` and filters `relkind = 'c'` so the row composite that PostgreSQL auto-creates for every table is excluded — only standalone `CREATE TYPE ... AS (...)` composites are emitted as `XxxComposite` classes. `parseIndexColumns` walks balanced parens to extract the column list (so functional indexes like `(lower(name), coalesce(a, b))` split correctly on top-level commas only) and captures the partial-index `WHERE (...)` predicate into `IndexDefinition.where` instead of leaking it into the column list
- `src/commands/` — one file per CLI command (init, create, drop, generate, migrate, status)

## ORM layer
- `src/model/base.ts` — `Model()` factory function. Returns a class extending the generated Row class with CRUD, query, association, validation, callback, and dirty tracking methods. Uses `this` in static methods for polymorphic subclass support. `save()` runs validation + callback lifecycle; `#performUpdate()` only sends dirty columns. `assignAttributes()` sets multiple fields without saving (used by `update()` internally). `buildConflictSQL()` is a private helper that assembles `ON CONFLICT` SQL fragments from a `ConflictOption`, used by `upsert`, `upsertAll`, `createMany`, and `create`. `findBySql(sqlText, values?)` executes raw SQL and returns hydrated model instances with full ORM features (dirty tracking, save, etc.). Calls `applyModelPlugins(ModelBase)` at the end of the factory to wire in plugin instance/static methods
- `src/model/query.ts` — immutable, chainable `QueryBuilder`. Uses `_` prefix convention (protected, not `#private`) so plugins can access internal state. Core SQL rendering (`_buildSql`, `_renderSelect`, `_appendWhere`) is kept minimal — features like locking, CTE wrapping, batch iteration are added by plugins that wrap these methods. `_extensions: Record<string, unknown>` is a plugin state bag, automatically shallow-copied by `_clone()`. `where()` delegates to `compileConditions` in `where.ts` for operator/grouping support. `toArray()` delegates to `_executeAndHydrate(text, values)` so the eager-load windowed path can reuse the same hydration + nested-preload pipeline
- `src/model/where.ts` — pure compiler for `where()` conditions. Exports `WhereConditions<Row>`, `WhereValue<T>`, `WhereOperator<T>` types and the `compileConditions(conditions, columns, startParamIndex)` function that produces `{fragment, values, columnNames}[]` clauses joined by AND. Handles scalar equality, `null` → `IS NULL`, arrays → `IN`, operator objects (`{op, value}`), and nested `or`/`and` groupings
- `src/common/query.ts` — shared types and utilities between query.ts and plugins: `WhereClause`, `OrderClause`, `Projection`, `RenderOptions`, `renumberParameters()`. Also exports `assertNoRecursiveCte()` guard used by multiple plugins
- `src/model/associations.ts` — public dispatch + tree walking. Exports `loadAssociation()` (lazy, single instance) and `preloadAssociations()` (eager, batched). Holds `preloadAssociationTree`, `preloadSingleAssociation`, `parseIncludesPaths`, `collectLoadedRecords`, `MAX_EAGER_DEPTH`. The two switch statements dispatch to per-type files
- `src/model/associations/` — one file per association type, each with its lazy + eager implementation colocated:
  - `belongs-to.ts` — `loadBelongsTo`, `loadPolymorphicBelongsTo`, `preloadBelongsTo`, `preloadPolymorphicBelongsTo`
  - `has-one.ts` — `loadHasOne`, `preloadHasOne`
  - `has-many.ts` — `loadHasMany`, `preloadHasMany`
  - `has-many-through.ts` — `loadHasManyThrough`, `preloadHasManyThrough`
  - `shared.ts` — internal helpers (`buildTargetQuery`, `applyScope`, `resolveScope`, `ensureDeterministicOrder`, `executeAssociationQuery`, `findAssociationDefinition`, `resolveModel`, `inferForeignKey`)
- Both eager and lazy loaders go through `QueryBuilder` (`targetModel.where({ fk: parentIds })`) so `defaultScope` builders (`q => q.kept().order(...)`) compose with plugin helpers automatically. The eager loader uses a `ROW_NUMBER() OVER (PARTITION BY <fk>)` rewrite via `QueryBuilder._buildWindowedSql` when a scope sets `_limitValue` / `_offsetValue`, so per-parent limits are correct across batched queries. Supports nested eager loading via dotted paths (`includes("posts.comments")`). Model registry maps class names to constructors for polymorphic resolution
- `src/model/validations.ts` — `validates()` factory for field-level rules (presence, length, numericality, format, inclusion, exclusion, email), `validate()` for record-level custom validators, `defineValidator()` registry for user-defined validators, `collectValidationErrors()` runner. Enum columns with `enumValues` in their `ColumnDefinition` are auto-validated without explicit `validates("inclusion")` — invalid values produce `"is not a valid value (must be one of: ...)"` errors
- `src/model/callbacks.ts` — `runCallbacks()` discovers and executes lifecycle callback arrays from static properties on the model class
- `src/model/errors.ts` — `ValidationError` (thrown by `save()` on failure) and `ValidationErrors` (Rails-like Map-backed error collection with `add`, `get`, `fullMessages`, `fullMessagesFor`, `toJSON`)
- `src/model/connection.ts` — connection singleton wrapping existing config system. `AsyncLocalStorage` scopes transactions. `isInTransaction()` detects whether code is running inside a transaction. `transaction()` accepts an optional `TransactionOptions` first argument for isolation levels (`"read committed"`, `"repeatable read"`, `"serializable"`). Nested `transaction()` calls automatically use PostgreSQL savepoints (`SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT`) — inner rollback does not affect the outer transaction. Isolation levels on nested transactions throw (PostgreSQL limitation). Supports `onQuery` callback for query logging. `query<T>(sqlText, values?)` executes raw SQL and returns typed plain objects (no model hydration) — for aggregates, groupings, and cross-table queries
- `src/model/utils.ts` — shared utilities: `quoteIdentifier`, `resolveColumnName`, `buildReverseColumnMap`, `mapRowToModel`, `hydrateInstance`, `executeQuery` (with logging + sensitive column redaction), `buildConflictClause`, `buildSensitiveColumns`
- `src/model/types.ts` — `ModelStatic<Row>`, `BaseModel`, `AnyModelStatic`, `AssociationDefinition`, `RecordNotFoundError`, `LockMode`, `IsolationLevel`, `TransactionOptions`, `ConflictTarget`, `ConflictOption`, `InsertOptions`. Also exports branded association types (`HasManyDef`, `HasOneDef`, `BelongsToDef`, `HasManyThroughDef`) and standalone factory functions (`hasMany`, `hasOne`, `belongsTo`, `hasManyThrough`) for the `Model(table, associations)` API. Factory functions accept either string model names (resolved from registry) or thunks (`() => Model`); string overloads take an explicit generic for type inference: `hasMany<Post>("Post")`

## Plugin system
- `src/plugins/index.ts` — `definePlugin()` registry. `ModelPlugin` interface has `instance`, `static`, `queryBuilder`, and `virtuals` method bags. `queryBuilder` methods are patched onto `QueryBuilder.prototype` immediately in `definePlugin()`. `instance`/`static` methods are stored and applied per-model by `applyModelPlugins()`, called at end of `Model()` factory. `virtuals(modelClass) => Record<name, { get, set? }>` is called LAZILY from the ModelBase constructor on the first instance of each user subclass — by that point `modelClass` is the user's actual subclass (so per-model gating like `if (!modelClass.softDelete) return {}` works against user-declared statics). Plugin-contributed virtuals are defined as accessors on the user subclass prototype and registered in a `WeakMap<modelClass, Set<name>>` consulted by `getComputedVirtuals`. Two plugins contributing the same name throws on first instantiation; user-declared properties on the subclass prototype silently win over plugin contributions; column / association name conflicts are silently ignored. Use `instance:` for callable-but-not-serialized; use `virtuals:` for serialized-and-readable
- `src/plugins/soft-delete.ts` — soft delete plugin. Adds `discard()`, `undiscard()`, `isDiscarded`, `isKept` to instances; `kept()`, `discarded()` to statics; `kept()`, `discarded()`, `discardAll()`, `undiscardAll()` to QueryBuilder (so chains and association `defaultScope` builders can use them). Types via declaration merging on `BaseModel`, `ModelStatic`, `QueryBuilder`
- `src/plugins/recursive-cte.ts` — recursive CTE plugin. Adds `recursiveOn()`, `descendants()`, `ancestors()` to QueryBuilder. Wraps `_buildSql` to inject `WITH RECURSIVE` wrapper. Stores CTE state in `_extensions.recursiveCte`. Also wraps `updateAll`/`deleteAll` to guard against recursive scope usage. Includes pure helpers merged from former `src/model/recursive.ts`: `requalifyFragment`, `buildKnownColumnNames`
- `src/plugins/locking.ts` — pessimistic locking plugin. Adds `lock()` to QueryBuilder (sets `_extensions.lockClause` via `_clone`), wraps `_renderSelect` to append lock clause, wraps `toArray` to assert transaction state. Adds instance `lock()` and `withLock()` methods
- `src/plugins/batch-iteration.ts` — batch processing plugin. Adds `findEach()` and `findInBatches()` as async iterators on QueryBuilder. Accepts `{ batchSize?, order? }` options — `order` overrides the default PK ascending cursor with custom column + direction (cursor comparison flips automatically for DESC). Composes public QueryBuilder API only (simplest plugin example)
- `src/plugins/aggregates.ts` — aggregations plugin. Adds `sum`, `avg`, `min`, `max`, `group`, `havingRaw`, `aggregate({...})` to both QueryBuilder and Model statics; wraps `count()` to dispatch to grouped form when `group()` is active; wraps `_renderSelect` to render aggregate SELECT (group-by + having) when `_extensions.aggregates` or transient `_extensions.aggregateTerminal` is set; wraps `[SUBQUERY]` to throw on aggregate-active builders. Plugin is fully self-contained — no changes to core `Projection` union, `_renderSelect`, or `Model`/`base.ts`. See "Aggregations" section below for the API
- Built-in plugins self-register via side-effect imports in `src/index.ts`
- User-authored plugins use the same `definePlugin()` API and declaration merging pattern. See `src/plugins/README.md` for the authoring guide

## Association declaration patterns
- **Preferred (separate files):** `Model(table, { posts: hasMany<Post>("Post") })` with `import type { Post }` — string-based model refs resolve from the registry at runtime, `import type` avoids circular imports, branded defs + `AssociationProperties` mapped type infer instance types automatically
- **Same-file (no circular imports):** `Model(table, { posts: hasMany(() => Post) })` — thunk-based refs work when both models are in the same file or there are no circular dependencies. TypeScript infers the target type from the thunk
- **Same-file circular refs:** `static posts = User.hasMany(() => Post)` + `declare posts: Post[]` — TypeScript can't resolve circular base expressions in the same file, so one side of a bidirectional relationship needs the static property + declare pattern

## Scoped associations (defaultScope)
- `hasMany`, `hasOne`, `hasManyThrough`, `belongsTo`, and polymorphic `belongsTo` accept an optional `defaultScope: (query) => QueryBuilder` builder. Applied during eager loading (`includes()`) and lazy loading (`load()`). Composes with plugin-level helpers: `defaultScope: q => q.kept().order({ createdAt: "ASC" })` filters discarded rows AND orders the result without forcing callers to know the soft-delete column name
- `hasManyThrough` additionally accepts `defaultThroughScope` for filtering the join table independently. The eager loader runs two queries (through + target) instead of an INNER JOIN so each scope routes through `QueryBuilder` and plugins
- The eager loader replaces the previous raw-SQL preloader for all kinds — `preloadSingleAssociation` builds via `targetModel.where({ fk: parentIds })` and applies the scope before executing
- **Limit/offset semantics:** when `defaultScope` calls `.limit(N)` or `.offset(N)`, the eager loader rewrites the batched query as `ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY <scope_order>)` filtered by `rn > offset AND rn <= offset+limit` so the limit applies per-parent (not total across all parents). Lazy loaders use limit normally because the query is already per-parent. The `_buildWindowedSql(partitionColumn)` helper on `QueryBuilder` produces this SQL; the outer SELECT carries `ORDER BY <fk>, __baked_rn` so per-parent rows stay grouped and in row_number order. The eager-load helper in `associations.ts` runs both windowed and non-windowed branches through `QueryBuilder._executeAndHydrate` so any future post-fetch behavior in `toArray()` applies uniformly
- **Deterministic hasOne pick:** the eager and lazy `hasOne` paths fall back to `ORDER BY <pk> ASC` when the scope hasn't declared an order, so the "first row per parent" pick is stable instead of relying on PostgreSQL row order
- **Polymorphic scopes:** must be target-agnostic (the scope runs against whichever target type matches). The scope receives the resolved target model class as a second argument: `(query, target) => target.softDelete ? query.kept() : query`. Branch on `target` when some targets aren't soft-delete-enabled (or otherwise differ in the columns/plugins available)
- **Per-call overrides:** `.includes(path, { scope: false })` bypasses the declared `defaultScope` for that association on this query; `.includes(path, { scope: (q, target) => ... })` replaces it. The override applies only to the **top-level** association (path's first segment) — nested levels still use their declared scopes. To override a nested level, declare a second association without the scope. Override storage lives on `QueryBuilder._includeOverrides: Map<string, false | AssociationScope>` and is passed through `preloadAssociations` → `preloadAssociationTree` → `preloadSingleAssociation`. `resolveScope(declared, override)` in `associations.ts` collapses the two into the effective scope for each branch
- `kept()` and `discarded()` are also exposed as `QueryBuilder` methods (not just `Model` statics) so scopes and arbitrary chains can use them. They throw if `softDelete` isn't enabled on the model

## Enum support
- PostgreSQL `CREATE TYPE ... AS ENUM` types are introspected from `pg_enum` and emitted in `db/schema.ts` as TypeScript string union types (`type Status = "active" | "inactive"`) plus runtime const arrays (`const StatusValues = ["active", "inactive"] as const`)
- `ColumnDefinition` has optional `enumValues?: readonly string[]` — populated automatically for enum columns in the generated schema, referencing the `Values` const
- Enum columns are auto-validated: `collectValidationErrors()` checks `enumValues` on column definitions, so models get enum validation for free without explicit `validates("inclusion")`
- Migration template: `create_enum_<name>` scaffolds `CREATE TYPE <name> AS ENUM (...)` + `DROP TYPE <name>`
- `mapPgType()` accepts an optional `enumNames` set — when a type name matches, it maps to the PascalCase TypeScript type name

## where() operators and grouping
- `where()` accepts three value forms per column: a scalar (equality, `null` → `IS NULL`), an array (`IN (...)`, `[]` → `FALSE`), or an operator record `{ eq, ne, gt, gte, lt, lte, in, not_in, like, ilike, contains, starts_with, ends_with }`. Multiple operators on the same column AND together: `where({ age: { gte: 18, lte: 65 } })` → `"age" >= $1 AND "age" <= $2`
- Range operators (`gt`/`gte`/`lt`/`lte`) and string operators (`like`/`ilike`/`contains`/`starts_with`/`ends_with`) are statically constrained by column type — `where({ active: { ilike: "x" } })` fails to typecheck on a boolean column
- `{ eq: null }` / `{ ne: null }` produce `IS NULL` / `IS NOT NULL`. Empty `{ in: [] }` → `FALSE`; empty `{ not_in: [] }` → `TRUE`. `contains`/`starts_with`/`ends_with` are sugar that wrap the value with `%` before binding (always case-sensitive — use `ilike` directly with explicit wildcards for case-insensitive)
- Nested grouping via `or:` / `and:` keys: `where({ or: [{ name: "a" }, { name: "b" }] })`. Multi-key children inside a group AND together (and get inner parens). Empty `or: []` → `FALSE`, empty `and: []` → `TRUE`. Limitation: a column literally named `or` or `and` collides with the grouping keys — fall back to `whereRaw` in that edge case
- JSON/JSONB columns: an object value is always treated as a literal (never an operator record), so `where({ metadata: { eq: 5 } })` on a JSON column inserts that object as the bound value
- Timestamp precision clamping: equality operators (`=`, `!=`, `IN`, `NOT IN`) on `timestamptz`/`timestamp` columns wrap the column in `date_trunc('milliseconds', col)` so JS `Date` values (millisecond precision) round-trip correctly against PostgreSQL's microsecond storage. Range operators use the bare column for index-friendliness
- Recursive CTE compatibility: `or`/`and` groups expose the union of their referenced columns to the recursive-step propagation logic. If any referenced column is a join column, the entire group is excluded from the step (conservative — same as a single clause referencing a join column). Groups containing `whereRaw` clauses are treated as opaque (always propagate)
- Subquery support: a `QueryBuilder` can be passed as a `where()` value or as the `in`/`not_in` operand, emitting `col IN (SELECT ...)` / `col NOT IN (SELECT ...)`. Detection uses the `SUBQUERY` symbol (`Symbol.for("baked-orm.subquery")`) exported from `where.ts`; `QueryBuilder` implements a `get [SUBQUERY]()` getter that returns `{ sql, values }`. Without `.select()`, defaults to the PK; with `.select(col)`, projects that column; multi-column `.select()` throws. Subquery params are renumbered via `renumberParameters` to avoid collision with the outer query. Timestamp clamping is skipped for subquery values (both sides are DB-precision). Recursive CTE scopes throw when used as subqueries (PostgreSQL disallows `WITH` inside `IN (...)` — use `pluck()` to materialize first)

## Pluck and distinct
- `QueryBuilder.pluck("col")` returns `Promise<Row["col"][]>` — raw column values, no model hydration. Composes with `where`, `order`, `limit`, `distinct`, and the recursive CTE wrapper
- Multi-column form: `QueryBuilder.pluck("col1", "col2")` returns `Promise<[Row["col1"], Row["col2"]][]>`
- `QueryBuilder.distinct()` emits `SELECT DISTINCT`. Composes with `pluck` and `toArray`
- Internally `pluck`/`count`/`exists`/`toSQL` all share `_buildSql(projection)`, parameterized by a projection mode (`default` / `columns` / `count` / `exists`). The recursive-cte plugin wraps `_buildSql` to add the CTE wrapper transparently when `_extensions.recursiveCte` is set

## Recursive tree traversal
- `QueryBuilder.descendants({ via })` and `QueryBuilder.ancestors({ via })` walk a self-referential edge via `WITH RECURSIVE`. The current scope's predicates seed the anchor; the same predicates propagate to every recursive level *except* clauses that filter on the join columns themselves (those would prune the walk to the seed)
- Generic primitive: `QueryBuilder.recursiveOn({ from, to, setSemantics? })`. Each recursive step joins `child.<from> = parent.<to>`. `descendants({ via })` is sugar for `recursiveOn({ from: via, to: <pk> })`; `ancestors({ via })` is sugar for `recursiveOn({ from: <pk>, to: via })`
- **Cycle safety:** defaults to `UNION` (set semantics) so cycles terminate naturally. Pass `setSemantics: false` for `UNION ALL` if you can guarantee acyclicity
- **Scope-snapshot semantics:** predicates added *before* `recursiveOn`/`descendants`/`ancestors` bake into the CTE (anchor + step). Predicates added *after* apply to the outer `SELECT * FROM __traversal` only — so `Page.where({ id: root }).descendants({ via: "parentId" }).where({ title: "foo" }).count()` walks all descendants and then filters by title, rather than pruning the walk
- **`whereRaw` propagation:** `whereRaw` clauses (used by `kept()`) are opaque to the column tracker and always propagate to the recursive step — so `Page.kept().descendants(...)` correctly excludes discarded rows AND blocks subtree traversal through them
- **v1 limitations:** seed scope cannot have `order/limit/offset` (throws — apply ordering after the recursive scope), no nested `recursiveOn`, no `joins()` on the seed scope, single-column primary key required for `descendants`/`ancestors` sugar, `updateAll`/`deleteAll`/`discardAll`/`undiscardAll` throw on a recursive scope
- Composes with everything that comes after: `.where`, `.order`, `.limit`, `.toArray`, `.pluck`, `.count`, `.distinct`, `.includes`

## Pessimistic locking
- Implemented as a plugin in `src/plugins/locking.ts`. Lock clause stored in `_extensions.lockClause`, rendered by wrapping `_renderSelect`. Transaction assertion by wrapping `toArray`
- `QueryBuilder.lock(mode?)` appends a PostgreSQL lock clause (`FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`) to SELECT queries. Defaults to `FOR UPDATE`. Supports `NOWAIT` and `SKIP LOCKED` suffixes via string passthrough
- Lock clause is appended after LIMIT/OFFSET in the rendered SQL. Only applied to `default` and `columns` projection kinds — silently ignored on `count()`, `exists()`
- `lock()` on a recursive CTE scope throws — PostgreSQL does not allow `FOR UPDATE` on CTEs
- Executing a locked query outside a transaction throws — a lock without a transaction boundary releases immediately, which is a bug, not a feature. Detection via `isInTransaction()` in `connection.ts`
- Instance `lock(mode?)` method re-SELECTs the record with the lock clause, refreshes all in-memory attributes, and resets the snapshot. Similar to `reload()` but with a lock. Throws if not persisted or not in a transaction
- Instance `withLock(callback, mode?)` convenience wraps in `transaction()`, calls `this.lock(mode)`, then runs the callback with `this`. Returns the callback's return value. Rolls back on error
- `LockMode` type union exported from `types.ts` covers all four PostgreSQL lock strengths × {bare, NOWAIT, SKIP LOCKED}
- `isInTransaction()` exported from `connection.ts` and `src/index.ts` — returns `true` when inside a `transaction()` block

## Aggregations
- Implemented as a plugin in `src/plugins/aggregates.ts`. Exposes Rails-style "calculations" — `count`, `sum`, `avg`, `min`, `max` — plus `group(...cols)`, `havingRaw(fragment, values?)`, and an `aggregate({ alias: sqlFragment })` escape hatch on the grouped builder for non-standard aggregates (`array_agg`, `string_agg`, etc.)
- Available as both Model statics and QueryBuilder methods: `User.sum("balance")` and `User.where(...).sum("balance")` both work; `User.group("status").count()` uses the static-then-chain pattern. Statics proxy through `this.all().<method>` (mirrors existing `static count()` / `static exists()` precedent)
- Scalar (no `group()` upstream): `sum/avg/min/max` return `Promise<number | null>` (or `Promise<Row[K] | null>` for `min/max`); `null` matches Postgres aggregate semantics for empty sets. `count()` keeps its existing `Promise<number>` (returning `0` for empty sets) for backwards compatibility
- Grouped: terminals return `Promise<Array<{ ...groupCols, fn }>>` (array-of-objects form) — matches Drizzle and Prisma conventions, and avoids the JS `Map` reference-equality footgun for multi-column tuple keys. Multi-column groups: `User.group("status", "role").count()` → `Array<{ status, role, count }>`. `null` group keys are surfaced as-is
- TypeScript: `group()` returns a `GroupedQueryBuilder<Row, GroupCols>` interface (a structural view; runtime is the same QueryBuilder instance). `GroupedQueryBuilder` has narrowed terminal signatures (returning arrays) plus chainable `where/whereRaw/havingRaw/order/limit/offset` that re-thread through itself. Declared via `declare module` merging on `QueryBuilder` and `ModelStatic`
- State storage: `_extensions.aggregates: { groupColumns: string[]; havingClauses: WhereClause[] }` — set by `group()` / `havingRaw()`, propagated through `_clone()` shallow merge. Transient `_extensions.aggregateTerminal: { kind: "fn", fn, column } | { kind: "raw", expressions }` — set by terminal methods on a one-shot clone before SQL build, never persisted
- SQL rendering: plugin wraps `QueryBuilder.prototype._renderSelect` (locking-plugin pattern). When aggregate state is active, `renderAggregateSelect` builds the entire SELECT itself using `this._appendWhere`, `this._whereClauses`, `this._orderClauses`, `this._limitValue`, `this._offsetValue` — re-implementing ORDER BY / LIMIT / OFFSET inline. When inactive, passes through to the original. Zero core changes: `Projection` union and core `_renderSelect` switch are untouched
- Composition with recursive CTE: works for free. Recursive-cte's `_buildSql` wrap calls `this._renderSelect(projection, { fromClause: "__traversal" })` for the outer query; aggregates' `_renderSelect` wrap intercepts and renders the aggregate SELECT against `__traversal`. Both plugins remain ignorant of each other
- HAVING parameter offsetting: `havingRaw` clauses store fragments verbatim with their own `$N` numbering; at render time `renumberParameters()` shifts them by `paramOffset + values.length` so HAVING params land after WHERE params in the final SQL
- Aggregate value coercion: `sum`/`avg`/`count` always coerce results to `Number` (Postgres returns `numeric` and large `int8` aggregates as strings). `min`/`max` coerce only when the source column type is in `NUMERIC_PG_TYPES` — for non-numeric columns (dates, strings) the value is returned as-is to preserve type
- Composition guards (thrown at terminal-method invocation, not at chain build, so error messages reference the conflicting method name):
  - `group()` + `lock()` → throws (Postgres rejects `FOR UPDATE` on aggregate queries)
  - `group()` + `distinct()` → throws (ambiguous semantics; combine `COUNT(DISTINCT col)` via `aggregate({...})` instead)
  - `group()` + `includes()` → throws (eager loading on aggregated rows is meaningless)
  - `sum`/`avg` on a non-numeric column → throws with column name + type (runtime check via `NUMERIC_PG_TYPES` set; covers `int2/4/8`, `float4/8`, `numeric`, `decimal`, `money` and their longform aliases)
  - `havingRaw` without `group()` → throws (Postgres rejects HAVING without GROUP BY)
  - `aggregate({...})` without `group()` → throws (v1 only supports the grouped form; scalar form is v2)
  - Aggregate-active QueryBuilder used as a `where()` subquery operand → throws via the wrapped `[SUBQUERY]` getter (projection conflict with the SUBQUERY symbol's PK-default contract). Workaround: materialize with `await` then use the value, or use `pluck()` on a non-aggregate variant
- v2 candidates (deliberately not in v1): structured `having({ count: { gt: 5 } })` — needs a having-condition compiler distinct from `compileConditions`; multi-aggregate-per-query terminal (`pluck(count(), sum(col))`) — needs an aggregate-expression DSL; scalar-form `aggregate({...})` returning a single row (would also unlock ad-hoc window-function expressions like `aggregate({ rank: "ROW_NUMBER() OVER (...)" })`); scalar-subquery emission (`Model.where({ balance: { gt: User.avg("balance") } })` compiling to one round-trip — current workaround is materialize-then-use); static numeric-column type narrowing for `sum`/`avg`

## Conflict options (upsert / insert-or-skip)
- All insert methods (`create`, `createMany`, `upsert`, `upsertAll`) accept a unified `conflict` option via `InsertOptions<Row>`
- `ConflictTarget<Row>` specifies how to identify conflicts — column-based (`{ columns: ["email"] }`) or named constraint (`{ constraint: "uq_name" }`). Column-based targets optionally accept `where` for partial unique index matching. Named constraints do NOT support `where` (PostgreSQL syntax limitation)
- `ConflictOption<Row>` is either `"ignore"` (untargeted `ON CONFLICT DO NOTHING`) or a `ConflictTarget` with optional `action: "update" | "ignore"`
- Default action depends on the method: `upsert`/`upsertAll` default to `"update"` (DO UPDATE), `create`/`createMany` default to `"ignore"` (DO NOTHING). Explicit `action` on the conflict target overrides the default
- `conflict.where` reuses `compileConditions` from `where.ts`. Parameters are numbered after the row values (`$N+1..`) to avoid collision
- `buildConflictClause` in `utils.ts` handles column resolution and update-set generation. For named constraints, ALL inserted columns are included in the update set (no exclusion filter). For column-based conflicts, conflict columns are excluded from the update set. When update set is empty (all inserted columns are conflict columns), falls back to a no-op SET on the first column
- `create` with `conflict` stores the option on a private `#conflictOption` field, read and cleared by `#performInsert`. If `DO NOTHING` triggers and `RETURNING *` returns no rows, the instance stays un-persisted (`isNewRecord` remains true)
- `createMany`/`upsertAll` with `DO NOTHING` return only actually inserted rows — the returned array may be shorter than input

## Soft deletes (discard pattern)
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

## Timestamps
- `create_<table>` migration template includes a shared `set_updated_at()` PostgreSQL trigger function (idempotent via `CREATE OR REPLACE`) and a per-table `trg_<table>_updated_at` trigger that auto-sets `updated_at = now()` on every UPDATE
- The trigger function is NOT dropped in migration `down` since other tables may reference it

## Validation and callback patterns
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

## Serialization
- `src/model/serializer.ts` — `serialize()` function produces JSON-ready objects with `__typename` (GraphQL-style type discriminator). Supports `only`/`except` column filtering, `sensitiveFields` (always excluded), nested `include` for associations (string[] shorthand or per-association options), and `methods` for ad-hoc instance-method serialization (Rails `as_json(methods:)` equivalent)
- `__typename` resolution: reads `static typename` if present (set by frontend `registerModels`), falls back to `instance.constructor.name`. The same `serialize()` function powers both backend `Model.toJSON()` and frontend `FrontendModel.toJSON()`
- `toJSON()` delegates to `serialize()` without options — includes `__typename` + all non-sensitive columns + auto-detected virtuals
- `serialize({ include: ["posts.comments"], except: ["passwordDigest"], methods: ["computeBadge"] })` for explicit control
- `sensitiveFields` also redacts values in query logs — `executeQuery` accepts per-query `sensitiveColumns: Set<string>` (DB column names) and parses the SQL to match `$N` parameters to column names, redacting matches with `[REDACTED]`. Covers INSERT, UPDATE SET, WHERE, and batch operations. Per-model scoping via `buildSensitiveColumns()` with WeakMap caching — no global state

## Virtual attributes (auto-detected)
- `src/model/virtuals.ts` — `getComputedVirtuals(modelClass)` (cached per-class) returns the set of getter names defined directly on the user's subclass prototype (minus columns, associations, underscore-prefixed names) unioned with plugin-contributed virtual names from the plugin registry (user names win on conflict). `isSettableVirtual(name, modelClass)` is the per-serialize check used to filter own-properties (uncached because SQL aliases / ad-hoc assignments are dynamic). Both helpers derive `columns` from `modelClass.tableDefinition.columns` internally — no `columns` parameter passed in
- Two flavors of virtual, both auto-detected with no registry, names list, or `as const satisfies` boilerplate:
  - **Computed virtual**: a class getter on the user's subclass — `get fullName() { return ${this.firstName} ${this.lastName} }`. Always called and serialized
  - **Settable virtual**: a class field with a default value — `following: boolean | null = null`. Default appears in JSON; SQL aliases (`SELECT EXISTS(...) AS following`), `findBySql` results, and ad-hoc `instance.following = true` assignments overwrite the default and serialize accordingly
- Detection rules: walks ONLY the user's subclass prototype (not ancestors), so plugin-added getters like `isDiscarded` / `isKept` are naturally excluded. Skips names starting with `_` (private convention), `constructor`, columns, and associations (any static on the class with an `associationType` property)
- v1 limitation: virtual getters declared on a parent user class (e.g. `class Admin extends User extends Model(...)` where `User` declares `get fullName()`) are NOT detected for the derived class. The walk stops at the user's own prototype to avoid pulling in plugin-added getters from the Model factory's inner class. Workaround: redeclare the getter on the derived class, or compose the shared logic as a method called from each class's getter
- Snapshot dirty tracking already iterates only known columns from `tableDefinition.columns`, so virtuals never participate in dirty tracking, UPDATE SQL, or `changedAttributes()`. Virtuals are serialize-only and never persisted
- `serialize()`'s `only` / `except` / `sensitiveFields` filters apply uniformly to virtuals — `serialize({ only: ["id", "fullName"] })` works as expected
- `serialize({ methods: ["computeBadge"] })` is the Rails `as_json(methods:)` escape hatch — calls the named instance methods and includes the return value keyed by the method name. Useful for one-off serialization without declaring the field as a virtual

## Dirty tracking
- `src/model/snapshot.ts` — `Snapshot` class encapsulates snapshot-based dirty tracking. Shared between backend `Model` and frontend `FrontendModel`
- `Snapshot` methods: `capture(instance)`, `changed(instance, fieldName?)`, `changedAttributes(instance)`, `dirtyEntries(instance)`
- Both `ModelBase` and `FrontendBase` own a private `#snapshot: Snapshot` and delegate to it
- `save()` on a persisted record with no changes skips the UPDATE SQL entirely (callbacks still fire)
- Snapshot resets after `save()`, `reload()`, `markPersisted()` (called by `hydrateInstance`)
- JSON/JSONB columns use deep dirty tracking: `capture()` stores `structuredClone(value)` for JSON columns, `changed()` and `dirtyEntries()` use `Bun.deepEquals()` instead of `!==`. This detects in-place mutations like `user.metadata.theme = "dark"`. Non-JSON columns still use reference equality
- JSON column detection is automatic from `ColumnDefinition.type` (`"json"` or `"jsonb"`), computed once in the `Snapshot` constructor
- Users narrow `unknown` JSON column types via `declare` on their model subclass: `declare settings: UserSettings`

## Connection pool
- `DatabaseConfig` in `src/types.ts` accepts `max`, `idleTimeout`, `maxLifetime`, `connectionTimeout` — passed directly to `Bun.sql`

## Frontend model layer
- `src/frontend/model.ts` — `FrontendModel()` factory. Returns a class with dirty tracking (via `Snapshot`), validations (reuses `collectValidationErrors`), and `toJSON()` — but no CRUD, query builder, callbacks, or DB connection
- `src/frontend/hydrate.ts` — `hydrate()` function. Uses `__typename` to resolve model class from frontend registry, converts date columns to `Temporal.Instant`/`Temporal.PlainDate` using `TableDefinition.columns` type metadata, recursively hydrates nested associations, and passes through plain non-association JSON keys onto the instance (so virtual attributes carried in the payload land on the hydrated frontend model)
- `src/frontend/index.ts` — `baked-orm/frontend` entrypoint. Exports `FrontendModel`, `hydrate`, `registerModels`, plus re-exports of validation/error types
- Frontend models import `db/schema.ts` directly — no separate manifest needed. Column type info from `TableDefinition.columns` drives hydration type conversion
- `FrontendModel(tableDefinition)` mirrors `Model(tableDefinition)` API shape for consistency
- `registerModels({ User, Post, ... })` must be called before `hydrate()` so the registry can resolve `__typename` to model classes. Registration is explicit (no auto-register on instantiation) — the object key becomes the class's static `typename`, which drives `toJSON().__typename`. Object keys survive JavaScript minification (unlike `class.name` under `minify.identifiers`), so bundles stay correct. `src/frontend/typename.ts` exports `defineTypename(cls, name)` used by `registerModels`; `serialize()` itself reads `static typename` directly when building `__typename`, falling back to `constructor.name`. Only the frontend needs the explicit registration — the server runs unminified in typical Bun deployments and continues to rely on `constructor.name` for the server-side registry and polymorphic `_type` lookups

## Tests
- Test directory mirrors `src/` structure: `tests/model/`, `tests/plugins/`, `tests/commands/`, `tests/frontend/`
- `tests/` (root) — CLI, config, runner, introspect, and migration integration tests
- `tests/model/` — query builder, validations, serializer, virtuals, redaction, conflict, subquery, and base model integration tests
- `tests/plugins/` — recursive CTE, locking, soft delete, aggregates plugin tests
- `tests/commands/` — model generator, migration generator tests
- `tests/frontend/` — frontend model, hydration, registry tests
- `tests/helpers/` — shared test utilities (postgres setup). `setup.ts` is preloaded by `bunfig.toml` to register all built-in plugins for tests that import directly from `src/model/` (bypassing `src/index.ts`). New plugins must be added here

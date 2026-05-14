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
- Top-down file ordering: exports and entry points go first, followed by their direct dependencies, followed by their dependencies, and so on. A reader should encounter the "what" before the "how" — like a newspaper. Use `function` declarations (hoisted) over `const` arrow functions for internal helpers so this ordering works at runtime

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

IMPORTANT: YOU MUST update CLAUDE.md, ARCHITECTURE.md, and README.md before ending a session or committing. Capture any new invariants, file moves, API additions, or design decisions made this session. Stale docs are worse than no docs: they actively mislead the next session.

## Architecture map

- CLI entry: `src/cli.ts` (namespace routing for `bake db` / `bake model`)
- Migration system: `src/runner.ts`, `src/introspect.ts`, `src/commands/`
- ORM core: `src/model/` (`base.ts`, `query.ts`, `where.ts`, `associations/`, `serializer.ts`, `virtuals.ts`, `snapshot.ts`)
- Plugins: `src/plugins/` (soft-delete, recursive-cte, locking, batch-iteration, aggregates)
- Frontend layer: `src/frontend/` (FrontendModel, hydrate, typename registry)
- Tests mirror `src/` under `tests/`; `tests/helpers/setup.ts` preloads built-in plugins for tests that import directly from `src/model/`

For design decisions, invariants, plugin internals, and API details (where-operators, aggregations, recursive CTE, locking, soft delete, virtuals, serialization, conflict options), read @ARCHITECTURE.md.

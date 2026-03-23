# baked-orm

Database migration tool for Bun. PostgreSQL only via `Bun.sql`.

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

## Tooling

- **Biome** for linting and formatting. `useNodejsImportProtocol` rule is disabled
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

- `src/cli.ts` — CLI entry, parses commands via `util.parseArgs`
- `src/config.ts` — loads `baked.config.ts`, provides `getConnection()` for DB access
- `src/runner.ts` — migration discovery, advisory locking, transactional up/down execution
- `src/introspect.ts` — queries `information_schema` + `pg_type` to generate typed `db/schema.ts`
- `src/commands/` — one file per CLI command (init, create, drop, generate, migrate, status)
- `tests/` — unit tests for pure functions, CLI integration tests via subprocess spawning

# baked-orm Plugins

Plugins extend Model instances, Model classes (statics), and/or QueryBuilder with new methods. Built-in plugins (soft-delete, locking, recursive-cte, batch-iteration) use the exact same API described here.

## `definePlugin()`

```typescript
import { definePlugin } from "baked-orm";

definePlugin({
  name: "myPlugin",
  // Instance methods added to every model prototype
  instance: { ... },
  // Static methods added to every model class
  static: { ... },
  // Methods added to QueryBuilder.prototype (patched once at registration)
  queryBuilder: { ... },
});
```

Call `definePlugin()` at **module top-level** so plugins register before any models are created. QueryBuilder methods are patched immediately. Instance/static methods are applied to each model class when `Model()` is called.

## Adding TypeScript types

Use **declaration merging** to add type information for your plugin's methods. This is the same pattern the built-in plugins use:

```typescript
// Augment the model instance interface
declare module "baked-orm" {
  interface BaseModel {
    myMethod(): Promise<void>;
    readonly myGetter: boolean;
  }
}

// Augment the model static interface
declare module "baked-orm" {
  interface ModelStatic<Row> {
    myStaticMethod<Self extends ModelStatic<Row>>(
      this: Self,
    ): QueryBuilder<InstanceType<Self>>;
  }
}

// Augment QueryBuilder
declare module "baked-orm" {
  interface QueryBuilder<Row> {
    myQueryMethod(): QueryBuilder<Row>;
  }
}
```

For built-in plugins the module path is relative (e.g. `"../model/types"`). For external plugins, use `"baked-orm"`.

## Accessing QueryBuilder internals

QueryBuilder fields use `_` prefix convention (protected, not `#private`). Plugin methods patched onto the prototype have full access:

| Field | Type | Description |
|---|---|---|
| `_tableDefinition` | `TableDefinition<Row>` | Schema metadata (columns, tableName, primaryKey) |
| `_whereClauses` | `WhereClause[]` | Accumulated WHERE conditions |
| `_orderClauses` | `OrderClause[]` | ORDER BY clauses |
| `_limitValue` | `number \| null` | LIMIT value |
| `_offsetValue` | `number \| null` | OFFSET value |
| `_selectColumns` | `string[]` | Projected columns |
| `_joinClauses` | `string[]` | Raw JOIN clauses |
| `_includedAssociations` | `string[]` | Eager-loaded association names |
| `_modelClass` | constructor \| null | Model class for hydration |
| `_sensitiveColumns` | `Set<string>` | Columns to redact in logs |
| `_distinctValue` | `boolean` | DISTINCT flag |
| `_extensions` | `Record<string, unknown>` | Plugin state bag (auto-cloned) |

### Key methods

- **`_clone(overrides)`** — returns a new QueryBuilder with merged state. Extensions are shallow-merged: `_clone({ extensions: { myKey: value } })`.
- **`_buildSql(projection)`** — entry point for SQL generation. Plugins can wrap this to inject SQL (e.g. CTE wrapper).
- **`_renderSelect(projection, options)`** — renders the SELECT statement. Plugins can wrap this to append clauses (e.g. lock clause).
- **`_appendWhere(text, paramOffset)`** — appends WHERE to a SQL string.

### Plugin state via `_extensions`

Store plugin-specific state in `_extensions`. It's automatically shallow-copied by `_clone()`:

```typescript
// Store state
return this._clone({ extensions: { myFlag: true } });

// Read state
const flag = this._extensions.myFlag as boolean | undefined;
```

## Rendering hooks

Wrap core methods to inject SQL rendering logic. Save the original, call it, augment the result:

```typescript
const originalBuildSql = QueryBuilder.prototype._buildSql;
QueryBuilder.prototype._buildSql = function(projection) {
  const myState = this._extensions.myState;
  if (!myState) return originalBuildSql.call(this, projection);
  // Custom SQL wrapping...
};
```

See `recursive-cte.ts` (wraps `_buildSql`) and `locking.ts` (wraps `_renderSelect` + `toArray`) for real examples.

## Accessing Model internals

Plugin instance methods receive `this` as the model instance. Access model metadata via the constructor:

```typescript
async myMethod(this: Record<string, unknown>): Promise<void> {
  const modelClass = this.constructor as unknown as {
    tableDefinition: TableDefinition;
  };
  const { columns, tableName, primaryKey } = modelClass.tableDefinition;

  // Use importable utilities
  const connection = getModelConnection();
  const rows = await executeQuery(connection, sql, values, sensitiveColumns);

  // Reset dirty tracking after modifying the instance
  (this as { _captureSnapshot: () => void })._captureSnapshot();
}
```

### Available utilities (import from `baked-orm` internals)

- `getModelConnection()` — current database connection
- `executeQuery(connection, text, values, sensitiveColumns)` — execute SQL with logging
- `buildReverseColumnMap(columns)` — DB column name -> camelCase map
- `mapRowToModel(row, reverseMap)` — convert DB row to model properties
- `resolveColumnName(camelKey, columns)` — camelCase -> DB column name
- `quoteIdentifier(name)` — quote a SQL identifier
- `buildSensitiveColumns(constructor, columns)` — get sensitive column set
- `runCallbacks(hook, instance, modelClass)` — run lifecycle callbacks

## Getters

Use `PropertyDescriptor` objects for getters:

```typescript
definePlugin({
  name: "myPlugin",
  instance: {
    myGetter: {
      get(this: Record<string, unknown>): boolean {
        return this.someField != null;
      },
      configurable: true,
      enumerable: false,
    } satisfies PropertyDescriptor,
  },
});
```

## Examples

The built-in plugins in this directory are canonical examples:

- **`soft-delete.ts`** — instance methods, static methods, QueryBuilder methods, PropertyDescriptor getters
- **`locking.ts`** — wraps `_renderSelect` and `toArray`, instance + QueryBuilder methods
- **`recursive-cte.ts`** — wraps `_buildSql`, uses `_extensions` for CTE state, wraps `updateAll`/`deleteAll`
- **`batch-iteration.ts`** — composes public QueryBuilder API only (simplest example)

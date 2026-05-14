# baked-orm Plugins

Plugins extend Model instances, Model classes (statics), QueryBuilder, and (optionally) the auto-serialized virtual-attribute set with new methods, getters, and fields. Built-in plugins (soft-delete, locking, recursive-cte, batch-iteration, aggregates) use the exact same API described here.

## `definePlugin()`

```typescript
import { definePlugin } from "baked-orm";

definePlugin({
  name: "myPlugin",
  // Instance methods/getters added to every model prototype (NOT serialized)
  instance: { ... },
  // Static methods added to every model class
  static: { ... },
  // Methods added to QueryBuilder.prototype (patched once at registration)
  queryBuilder: { ... },
  // Per-model virtual attributes that auto-serialize through toJSON()
  virtuals: (modelClass) => ({ ... }),
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

## Contributing serialized virtuals

Use `instance:` when you want a callable / readable property that does NOT serialize (like `isDiscarded`). Use `virtuals:` when you want a property that DOES serialize through `toJSON()`. This is the explicit split — plugin authors opt into serialization by which API they reach for.

```typescript
definePlugin({
  name: "audit",
  // Per-model contribution. Called once per concrete user subclass on first
  // instance creation. Return {} to skip a given model.
  virtuals(modelClass) {
    if (!(modelClass as { auditFields?: boolean }).auditFields) return {};
    return {
      // Read-only: assignment will throw in strict mode
      fetchedAt: { get: (instance) => Date.now() },
      // Settable: backed by a WeakMap or any other plugin-owned storage
      auditNote: {
        get: (instance) => storage.get(instance) ?? null,
        set: (instance, value) => storage.set(instance, value),
      },
    };
  },
});
```

The plugin's `virtuals(modelClass)` runs lazily — on the first `new UserSubclass(...)` call. By that point the user's subclass exists with its statics, so per-model gating like `if (!modelClass.auditFields) return {}` works.

**Type-side via declaration merging** — same pattern as `QueryBuilder`:

```typescript
declare module "baked-orm" {
  interface BaseModel {
    readonly fetchedAt: number;
    auditNote: string | null;
  }
}
```

The augmentation appears on every model in the type system, but at runtime only models with the gate static (`auditFields = true` above) actually have the accessor. This matches the existing convention — `discard()` is typed on every model even though only `softDelete = true` models actually have it.

### Conflict rules

| Conflict | Resolution |
|---|---|
| Plugin contributes a name that's a column on the model | Silently ignored |
| Plugin contributes a name that's an association on the model | Silently ignored |
| User-declared property (getter, method, class field) on the subclass with same name | User wins silently — plugin doesn't define an accessor |
| Two plugins contributing the same name | Throws on first instantiation, naming both plugins |

### Plugin contract for virtuals detection

The auto-detection of user-declared virtuals (class getters and class-field own-properties on user subclasses) only walks the user's own subclass prototype — NOT parent prototypes. This is the contract that lets `instance:` plugin getters (like `isDiscarded`) NOT accidentally serialize.

For your plugin to play well with the convention:

- **Add `instance:` properties to the parent prototype, not user subclasses.** The framework already does this for you (`applyModelPlugins` runs on the inner ModelBase class). Don't manually patch user subclasses with `Object.defineProperty(UserClass.prototype, ...)` — those would become accidental virtuals.
- **If you set own-properties on instances** (rare — most plugins don't), prefix with `_` (skipped by detection) or use `Object.defineProperty(this, name, { enumerable: false })`. Plain enumerable own-properties are reserved for user-declared virtuals and SQL-aliased values from `findBySql`.

## Examples

The built-in plugins in this directory are canonical examples:

- **`soft-delete.ts`** — instance methods, static methods, QueryBuilder methods, PropertyDescriptor getters
- **`locking.ts`** — wraps `_renderSelect` and `toArray`, instance + QueryBuilder methods
- **`recursive-cte.ts`** — wraps `_buildSql`, uses `_extensions` for CTE state, wraps `updateAll`/`deleteAll`
- **`batch-iteration.ts`** — composes public QueryBuilder API only (simplest example)

// Preload built-in plugins so tests that import directly from src/model/
// (bypassing src/index.ts) still get plugin methods registered.
import "../../src/plugins/recursive-cte";
import "../../src/plugins/locking";
import "../../src/plugins/soft-delete";
import "../../src/plugins/batch-iteration";
import "../../src/plugins/aggregates";

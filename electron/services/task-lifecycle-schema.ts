// v28 — conversations.closed_at + its index. Kept as a standalone SQL constant
// (mirroring loop-schema.ts / brain-schema.ts) so a node:sqlite integration test
// can run the EXACT production statements without the Electron better-sqlite3 ABI.
//
// The `close` lifecycle action on a task sets closed_at to a timestamp; `restore`
// clears it. A closed conversation is treated as a terminal (but recoverable)
// task-graph node — distinct from `archived`, which DUIN already had.
//
// NOTE: this ALTER is NOT idempotent (SQLite has no ADD COLUMN IF NOT EXISTS), so
// the fresh-install path (schema-init.ts) and the migration (db-migrations v28)
// both add the column through a duplicate-column-swallowing helper rather than
// exec-ing this constant directly. The constant remains the single source of
// truth for the column shape + index.
export const TASK_LIFECYCLE_SCHEMA_SQL = `
  ALTER TABLE conversations ADD COLUMN closed_at INTEGER;

  CREATE INDEX IF NOT EXISTS idx_conversations_closed
    ON conversations(closed_at);
`

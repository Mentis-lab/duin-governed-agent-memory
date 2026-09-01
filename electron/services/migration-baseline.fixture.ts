// Shared minimal pre-migration baseline for the migration-registry guards.
//
// WHY THIS FILE EXISTS (gate finding F2): `db-migrations.test.ts` and
// `proof-receipts.test.ts` each carried their own hand-rolled copy of a
// `makeBaselineDb()` that created conversations/messages/events/projects/
// automations. When migration v32 (UA-AUTO goals lifecycle) landed it began
// ALTERing `goals` — a table BOTH copies were missing — so the registry guard
// ("stamps a fresh DB at LATEST_VERSION using the real registry") started
// aborting with `no such table: goals`. Production is unaffected (it always
// runs `initLegacySchema` first, which creates `goals`), but the repo's ONLY
// end-to-end check that the whole registry applies to a fresh DB was dead.
//
// Two duplicated fixtures is how the drift happened, so there is now exactly
// one. When a migration starts touching a table that is created by
// `schema-init.ts` rather than by a migration, add it HERE and both guards
// keep guarding.
//
// Shapes mirror `schema-init.ts` (the legacy bootstrap that runs before
// migrations in production) for the columns the migrations actually read:
// `conversations.created_at` (v11 index), `projects` (v15), `automations.cron`
// (v34's legacy-cron backfill SELECTs it), `goals.status`/`updated_at`/
// `conversation_id` (v32 backfill + lifecycle index). Columns no migration
// touches are deliberately omitted — this is a floor, not a schema mirror.
//
// `automations` is deliberately the PRE-v22 shape (no `deliver_to`) so v22's
// idempotent column add is genuinely exercised rather than short-circuited.

/** Minimal baseline DDL: the schema-init tables the migration registry ALTERs. */
export const MIGRATION_BASELINE_SQL = `
  CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, created_at INTEGER);
  CREATE TABLE events (id TEXT PRIMARY KEY, created_at INTEGER);
  CREATE TABLE projects (id TEXT PRIMARY KEY, created_at INTEGER);
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT
  );
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('open','in_progress','done','abandoned')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

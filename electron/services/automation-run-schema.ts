// automation_runs — the DURABLE IDEMPOTENCY LEDGER (migration v33).
//
// Replaces the in-memory `lastFiredMinute` map in automations-runner.ts: a run is
// claimed by INSERTing a row keyed UNIQUE(automation_id, trigger_key, attempt). A
// second tick that computes the same trigger_key loses the INSERT-OR-IGNORE race,
// so the automation fires exactly once per (trigger, attempt) even across a process
// restart — the in-memory map lost that guarantee on every relaunch. Observability
// (started/completed/failed) still flows through the event log; this table is the
// claim + attempt ledger, not the timeline.
//
// DDL is a standalone constant with no electron import so a node:sqlite integration
// test can run the exact production statements — same discipline as loop-schema.ts.

export const AUTOMATION_RUN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    trigger_key TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('one_shot','schedule','event','monitor','manual')),
    scheduled_at INTEGER,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
    result TEXT,
    error TEXT,
    UNIQUE(automation_id, trigger_key, attempt)
  );

  CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_started
    ON automation_runs(automation_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_automation_runs_status
    ON automation_runs(status, started_at);
`

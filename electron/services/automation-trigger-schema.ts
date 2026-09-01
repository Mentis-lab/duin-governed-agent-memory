// Automation trigger taxonomy columns (migration v34). Widens the DUIN
// `automations` table beyond the single cron column to the upstream Lamprey
// trigger taxonomy (one_shot / schedule / event / monitor) plus per-automation
// retry state. Idempotent ALTER TABLE ADD COLUMN, then a one-time backfill that
// wraps every legacy cron automation as a { kind:'schedule', cron } trigger.
//
// Note: the automation_runs LEDGER is a SEPARATE migration (v33,
// automation-run-schema.ts) in DUIN — upstream folded it into this step; we keep
// them apart so the ledger lands before the trigger columns that depend on it.

interface AutomationSchemaDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    run(...args: unknown[]): unknown
  }
}

function safeAddColumn(db: AutomationSchemaDatabase, ddl: string): void {
  try {
    db.exec(`ALTER TABLE automations ADD COLUMN ${ddl};`)
  } catch (error) {
    if (!/duplicate column name/i.test(String(error instanceof Error ? error.message : error))) {
      throw error
    }
  }
}

export function applyAutomationTriggerSchema(db: AutomationSchemaDatabase): void {
  safeAddColumn(
    db,
    "trigger_kind TEXT NOT NULL DEFAULT 'schedule' CHECK(trigger_kind IN ('one_shot','schedule','event','monitor'))"
  )
  safeAddColumn(db, "trigger_config_json TEXT NOT NULL DEFAULT '{}'")
  safeAddColumn(db, 'next_run_at INTEGER')
  safeAddColumn(db, 'last_trigger_key TEXT')
  safeAddColumn(db, 'retry_attempt INTEGER NOT NULL DEFAULT 0')
  safeAddColumn(db, 'retry_at INTEGER')
  safeAddColumn(db, 'disabled_reason TEXT')

  // Backfill: wrap every legacy cron automation whose trigger_config_json is still
  // the '{}' default as an explicit schedule trigger carrying its cron + retry policy.
  const rows = db
    .prepare(
      "SELECT id, cron FROM automations WHERE trigger_config_json = '{}' OR trigger_config_json IS NULL"
    )
    .all() as Array<{ id: string; cron: string }>
  const update = db.prepare(
    `UPDATE automations
       SET trigger_kind = 'schedule', trigger_config_json = ?
     WHERE id = ?`
  )
  for (const row of rows) {
    update.run(
      JSON.stringify({
        kind: 'schedule',
        cron: row.cron,
        maxAttempts: 3,
        retryDelaySeconds: 60
      }),
      row.id
    )
  }
}

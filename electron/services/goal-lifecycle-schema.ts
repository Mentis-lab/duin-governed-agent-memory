// Operational-goal lifecycle schema (migration v32). Adapts upstream Lamprey's
// goal-schema.ts to DUIN: the pre-existing `goals` table (schema-init.ts) gains a
// full lifecycle spine (status machine + budgets + timestamps + transition audit)
// via idempotent ALTER TABLE ADD COLUMN, plus a one-time backfill that maps the
// legacy 4-value `status` onto the richer `lifecycle_status`, plus a lifecycle idx.
//
// DDL lives here (no electron import) so a node:sqlite integration test can run the
// EXACT production statements without the better-sqlite3 ABI — same discipline as
// loop-schema.ts.

interface GoalSchemaDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
  }
}

function safeAddColumn(db: GoalSchemaDatabase, ddl: string): void {
  try {
    db.exec(`ALTER TABLE goals ADD COLUMN ${ddl};`)
  } catch (error) {
    if (!/duplicate column name/i.test(String(error instanceof Error ? error.message : error))) {
      throw error
    }
  }
}

/**
 * Fail LOUDLY and legibly when the table this migration exclusively ALTERs is
 * absent.
 *
 * `safeAddColumn` already swallows ONLY "duplicate column name" — a missing
 * table has always aborted the migration, which is correct. What it did badly
 * is SAY so: the caller saw `no such table: goals` raised from inside a column
 * add, with nothing pointing at the real precondition (schema-init must have
 * run first). That cost a whole gate investigation. Mirroring the v1
 * baseline-stamp precedent in db-migrations.ts, assert the precondition up
 * front with an actionable message instead.
 */
function assertGoalsTable(db: GoalSchemaDatabase): void {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goals'")
    .get()
  if (!row) {
    throw new Error(
      'goal-lifecycle-schema (migration v32): table "goals" does not exist — ' +
        'this migration only ALTERs it and cannot create it. Run initLegacySchema ' +
        '(schema-init.ts) before runMigrations; a test fixture must include the ' +
        'goals table (see migration-baseline.fixture.ts).'
    )
  }
}

/** Apply the operational-goal lifecycle columns + backfill + index. Idempotent:
 *  the column adds swallow "duplicate column name", the backfill is guarded to
 *  only touch rows still at the default lifecycle, and the index is IF NOT EXISTS. */
export function applyOperationalGoalSchema(db: GoalSchemaDatabase): void {
  assertGoalsTable(db)

  // 13 lifecycle columns.
  safeAddColumn(
    db,
    "lifecycle_status TEXT NOT NULL DEFAULT 'open' CHECK(lifecycle_status IN ('open','active','paused','blocked','completed','aborted'))"
  )
  safeAddColumn(
    db,
    "last_actor TEXT NOT NULL DEFAULT 'system' CHECK(last_actor IN ('user','system','model'))"
  )
  safeAddColumn(db, 'token_budget INTEGER')
  safeAddColumn(db, 'token_used INTEGER NOT NULL DEFAULT 0')
  safeAddColumn(db, 'time_budget_ms INTEGER')
  safeAddColumn(db, 'elapsed_ms INTEGER NOT NULL DEFAULT 0')
  safeAddColumn(db, 'active_since INTEGER')
  safeAddColumn(db, 'paused_at INTEGER')
  safeAddColumn(db, 'completed_at INTEGER')
  safeAddColumn(db, 'aborted_at INTEGER')
  safeAddColumn(db, 'blocker TEXT')
  safeAddColumn(db, 'completion TEXT')
  safeAddColumn(db, 'transition_reason TEXT')

  // One-time backfill: map the legacy `status` onto `lifecycle_status`, seeding the
  // active/completed/aborted timestamps from `updated_at`. Guarded to rows still at
  // the default 'open' lifecycle whose legacy status disagrees, so a re-run is inert.
  db.exec(`
    UPDATE goals
       SET lifecycle_status = CASE status
         WHEN 'in_progress' THEN 'active'
         WHEN 'done' THEN 'completed'
         WHEN 'abandoned' THEN 'aborted'
         ELSE 'open'
       END,
       active_since = CASE WHEN status = 'in_progress' THEN updated_at ELSE active_since END,
       completed_at = CASE WHEN status = 'done' THEN updated_at ELSE completed_at END,
       aborted_at = CASE WHEN status = 'abandoned' THEN updated_at ELSE aborted_at END
     WHERE lifecycle_status = 'open'
       AND status <> 'open';

    CREATE INDEX IF NOT EXISTS idx_goals_lifecycle
      ON goals(conversation_id, lifecycle_status, updated_at DESC);
  `)
}

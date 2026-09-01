// Goal ⇄ automation ⇄ loop binding schema. Split across two DUIN migrations:
//   • applyAutomationGoalBindingSchema (v35): the AUTOMATIONS side — goal binding
//     (goal_id, goal_conversation_id) + per-automation loop-ceiling overrides.
//   • applyGoalLoopBridgeSchema (v36, LAST + highest runaway risk): the GOALS side
//     (loop ownership + ceiling overrides, unique loop-owner index) plus the LOOPS
//     side (back-reference goal_id / goal_conversation_id).
//
// Kept apart so v36 — the goal-owned loop bridge that can wake a background loop —
// lands last and can ship default-off/partial without stranding the earlier steps.
// Idempotent ALTER TABLE ADD COLUMN throughout; indexes are IF NOT EXISTS.

interface BridgeSchemaDatabase {
  exec(sql: string): void
}

function safeAddColumn(
  db: BridgeSchemaDatabase,
  table: 'goals' | 'automations' | 'loops',
  ddl: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
  } catch (error) {
    if (!/duplicate column name/i.test(String(error instanceof Error ? error.message : error))) {
      throw error
    }
  }
}

/** v35 — the automations side of the bridge: bind an automation to a goal and
 *  carry per-automation loop-ceiling overrides (which may only TIGHTEN, never
 *  loosen, via composeLoopCeilings). */
export function applyAutomationGoalBindingSchema(db: BridgeSchemaDatabase): void {
  safeAddColumn(db, 'automations', 'goal_id TEXT')
  safeAddColumn(db, 'automations', 'goal_conversation_id TEXT')
  safeAddColumn(db, 'automations', 'loop_max_iterations INTEGER')
  safeAddColumn(db, 'automations', 'loop_max_wallclock_ms INTEGER')
  safeAddColumn(db, 'automations', 'loop_token_budget INTEGER')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_automations_goal
      ON automations(goal_conversation_id, goal_id) WHERE goal_id IS NOT NULL;
  `)
}

/** v36 — the goals + loops side of the bridge (goal-owned loop). A goal owns at
 *  most one loop (unique partial index); the loop carries a back-reference to its
 *  owning goal so the controller can enforce goal-scoped ceilings + terminal state. */
export function applyGoalLoopBridgeSchema(db: BridgeSchemaDatabase): void {
  safeAddColumn(db, 'goals', 'loop_id TEXT')
  safeAddColumn(db, 'goals', 'loop_max_iterations INTEGER')
  safeAddColumn(db, 'goals', 'loop_max_wallclock_ms INTEGER')
  safeAddColumn(db, 'goals', 'loop_token_budget INTEGER')

  safeAddColumn(db, 'loops', 'goal_id TEXT')
  safeAddColumn(db, 'loops', 'goal_conversation_id TEXT')

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_loop_owner
      ON goals(loop_id) WHERE loop_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_loops_goal
      ON loops(goal_conversation_id, goal_id) WHERE goal_id IS NOT NULL;
  `)
}

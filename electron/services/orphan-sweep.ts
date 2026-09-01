import type { Database } from 'better-sqlite3'

// Phase B3 — one-time cleanup for per-conversation child rows that were
// orphaned by conversation deletes before the `deleteConversation` cascade
// fix. These tables carry a `conversation_id` column but have NO foreign-key
// cascade to `conversations`, so historically nothing removed their rows when
// a conversation was deleted (verified live: 54 tool_calls + 42
// snip_command_log rows stranded against 2 deleted conversations).

/** Per-conversation child tables with a `conversation_id` column but NO FK
 *  cascade to `conversations`. Rows here leak permanently on a conversation
 *  delete unless cleaned explicitly. Keep in sync with `deleteConversation`'s
 *  explicit cascade in conversation-store.ts. */
export const ORPHANABLE_CONVERSATION_CHILD_TABLES = [
  'tool_calls',
  'snip_command_log',
  'snip_events',
  'conversation_rag_attachments'
] as const

export interface OrphanSweepRow {
  table: string
  deleted: number
}

function tableExists(db: Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
}

/**
 * Delete rows in the non-FK per-conversation child tables whose
 * `conversation_id` points at a conversation that no longer exists.
 *
 * SAFETY: the predicate removes ONLY rows whose parent is genuinely gone —
 * a NON-NULL `conversation_id` that is absent from `conversations`. Rows with
 * a NULL `conversation_id` are legitimate (ephemeral / headless tool calls,
 * global snip entries with no conversation) and are always kept. There is no
 * global/unqualified delete: every statement is scoped by the missing-parent
 * predicate, so rows belonging to live conversations are never touched.
 *
 * Returns the per-table delete counts (only tables that actually lost rows).
 * Idempotent: a second run finds nothing to delete.
 */
export function sweepOrphanedConversationChildren(db: Database): OrphanSweepRow[] {
  const out: OrphanSweepRow[] = []
  for (const table of ORPHANABLE_CONVERSATION_CHILD_TABLES) {
    // Defensive: on an unusual boot order a table might not exist yet. Skip
    // rather than throw and abort the migration.
    if (!tableExists(db, table)) continue
    const res = db
      .prepare(
        `DELETE FROM ${table}
          WHERE conversation_id IS NOT NULL
            AND conversation_id NOT IN (SELECT id FROM conversations)`
      )
      .run()
    if (res.changes > 0) out.push({ table, deleted: res.changes })
  }
  return out
}

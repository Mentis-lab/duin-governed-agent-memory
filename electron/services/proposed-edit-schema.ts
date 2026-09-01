import type { Database } from 'better-sqlite3'

// Proposed-edit CARD schema — the reviewable / reversible proposed-edit
// surface over the workspace patch authority, adapted from lamprey's
// pr-patch flow but DECOUPLED from GitHub / PR / SHA anchoring.
//
// Adaptations vs upstream `pr_patch_proposals`:
//   - No GitHub binding: dropped full_name / pr_number / head_sha.
//   - Freshness is a DISK CONTENT-HASH anchor, not a PR head SHA. The
//     `anchor_json` column holds a JSON array of per-file anchors
//     ({ path, existed, sha256 }) captured at propose time; accept re-hashes
//     and refuses to write when any affected file drifted (status → conflict).
//   - `title` / `rationale` are author-facing, non-coder framing for the card.
//   - `workspace_root` BINDS the proposal to the absolute root it was reviewed
//     against (v44). The anchors are workspace-RELATIVE, so without this column
//     accept re-resolves them against whatever `getActiveWorkspace()` happens to
//     return at accept time and the drift check cannot tell two roots apart: an
//     Add-File anchor { existed:false, sha256:null } matches in ANY root where
//     the path is absent, and an Update anchor matches wherever the bytes happen
//     to be identical (boilerplate, an empty file, .gitignore). The card is
//     designed to survive reload/AFK and workspace-state.ts silently falls back
//     to the vault when the persisted folder stops passing isDirectorySafe, so
//     the root really can move under a pending card with no user error.
//
// The DDL lives here as a shared constant so both the migration ledger
// (db-migrations.ts v43 + v44) and a node:sqlite integration test can run the
// exact production statements. IF NOT EXISTS throughout, so re-running (a
// fresh install applying every migration up to LATEST) is a no-op.
//
// `workspace_root` is deliberately NULLABLE at the DDL level: rows written by
// the v43 build predate the binding, and `CREATE TABLE IF NOT EXISTS` cannot
// retro-fit a NOT NULL column onto them. The invariant is enforced one layer up
// instead — createProposedEdit requires a non-empty root, and acceptProposedEdit
// REFUSES any proposal whose stored root is missing or differs from the accept-time
// root. A NULL is therefore un-appliable, not un-checked.

export const PROPOSED_EDIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS proposed_edit_proposals (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    patch           TEXT NOT NULL,
    rationale       TEXT,
    anchor_json     TEXT NOT NULL,
    workspace_root  TEXT,
    status          TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','conflict','error')),
    result          TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposed_edit_proposals_conversation
    ON proposed_edit_proposals(conversation_id, created_at DESC);
`

/** v44 — retro-fit `workspace_root` onto a table created by the v43 build.
 *  ALTER TABLE ADD COLUMN is not idempotent in SQLite and the fresh-install path
 *  already carries the column via PROPOSED_EDIT_SCHEMA_SQL, so the duplicate is
 *  swallowed (the v11/v28 precedent). */
export function addProposedEditWorkspaceRootColumn(db: Pick<Database, 'exec'>): void {
  try {
    db.exec('ALTER TABLE proposed_edit_proposals ADD COLUMN workspace_root TEXT;')
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    if (!/duplicate column name/i.test(message)) throw error
  }
}

export function applyProposedEditSchema(db: Database): void {
  db.exec(PROPOSED_EDIT_SCHEMA_SQL)
  addProposedEditWorkspaceRootColumn(db)
}

import { randomUUID } from 'crypto'
import { getDb } from './database'

// Proposed-edit CARD store. Persistent CRUD over `proposed_edit_proposals`
// so a card survives reload / AFK (the whole point of the surface: a
// non-coder can walk away and come back to a still-actionable proposal).
//
// Mirrors the chapters-store / pr-patch-store shape: snake_case rows in,
// camelCase domain objects out. Status transitions are single-shot and
// guarded — a proposal only leaves `pending` once, and the UPDATE asserts
// `changes === 1` so a double-accept (two clicks, two windows) can't both win.

/** Per-affected-file freshness anchor captured at propose time. `path` is the
 *  workspace-relative path exactly as it appeared in the patch envelope;
 *  `existed` records whether the file was on disk; `sha256` is the hex digest
 *  of the file's raw bytes, or null when the file did not exist. Accept
 *  re-hashes each entry and treats any drift as a conflict. */
export interface ProposedEditAnchor {
  path: string
  existed: boolean
  sha256: string | null
}

export type ProposedEditStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'conflict'
  | 'error'

export interface ProposedEditProposal {
  id: string
  conversationId: string
  title: string
  patch: string
  rationale: string | null
  anchors: ProposedEditAnchor[]
  /** ABSOLUTE workspace root the anchors were captured against, and the ONLY
   *  root this proposal may ever be applied to. `null` for rows written before
   *  the binding existed (v43) — those are refused at accept, never guessed. */
  workspaceRoot: string | null
  status: ProposedEditStatus
  result: string | null
  createdAt: number
  updatedAt: number
}

type Row = {
  id: string
  conversation_id: string
  title: string
  patch: string
  rationale: string | null
  anchor_json: string
  workspace_root: string | null
  status: ProposedEditStatus
  result: string | null
  created_at: number
  updated_at: number
}

function parseAnchors(raw: string): ProposedEditAnchor[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ProposedEditAnchor[]) : []
  } catch {
    return []
  }
}

function map(row: Row): ProposedEditProposal {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    patch: row.patch,
    rationale: row.rationale,
    anchors: parseAnchors(row.anchor_json),
    workspaceRoot: row.workspace_root ?? null,
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getProposedEdit(id: string): ProposedEditProposal | null {
  const row = getDb()
    .prepare('SELECT * FROM proposed_edit_proposals WHERE id = ?')
    .get(id) as Row | undefined
  return row ? map(row) : null
}

export function listProposedEdits(conversationId: string): ProposedEditProposal[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM proposed_edit_proposals WHERE conversation_id = ? ORDER BY created_at ASC'
    )
    .all(conversationId) as Row[]
  return rows.map(map)
}

export function createProposedEdit(input: {
  conversationId: string
  title: string
  patch: string
  rationale?: string | null
  anchors: ProposedEditAnchor[]
  /** ABSOLUTE root the anchors were captured against. Required — a card with no
   *  root is un-appliable by construction (see acceptProposedEdit). */
  workspaceRoot: string
}): ProposedEditProposal {
  if (typeof input.workspaceRoot !== 'string' || input.workspaceRoot.trim() === '') {
    throw new Error('createProposedEdit: workspaceRoot is required')
  }
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO proposed_edit_proposals (
        id, conversation_id, title, patch, rationale, anchor_json, workspace_root,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      id,
      input.conversationId,
      input.title,
      input.patch,
      input.rationale ?? null,
      JSON.stringify(input.anchors),
      input.workspaceRoot,
      now,
      now
    )
  return getProposedEdit(id)!
}

/** Replace the patch/title/rationale AND the freshness anchors of a
 *  still-pending proposal. Used by the card's Edit action (re-propose after
 *  the human tweaks the patch). Re-anchoring is the caller's job — the fresh
 *  anchors are passed in so the flow can re-hash against current disk. */
export function updateProposedEdit(
  id: string,
  input: {
    patch: string
    title?: string
    rationale?: string | null
    anchors: ProposedEditAnchor[]
  }
): ProposedEditProposal {
  const existing = getProposedEdit(id)
  if (!existing || existing.status !== 'pending') {
    throw new Error('proposed edit is missing or no longer pending')
  }
  const changed = getDb()
    .prepare(
      `UPDATE proposed_edit_proposals
         SET patch = ?, title = ?, rationale = ?, anchor_json = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(
      input.patch,
      input.title ?? existing.title,
      input.rationale ?? null,
      JSON.stringify(input.anchors),
      Date.now(),
      id
    )
  if (changed.changes !== 1) {
    throw new Error('proposed edit is missing or no longer pending')
  }
  return getProposedEdit(id)!
}

/** Move a pending proposal to a terminal status. Single-shot: the WHERE
 *  clause pins `status = 'pending'`, so the first writer wins and a second
 *  attempt throws. */
export function setProposedEditStatus(
  id: string,
  status: Exclude<ProposedEditStatus, 'pending'>,
  result?: string | null
): ProposedEditProposal {
  const changed = getDb()
    .prepare(
      `UPDATE proposed_edit_proposals SET status = ?, result = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(status, result ?? null, Date.now(), id)
  if (changed.changes !== 1) {
    throw new Error('proposed edit is missing or no longer pending')
  }
  return getProposedEdit(id)!
}

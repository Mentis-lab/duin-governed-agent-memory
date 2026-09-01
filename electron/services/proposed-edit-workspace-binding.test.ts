import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProposedEditProposal, ProposedEditStatus } from './proposed-edit-store'

// A proposal is NOT bound to the workspace it was proposed against.
//
// `proposed_edit_proposals` (proposed-edit-schema.ts:21-32) stores no workspace
// root, and `proposedEdit:accept` (electron/ipc/proposed-edit.ts:56) re-resolves
// every anchor against `getActiveWorkspace()` AT ACCEPT TIME. The card is
// explicitly designed to survive reload / AFK, so the user can switch the
// workspace chip between propose and accept.
//
// The freshness anchor is the only guard, and it is a per-path content hash
// that says nothing about WHICH root the path was hashed under. Two cases slip
// straight through `detectDrift` (proposed-edit-flow.ts:81-111):
//   - an Add File anchor is { existed: false, sha256: null }, which matches in
//     ANY root where the path is absent;
//   - an Update anchor matches whenever the other root's file happens to hold
//     the same bytes (shared boilerplate, a template, an empty file).
//
// In both cases the patch is written into a root the human never reviewed.

// In-memory stand-in for the SQLite-backed store so the flow can be exercised
// without a database. Mirrors the real single-shot status semantics.
const rows = new Map<string, ProposedEditProposal>()
let nextId = 0

vi.mock('./proposed-edit-store', () => ({
  createProposedEdit: (input: {
    conversationId: string
    title: string
    patch: string
    rationale?: string | null
    anchors: unknown[]
  }) => {
    const id = `p${++nextId}`
    const now = Date.now()
    const row = {
      id,
      conversationId: input.conversationId,
      title: input.title,
      patch: input.patch,
      rationale: input.rationale ?? null,
      anchors: input.anchors,
      status: 'pending',
      result: null,
      createdAt: now,
      updatedAt: now
    } as ProposedEditProposal
    rows.set(id, row)
    return row
  },
  getProposedEdit: (id: string) => rows.get(id) ?? null,
  setProposedEditStatus: (id: string, status: ProposedEditStatus, result?: string | null) => {
    const row = rows.get(id)
    if (!row || row.status !== 'pending') {
      throw new Error('proposed edit is missing or no longer pending')
    }
    const next = { ...row, status, result: result ?? null, updatedAt: Date.now() }
    rows.set(id, next)
    return next
  },
  updateProposedEdit: (id: string) => rows.get(id)!
}))

const { acceptProposedEdit, proposeEdit, ProposedEditConflictError } = await import(
  './proposed-edit-flow'
)

let workspaceA: string
let workspaceB: string

beforeEach(() => {
  rows.clear()
  workspaceA = mkdtempSync(join(tmpdir(), 'proposed-edit-ws-a-'))
  workspaceB = mkdtempSync(join(tmpdir(), 'proposed-edit-ws-b-'))
})

afterEach(() => {
  for (const dir of [workspaceA, workspaceB]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

describe('proposed edit / workspace binding', () => {
  it('does not apply an Add-File proposal into a workspace it was not proposed against', async () => {
    // Proposed while workspace A is active.
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Add File: notes/plan.md', '+draft'),
      workspaceRoot: workspaceA
    })
    expect(proposal.anchors).toEqual([
      { path: 'notes/plan.md', existed: false, sha256: null }
    ])

    // The human walks away, switches the workspace chip to B, comes back and
    // clicks Apply. The IPC handler passes the CURRENT active workspace.
    await expect(
      acceptProposedEdit({ proposalId: proposal.id, workspaceRoot: workspaceB })
    ).rejects.toBeInstanceOf(ProposedEditConflictError)

    // Neither root may be written: A was the reviewed root but is no longer
    // active; B was never reviewed.
    expect(existsSync(join(workspaceB, 'notes', 'plan.md'))).toBe(false)
    expect(existsSync(join(workspaceA, 'notes', 'plan.md'))).toBe(false)
  })

  it('does not apply an Update proposal to a same-content file in a different workspace', async () => {
    // Both roots hold byte-identical boilerplate at the same relative path.
    writeFileSync(join(workspaceA, '.gitignore'), 'node_modules\n', 'utf8')
    writeFileSync(join(workspaceB, '.gitignore'), 'node_modules\n', 'utf8')

    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Update File: .gitignore', '@@', '-node_modules', '+dist'),
      workspaceRoot: workspaceA
    })

    await expect(
      acceptProposedEdit({ proposalId: proposal.id, workspaceRoot: workspaceB })
    ).rejects.toBeInstanceOf(ProposedEditConflictError)

    // B's file is untouched — the human reviewed A's file, not B's.
    expect(readFileSync(join(workspaceB, '.gitignore'), 'utf8')).toBe('node_modules\n')
  })
})

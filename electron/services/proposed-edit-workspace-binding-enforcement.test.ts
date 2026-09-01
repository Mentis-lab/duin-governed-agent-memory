import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { ProposedEditProposal, ProposedEditStatus } from './proposed-edit-store'

// Companion to proposed-edit-workspace-binding.test.ts.
//
// That probe drives the store mock the reviewer wrote, which does not echo the new
// `workspaceRoot` back — so it lands on the "no recorded root → refuse" arm. This file
// uses a store stand-in that DOES persist the binding, so the mismatch arm itself is
// exercised: same relative path, byte-identical content, different root.

const rows = new Map<string, ProposedEditProposal>()
let nextId = 0

vi.mock('./proposed-edit-store', () => ({
  createProposedEdit: (input: {
    conversationId: string
    title: string
    patch: string
    rationale?: string | null
    anchors: unknown[]
    workspaceRoot: string
  }) => {
    if (!input.workspaceRoot) throw new Error('createProposedEdit: workspaceRoot is required')
    const id = `p${++nextId}`
    const now = Date.now()
    const row = {
      id,
      conversationId: input.conversationId,
      title: input.title,
      patch: input.patch,
      rationale: input.rationale ?? null,
      anchors: input.anchors,
      workspaceRoot: input.workspaceRoot,
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
  updateProposedEdit: (id: string, input: { patch: string; anchors: unknown[] }) => {
    const row = rows.get(id)!
    const next = { ...row, ...input, updatedAt: Date.now() } as ProposedEditProposal
    rows.set(id, next)
    return next
  }
}))

const { acceptProposedEdit, editProposedEdit, proposeEdit, ProposedEditConflictError } =
  await import('./proposed-edit-flow')

let workspaceA: string
let workspaceB: string

beforeEach(() => {
  rows.clear()
  workspaceA = mkdtempSync(join(tmpdir(), 'pe-bind-a-'))
  workspaceB = mkdtempSync(join(tmpdir(), 'pe-bind-b-'))
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

describe('proposed edit — workspace binding enforcement', () => {
  it('records the proposing workspace root on the card', () => {
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Add File: notes/plan.md', '+draft'),
      workspaceRoot: workspaceA
    })
    expect(proposal.workspaceRoot).toBeTruthy()
  })

  it('still applies normally when the accept-time root is the reviewed root', async () => {
    writeFileSync(join(workspaceA, '.gitignore'), 'node_modules\n', 'utf8')
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Update File: .gitignore', '@@', '-node_modules', '+dist'),
      workspaceRoot: workspaceA
    })
    const { applied } = await acceptProposedEdit({
      proposalId: proposal.id,
      workspaceRoot: workspaceA
    })
    expect(applied).toContain('.gitignore')
    expect(readFileSync(join(workspaceA, '.gitignore'), 'utf8')).toContain('dist')
  })

  it('refuses a same-bytes Update in a different root and marks the card conflict', async () => {
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

    expect(readFileSync(join(workspaceB, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(readFileSync(join(workspaceA, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(rows.get(proposal.id)!.status).toBe('conflict')
    expect(rows.get(proposal.id)!.result).toContain('reviewed against the workspace')
  })

  it('refuses an Add-File proposal in a root where the path merely happens to be absent', async () => {
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Add File: notes/plan.md', '+draft'),
      workspaceRoot: workspaceA
    })
    await expect(
      acceptProposedEdit({ proposalId: proposal.id, workspaceRoot: workspaceB })
    ).rejects.toBeInstanceOf(ProposedEditConflictError)
    expect(existsSync(join(workspaceB, 'notes', 'plan.md'))).toBe(false)
  })

  it('treats a trailing separator as the SAME root (no false conflict)', async () => {
    writeFileSync(join(workspaceA, 'note.md'), 'v1\n', 'utf8')
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Update File: note.md', '@@', '-v1', '+v2'),
      workspaceRoot: workspaceA
    })
    await expect(
      acceptProposedEdit({ proposalId: proposal.id, workspaceRoot: `${workspaceA}${sep}` })
    ).resolves.toBeTruthy()
  })

  it('refuses the Edit action from a different root, so re-anchoring cannot re-home the card', () => {
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Add File: notes/plan.md', '+draft'),
      workspaceRoot: workspaceA
    })
    expect(() =>
      editProposedEdit({
        proposalId: proposal.id,
        patch: patch('*** Add File: notes/plan.md', '+draft2'),
        workspaceRoot: workspaceB
      })
    ).toThrow(ProposedEditConflictError)
    // The card keeps its original patch and its original binding.
    expect(rows.get(proposal.id)!.patch).toContain('+draft')
    expect(rows.get(proposal.id)!.workspaceRoot).toBeTruthy()
  })

  it('refuses a legacy card that carries no recorded root rather than guessing', async () => {
    const proposal = proposeEdit({
      conversationId: 'c1',
      patch: patch('*** Add File: notes/plan.md', '+draft'),
      workspaceRoot: workspaceA
    })
    // Simulate a row written by the v43 build, before workspace_root existed.
    rows.set(proposal.id, { ...rows.get(proposal.id)!, workspaceRoot: null })
    await expect(
      acceptProposedEdit({ proposalId: proposal.id, workspaceRoot: workspaceA })
    ).rejects.toThrow(/before DUIN recorded which workspace/)
    expect(existsSync(join(workspaceA, 'notes', 'plan.md'))).toBe(false)
  })
})

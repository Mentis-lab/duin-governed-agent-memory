import { describe, it, expect } from 'vitest'
import { verifyBeforeCommit, type VerifyReceipt } from './verify-gate'
import type { HealthGraph } from '../brain/brain-health'

// VERIFY (2BRAIN) — the pure gate. No I/O; runs everywhere. Proves the two
// BRAIN-output properties and the fail-safe-open / fail-closed contract.

// A tiny brain graph with two real note nodes (a .md id + a vault-layer node).
const GRAPH: HealthGraph = {
  nodes: [
    { id: '03 Projects/DUIN/design.md', kind: 'note' },
    { id: 'notes/decision-2026.md', layer: 'vault' },
    { id: 'person:theo', kind: 'person', layer: 'construction' } // an ENTITY, not a note
  ],
  edges: []
}

describe('verifyBeforeCommit — memory-write non-corrupting', () => {
  it('passes when identity axes hold (no regression)', () => {
    const r: VerifyReceipt = {
      coherenceBefore: 60,
      coherenceAfter: 60,
      purityBefore: 70,
      purityAfter: 71
    }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(true)
    expect(d.checks.memoryNonCorrupting).toBe('pass')
  })

  it('BLOCKS when a memory write drops coherence past tolerance (corruption)', () => {
    const r: VerifyReceipt = { coherenceBefore: 60, coherenceAfter: 50 }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(false)
    expect(d.checks.memoryNonCorrupting).toBe('fail')
    expect(d.failures[0]).toMatch(/coherence 60.0→50.0/)
  })

  it('BLOCKS on a purity drop (prompt-echo / scaffolding leak)', () => {
    const r: VerifyReceipt = { purityBefore: 80, purityAfter: 70 }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(false)
    expect(d.failures[0]).toMatch(/purity/)
  })

  it('tolerates sub-threshold noise (2pt default) — does not block on jitter', () => {
    const r: VerifyReceipt = { coherenceBefore: 60, coherenceAfter: 58.5 }
    expect(verifyBeforeCommit(r).pass).toBe(true)
  })

  it('respects a custom tolerance', () => {
    const r: VerifyReceipt = { coherenceBefore: 60, coherenceAfter: 55 }
    expect(verifyBeforeCommit(r, { regressionTolerance: 10 }).pass).toBe(true)
    expect(verifyBeforeCommit(r, { regressionTolerance: 1 }).pass).toBe(false)
  })

  it('SKIPS (fail-safe-open) when no before/after snapshot exists', () => {
    const d = verifyBeforeCommit({})
    expect(d.pass).toBe(true)
    expect(d.checks.memoryNonCorrupting).toBe('skip')
  })
})

describe('verifyBeforeCommit — digest cites real notes', () => {
  it('passes when every cited note resolves to a real note node', () => {
    const r: VerifyReceipt = {
      citedNotes: ['03 Projects/DUIN/design.md', 'decision-2026.md'], // exact id + basename
      graph: GRAPH
    }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(true)
    expect(d.checks.citationsGrounded).toBe('pass')
    expect(d.danglingCitations).toEqual([])
  })

  it('BLOCKS on a citation to a note that does not exist (hallucinated provenance)', () => {
    const r: VerifyReceipt = {
      citedNotes: ['03 Projects/DUIN/design.md', 'ghosts/not-a-real-note.md'],
      graph: GRAPH
    }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(false)
    expect(d.checks.citationsGrounded).toBe('fail')
    expect(d.danglingCitations).toEqual(['ghosts/not-a-real-note.md'])
  })

  it('does NOT count an entity node as a citable note (isNoteNode reuse)', () => {
    const r: VerifyReceipt = { citedNotes: ['person:theo'], graph: GRAPH }
    const d = verifyBeforeCommit(r)
    expect(d.pass).toBe(false)
    expect(d.danglingCitations).toEqual(['person:theo'])
  })

  it('resolves citations by punctuation/case fold (normLabel reuse)', () => {
    // "DESIGN.md" folds to the same basename as "design.md" → resolves.
    expect(verifyBeforeCommit({ citedNotes: ['DESIGN.md'], graph: GRAPH }).pass).toBe(true)
  })

  it('SKIPS when there are citations but no graph to check against', () => {
    const d = verifyBeforeCommit({ citedNotes: ['whatever.md'] })
    expect(d.pass).toBe(true)
    expect(d.checks.citationsGrounded).toBe('skip')
  })

  it('SKIPS when there are no citations', () => {
    const d = verifyBeforeCommit({ graph: GRAPH })
    expect(d.checks.citationsGrounded).toBe('skip')
  })
})

describe('verifyBeforeCommit — combined', () => {
  it('a fully clean turn passes both checks', () => {
    const d = verifyBeforeCommit({
      coherenceBefore: 55,
      coherenceAfter: 56,
      purityBefore: 60,
      purityAfter: 60,
      citedNotes: ['decision-2026.md'],
      graph: GRAPH
    })
    expect(d.pass).toBe(true)
    expect(d.checks).toEqual({ memoryNonCorrupting: 'pass', citationsGrounded: 'pass' })
  })

  it('reports BOTH failures when a turn corrupts AND hallucinates', () => {
    const d = verifyBeforeCommit({
      coherenceBefore: 60,
      coherenceAfter: 40,
      citedNotes: ['nope.md'],
      graph: GRAPH
    })
    expect(d.pass).toBe(false)
    expect(d.failures.length).toBe(2)
  })
})

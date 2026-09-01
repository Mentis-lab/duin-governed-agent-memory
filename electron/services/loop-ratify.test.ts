import { describe, it, expect, vi } from 'vitest'
import { ratifyStagedItem, isRatifyVerb, RATIFY_CAP_ID, type RatifyDeps } from './loop-ratify'
import type { BacklogItem, Loop } from './loop-store'

// ── fakes ──────────────────────────────────────────────────────────────────────

function backlog(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'item-1',
    loopId: 'loop-1',
    position: 0,
    task: 'do a thing',
    status: 'awaiting-ratification',
    result: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    ...over
  } as BacklogItem
}

function loop(over: Partial<Loop> = {}): Loop {
  return { id: 'loop-1', artifactDir: '/art', ...over } as Loop
}

function makeDeps(over: Partial<RatifyDeps> & { item?: BacklogItem | null; loop?: Loop | null } = {}): {
  deps: RatifyDeps
  updates: { id: string; patch: Record<string, unknown> }[]
  feedback: string[]
  applied: string[]
  discarded: string[]
} {
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  const feedback: string[] = []
  const applied: string[] = []
  const discarded: string[] = []
  let current = 'item' in over ? over.item : backlog()
  const deps: RatifyDeps = {
    getBacklogItem: () => current ?? null,
    getLoop: () => ('loop' in over ? over.loop ?? null : loop()),
    updateBacklogItem: (id, patch) => {
      updates.push({ id, patch: patch as Record<string, unknown> })
      if (current) current = { ...current, ...(patch as object) } as BacklogItem
      return current ?? null
    },
    recordFeedback: (_cap, verb) => {
      feedback.push(verb)
      return true
    },
    applyStaged: async (_dir, key) => {
      applied.push(key)
      return 'landed-sha'
    },
    discardStaged: async (_dir, key) => {
      discarded.push(key)
    },
    exec: (async () => ({ stdout: '', stderr: '', code: 0 })) as RatifyDeps['exec'],
    now: () => 1000,
    ...over
  }
  return { deps, updates, feedback, applied, discarded }
}

// ── verb guard ───────────────────────────────────────────────────────────────

describe('isRatifyVerb', () => {
  it('accepts the three verbs, rejects everything else', () => {
    expect(isRatifyVerb('ratify')).toBe(true)
    expect(isRatifyVerb('revert')).toBe(true)
    expect(isRatifyVerb('dismiss')).toBe(true)
    expect(isRatifyVerb('run')).toBe(false)
    expect(isRatifyVerb('')).toBe(false)
    expect(isRatifyVerb(undefined)).toBe(false)
  })
})

// ── ratify ───────────────────────────────────────────────────────────────────

describe('ratifyStagedItem — ratify', () => {
  it('LANDS the git output, marks the item done, records ratify', async () => {
    const { deps, updates, feedback, applied } = makeDeps()
    const r = await ratifyStagedItem('item-1', 'ratify', deps)
    expect(r).toEqual({ ok: true, status: 'done', landedSha: 'landed-sha' })
    expect(applied).toEqual(['item-1'])
    expect(updates).toEqual([{ id: 'item-1', patch: { status: 'done', finishedAt: 1000 } }])
    expect(feedback).toEqual(['ratify'])
  })

  it('lands NOTHING (no git) for a loop with no artifactDir, still marks done + records', async () => {
    const { deps, updates, feedback, applied } = makeDeps({ loop: loop({ artifactDir: undefined }) })
    const r = await ratifyStagedItem('item-1', 'ratify', deps)
    expect(r.ok).toBe(true)
    expect(r.landedSha).toBeNull()
    expect(applied).toEqual([]) // no git op
    expect(updates[0].patch.status).toBe('done')
    expect(feedback).toEqual(['ratify'])
  })

  it('a FAILED apply leaves the item awaiting (nothing marked done / no ratify) — retry-safe', async () => {
    const { deps, updates, feedback } = makeDeps({
      applyStaged: async () => {
        throw new Error('ff-only refused')
      }
    })
    await expect(ratifyStagedItem('item-1', 'ratify', deps)).rejects.toThrow(/ff-only refused/)
    expect(updates).toEqual([]) // status untouched
    expect(feedback).toEqual([]) // no ratify credit on a failed land
  })
})

// ── revert ───────────────────────────────────────────────────────────────────

describe('ratifyStagedItem — revert', () => {
  it('DISCARDS the held output, re-queues the item (pending), records revert', async () => {
    const { deps, updates, feedback, discarded } = makeDeps()
    const r = await ratifyStagedItem('item-1', 'revert', deps)
    expect(r).toEqual({ ok: true, status: 'pending' })
    expect(discarded).toEqual(['item-1'])
    expect(updates).toEqual([{ id: 'item-1', patch: { status: 'pending', startedAt: null, finishedAt: null } }])
    expect(feedback).toEqual(['revert'])
  })
})

// ── dismiss ──────────────────────────────────────────────────────────────────

describe('ratifyStagedItem — dismiss', () => {
  it('keeps the work held (no status change, no git op), records dismiss', async () => {
    const { deps, updates, feedback, applied, discarded } = makeDeps()
    const r = await ratifyStagedItem('item-1', 'dismiss', deps)
    expect(r).toEqual({ ok: true, status: 'awaiting-ratification' })
    expect(updates).toEqual([])
    expect(applied).toEqual([])
    expect(discarded).toEqual([])
    expect(feedback).toEqual(['dismiss'])
  })
})

// ── the tie + idempotency guard ──────────────────────────────────────────────

describe('ratifyStagedItem — tie + idempotency', () => {
  it('rejects an unknown item', async () => {
    const { deps } = makeDeps({ item: null })
    expect(await ratifyStagedItem('ghost', 'ratify', deps)).toEqual({ ok: false, error: 'no backlog item ghost' })
  })

  it('rejects an item that is NOT awaiting-ratification (already done ⇒ no double-land)', async () => {
    const { deps, applied, feedback } = makeDeps({ item: backlog({ status: 'done' }) })
    const r = await ratifyStagedItem('item-1', 'ratify', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/is 'done', not awaiting-ratification/)
    expect(applied).toEqual([]) // never touched git
    expect(feedback).toEqual([]) // never inflated the ratify count
  })

  it('a replayed ratify is a no-op-reject (second call sees done, not awaiting)', async () => {
    const { deps, feedback } = makeDeps()
    const first = await ratifyStagedItem('item-1', 'ratify', deps)
    expect(first.ok).toBe(true)
    const second = await ratifyStagedItem('item-1', 'ratify', deps)
    expect(second.ok).toBe(false) // the fake mutated current → status now 'done'
    expect(feedback).toEqual(['ratify']) // exactly once — no inflation
  })

  it('exposes the capability id it credits', () => {
    expect(RATIFY_CAP_ID).toBe('autonomous-loop')
  })

  it('CONCURRENT ratifies for the same id ⇒ exactly one lands, the other rejects (no inflation)', async () => {
    // applyStaged is held open so both calls are genuinely in-flight at once.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { deps, feedback, applied } = makeDeps({
      applyStaged: async (_dir, key) => {
        applied.push(key)
        await gate
        return 'landed'
      }
    })
    const a = ratifyStagedItem('item-1', 'ratify', deps)
    const b = ratifyStagedItem('item-1', 'ratify', deps) // fired while A is mid-apply
    const bResult = await b // B rejects immediately on the in-flight claim
    expect(bResult).toEqual({ ok: false, error: 'item item-1 is already being ratified' })
    release()
    const aResult = await a
    expect(aResult.ok).toBe(true)
    expect(applied).toEqual(['item-1']) // git apply ran exactly once
    expect(feedback).toEqual(['ratify']) // credited exactly once — not inflated
  })
})

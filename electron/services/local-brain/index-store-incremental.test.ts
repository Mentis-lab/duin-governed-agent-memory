import { describe, it, expect } from 'vitest'
// Pure decision test for INCREMENTAL reindex. Per the index-store convention,
// better-sqlite3 is built for Electron's ABI and won't load under vitest, so the
// DB-integration (chunk/vector prune + ledger write) is verified LIVE; this locks
// the diff DECISION that drives it — the part where a bug silently re-embeds
// everything or, worse, skips a changed file.
import { planReindex } from './index-store'

const m = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o))

describe('planReindex (pure incremental decision)', () => {
  it('all hashes match → everything kept, nothing re-embedded', () => {
    const cur = m({ 'a.md': 'h1', 'b.md': 'h2' })
    const { keep, changed } = planReindex(cur, m({ 'a.md': 'h1', 'b.md': 'h2' }))
    expect(keep.sort()).toEqual(['a.md', 'b.md'])
    expect(changed).toEqual([])
  })

  it('a modified file (different hash) is re-embedded, its sibling is kept', () => {
    const { keep, changed } = planReindex(
      m({ 'a.md': 'h1', 'b.md': 'h2-NEW' }),
      m({ 'a.md': 'h1', 'b.md': 'h2' })
    )
    expect(keep).toEqual(['a.md'])
    expect(changed).toEqual(['b.md'])
  })

  it('a new file (absent from the ledger) is changed', () => {
    const { keep, changed } = planReindex(m({ 'a.md': 'h1', 'c.md': 'h3' }), m({ 'a.md': 'h1' }))
    expect(keep).toEqual(['a.md'])
    expect(changed).toEqual(['c.md'])
  })

  it('a removed file (in ledger, not current) is neither kept nor changed (pruned by absence)', () => {
    const { keep, changed } = planReindex(m({ 'a.md': 'h1' }), m({ 'a.md': 'h1', 'gone.md': 'hX' }))
    expect(keep).toEqual(['a.md'])
    expect(changed).toEqual([])
    // 'gone.md' appears in neither list → pruneToKeep deletes it (not in `keep`).
    expect([...keep, ...changed]).not.toContain('gone.md')
  })

  it('first run (empty ledger) → every file is changed (full embed)', () => {
    const { keep, changed } = planReindex(m({ 'a.md': 'h1', 'b.md': 'h2' }), new Map())
    expect(keep).toEqual([])
    expect(changed.sort()).toEqual(['a.md', 'b.md'])
  })

  it('empty vault → keep and changed both empty (everything prior is pruned)', () => {
    const { keep, changed } = planReindex(new Map(), m({ 'a.md': 'h1' }))
    expect(keep).toEqual([])
    expect(changed).toEqual([])
  })

  it('combined churn: keep + modify + add + remove in one pass', () => {
    const { keep, changed } = planReindex(
      m({ 'keep.md': 'k', 'mod.md': 'm2', 'new.md': 'n' }),
      m({ 'keep.md': 'k', 'mod.md': 'm1', 'del.md': 'd' })
    )
    expect(keep).toEqual(['keep.md'])
    expect(changed.sort()).toEqual(['mod.md', 'new.md'])
  })
})

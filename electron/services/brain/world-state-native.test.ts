import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { worldState, revealedRisks } from './world-state-native'
import { clearOntologyCache } from './ontology'

// Cold-start A3 emptied the BUILT-IN track list (it was one operator's six real lanes), so this
// suite now declares its tracks the way a real vault does — `.duin/ontology.json` — and asserts the
// same rollup behaviour over them. That is strictly more coverage than before: it exercises the
// per-vault ontology path that worldState/revealedRisks actually depend on now, instead of a
// compiled-in constant.
const ONTOLOGY = {
  tracks: [
    { key: 'alpha', match: 'alpha' },
    { key: 'beta', match: 'beta' },
    { key: 'gamma', match: 'gamma' },
    { key: 'delta', match: 'delta' },
    { key: 'epsilon', match: 'epsilon' },
    { key: 'personal', match: 'personal' }
  ]
}

describe('worldState + revealedRisks', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ws-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(join(vault, '.duin', 'ontology.json'), JSON.stringify(ONTOLOGY))
    writeFileSync(join(vault, '.duin', '_state', 'future-nodes.jsonl'), '')
    mkdirSync(join(vault, 'alpha'), { recursive: true })
    // one open alpha task with a hard deadline 2d out → counts as open + a revealed risk
    writeFileSync(
      join(vault, 'alpha', 'Tasks.md'),
      [
        '- [ ] alpha ship freeze {{priority:: 1}} {{dateDue:: 2026-06-03}}',
        '- [ ] alpha distribution follow-up {{dateDue:: 2026-08-01}}',
        '- [x] done alpha'
      ].join('\r\n')
    )
    clearOntologyCache()
  })
  afterAll(() => {
    clearOntologyCache()
    rmSync(vault, { recursive: true, force: true })
  })

  it('revealedRisks flags an imminent hard-deadline high-stakes task', () => {
    const { risks } = revealedRisks(vault, new Date('2026-06-01T00:00:00Z'))
    const r = risks.find((x) => x.reason.startsWith('hard deadline'))
    expect(r).toBeTruthy()
    expect(r!.track).toBe('alpha') // stamped from the VAULT's ontology, not a built-in
    expect(r!.confidence).toBe(0.9)
    expect(r!.reason).toContain('2d')
  })

  it('worldState rolls counts + risks per track', () => {
    const { tracks, priors } = worldState(vault, new Date('2026-06-01T00:00:00Z'))
    const my = tracks.find((t) => (t as { key: string }).key === 'alpha') as Record<string, unknown>
    expect(my.open).toBe(2) // two open alpha tasks (done excluded)
    expect(my.risks).toBe(1) // the hard-deadline task
    expect(my.label).toBe('alpha') // no built-in label for this key → falls back to the key
    expect(String(my.status)).toContain('open')
    expect(priors).toContain('me.md')
    // every track the vault declared is always present (quiet when empty)
    expect(tracks.length).toBe(ONTOLOGY.tracks.length)
    expect((tracks.find((t) => (t as { key: string }).key === 'beta') as { open: number }).open).toBe(0)
  })

  it('null vault → the built-in default, which since A3 declares no tracks', () => {
    // Empty-and-honest: a fresh install has no lanes until the operator declares them, rather
    // than rendering a stranger's six.
    const { tracks } = worldState(null)
    expect(tracks).toEqual([])
  })
})

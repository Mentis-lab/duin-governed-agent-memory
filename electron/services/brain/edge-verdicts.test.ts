import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { edgeKey, applyEdgeVerdicts, recordEdgeVerdict, loadEdgeVerdicts, isEdgeVetoed } from './edge-verdicts'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'edge-verdicts-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const EDGES = [
  { source: 'a', target: 'b', type: 'mentions' },
  { source: 'b', target: 'c', type: 'blocks' },
  { source: 'a', target: 'c', type: 'owns' }
]

describe('applyEdgeVerdicts (pure)', () => {
  it('drops only vetoed edges; endorsed + unknown pass through', () => {
    const v = new Map([
      [edgeKey('b', 'c', 'blocks'), 'vetoed' as const],
      [edgeKey('a', 'b', 'mentions'), 'endorsed' as const]
    ])
    const out = applyEdgeVerdicts(EDGES, v)
    expect(out.map((e) => e.type)).toEqual(['mentions', 'owns'])
  })
  it('returns the input unchanged when there are no verdicts', () => {
    expect(applyEdgeVerdicts(EDGES, new Map())).toBe(EDGES)
  })
  it('is direction-sensitive (a->b vetoed does not suppress b->a)', () => {
    const v = new Map([[edgeKey('a', 'b', 'mentions'), 'vetoed' as const]])
    const out = applyEdgeVerdicts([{ source: 'b', target: 'a', type: 'mentions' }], v)
    expect(out).toHaveLength(1)
  })
})

describe('record / load roundtrip', () => {
  it('persists and reloads a verdict; last write wins', () => {
    const vault = tmpVault()
    recordEdgeVerdict(vault, { from: 'a', to: 'b', edgeType: 'mentions', verdict: 'vetoed', ts: '2026-07-18T00:00:00Z' })
    expect(isEdgeVetoed(loadEdgeVerdicts(vault), 'a', 'b', 'mentions')).toBe(true)
    // operator changes their mind → endorse; the later line wins
    recordEdgeVerdict(vault, { from: 'a', to: 'b', edgeType: 'mentions', verdict: 'endorsed', ts: '2026-07-18T01:00:00Z' })
    expect(isEdgeVetoed(loadEdgeVerdicts(vault), 'a', 'b', 'mentions')).toBe(false)
  })
  it('missing ledger loads as empty', () => {
    expect(loadEdgeVerdicts(tmpVault()).size).toBe(0)
  })
})

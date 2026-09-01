import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { futuresGraph } from './futures-graph-native'

// Deep correctness is proven by the live byte-parity vs the standalone sidecar (9 nodes,
// links, today — all EXACT). These lock the shape + the empty/null contracts.
describe('futuresGraph', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fg-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('empty vault → no nodes/links but today + generated stamped (UTC midnight)', () => {
    const g = futuresGraph(vault, new Date('2026-07-02T15:00:00Z'))
    expect(g.nodes).toEqual([])
    expect(g.links).toEqual([])
    expect(g.today).toBe('2026-07-02')
    expect(g.generated).toBe('2026-07-02')
  })

  it('null vault → empty with today', () => {
    const g = futuresGraph(null, new Date('2026-07-02T00:00:00Z'))
    expect(g).toEqual({ nodes: [], links: [], today: '2026-07-02', generated: '2026-07-02' })
  })
})

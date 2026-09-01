// GOLDEN lock for world_graph. Live-diff proved worldGraph(vault) byte-exact on the
// real vault; this pins the pure transform (buildWorldGraph) — node/edge shapes,
// edge-type map, and the trajectory dip/fork math — on synthetic tracks.
import { describe, it, expect } from 'vitest'
import { buildWorldGraph } from './world-graph-native'

describe('world-graph-native — golden (world_graph transform)', () => {
  it('builds typed nodes/edges + dip-and-fork trajectory', () => {
    const today = new Date(2026, 6, 7) // 2026-07-07 local midnight
    const g = buildWorldGraph(
      [
        {
          key: 'T1',
          label: 'Track One',
          events: [
            { kind: 'risk', label: 'R1', date: '2026-07-20', confidence: 0.5 },
            { kind: 'update', label: 'U1', date: '2026-07-01' } // no confidence → 0.7
          ],
          linked: ['[[Decision A]]']
        }
      ],
      today
    )

    expect(g.tracks).toEqual(['T1'])
    expect(g.labels).toEqual({ T1: 'Track One' })
    expect(g.generated).toBe('2026-07-07')
    expect(g.nodes).toEqual([
      { id: 'track:T1', kind: 'track', track: 'T1', label: 'Track One', date: '2026-07-07' },
      { id: 'T1:risk:0', kind: 'risk', track: 'T1', label: 'R1', date: '2026-07-20', confidence: 0.5 },
      { id: 'T1:update:1', kind: 'update', track: 'T1', label: 'U1', date: '2026-07-01', confidence: 0.7 },
      { id: 'T1:driver:0', kind: 'decision', track: 'T1', label: 'Decision A', date: '2026-07-07' } // [[ ]] stripped
    ])
    expect(g.edges).toEqual([
      { source: 'T1:risk:0', target: 'track:T1', type: 'threatens' },
      { source: 'T1:update:1', target: 'track:T1', type: 'updates' },
      { source: 'T1:driver:0', target: 'track:T1', type: 'shapes' }
    ])
    expect((g.trajectories as Record<string, unknown>).T1).toEqual({
      line: [
        { date: '2026-06-25', v: 0.72 }, // today - 12d
        { date: '2026-07-07', v: 0.66 }, // baseline
        { date: '2026-07-20', v: 0.58, risk: 'R1' } // 0.66 - 0.16*0.5
      ],
      end: '2026-07-23', // max(risk 07-20, today+16d 07-23)
      addressed: { date: '2026-07-23', v: 0.75 }, // min(0.75, 0.58+0.28)
      unaddressed: { date: '2026-07-23', v: 0.44 } // max(0.05, 0.58-0.14)
    })
  })
})

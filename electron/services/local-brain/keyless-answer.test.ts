import { describe, it, expect } from 'vitest'
import {
  composeKeylessAnswer,
  computeFirstInsight,
  CONNECT_AI_CTA,
  type KeylessEngineState,
  type NoteHit
} from './keyless-answer'
import type { Insight, OpenLoop, PredictedRisk } from '../brain/types'
import type { WorldState, WorldTrack } from '../brain/world-state'

const insight = (over: Partial<Insight> = {}): Insight => ({
  id: 'i1', type: 'insight', headline: 'Two deadlines cluster', why: 'mei-lin and xbox land same week', sources: ['n1'], confidence: 0.8, ...over
})
const risk = (over: Partial<PredictedRisk> = {}): PredictedRisk => ({
  id: 'r1', kind: 'decision-window', title: 'Adopt haptics?', due: '2999-01-01', leading_indicator: 'decide_by', subjects: ['n2'], confidence: 0.7, reason: 'decide-by closing', ...over
})
const track = (over: Partial<WorldTrack> = {}): WorldTrack => ({
  key: 't1', label: 'Beilan', open: 3, due_soon: 1, next_due: '2999-01-02', risks: 1, top_risk: 'haptics', risk_list: ['haptics'], drivers: [], status: 'one due soon, one risk', events: [], ...over
})
const world = (tracks: WorldTrack[] = []): WorldState => ({ tracks, generated: '2026-06-22' })
const empty: KeylessEngineState = { insights: [], risks: [], world: world([]) }

describe('composeKeylessAnswer', () => {
  it('always ends with the Connect-AI CTA', () => {
    expect(composeKeylessAnswer('q', [], empty)).toContain(CONNECT_AI_CTA)
    const hit: NoteHit = { file: 'a.md', snippet: 'hello', score: 1 }
    expect(composeKeylessAnswer('q', [hit], empty)).toContain(CONNECT_AI_CTA)
  })

  it('returns a graceful message when nothing is available', () => {
    const out = composeKeylessAnswer('q', [], empty)
    expect(out).toMatch(/don't have anything in your brain/i)
    expect(out).not.toMatch(/Relevant notes/)
  })

  it('includes notes, foreseen risks, insights, and situation when present', () => {
    const hits: NoteHit[] = [{ file: 'plan.md', snippet: 'the launch plan', score: 0.9 }]
    const out = composeKeylessAnswer('focus', hits, {
      insights: [insight()],
      risks: [risk()],
      world: world([track()])
    })
    expect(out).toContain('**plan.md**')
    expect(out).toContain('Adopt haptics?')
    expect(out).toContain('Two deadlines cluster')
    expect(out).toContain('**Beilan**')
  })

  it('caps to top 3 notes / top 2 risks / top 2 insights', () => {
    const hits: NoteHit[] = Array.from({ length: 6 }, (_, i) => ({ file: `n${i}.md`, snippet: 's', score: i }))
    const out = composeKeylessAnswer('q', hits, {
      insights: [insight({ id: 'a' }), insight({ id: 'b' }), insight({ id: 'c', headline: 'THIRD' })],
      risks: [risk({ id: 'a' }), risk({ id: 'b' }), risk({ id: 'c', title: 'THIRD RISK' })],
      world: world([])
    })
    // highest-score notes kept, lowest dropped
    expect(out).toContain('**n5.md**')
    expect(out).not.toContain('**n0.md**')
    expect(out).not.toContain('THIRD')
    expect(out).not.toContain('THIRD RISK')
  })

  it('labels due dates relative to now', () => {
    const out = composeKeylessAnswer('q', [], { insights: [], risks: [risk({ due: '2000-01-01' })], world: world([]) })
    expect(out).toMatch(/overdue \d+d/)
  })

  it('surfaces an unprompted structural insight from the world rollup alone (keyless session-one)', () => {
    // Only open items in a track — no due_soon, no risks — so the old liveTracks
    // filter would hide it. The first-insight still finds something true to say.
    const out = composeKeylessAnswer('q', [], {
      insights: [],
      risks: [],
      world: world([track({ open: 4, due_soon: 0, risks: 0, next_due: null, top_risk: null, risk_list: [] })])
    })
    expect(out).toContain('One thing I already notice')
    expect(out).toMatch(/4 open items/)
    expect(out).toContain(CONNECT_AI_CTA)
  })
})

describe('computeFirstInsight', () => {
  const st = (over: Partial<KeylessEngineState>): KeylessEngineState => ({
    insights: [], risks: [], world: world([]), ...over
  })

  it('returns null when the vault is truly empty', () => {
    expect(computeFirstInsight(st({}))).toBeNull()
  })

  it('flags the most-overdue open decision when loops are supplied', () => {
    const openLoops: OpenLoop[] = [
      { id: 'owed::a', kind: 'owed', title: 'Ship v2', due: '2000-01-01' },
      { id: 'owed::b', kind: 'owed', title: 'Pick vendor', due: '2001-01-01' },
      { id: 'risk::x', kind: 'risk', title: 'not a decision' }
    ]
    const out = computeFirstInsight(st({ openLoops }))
    expect(out).toContain('2 open decisions')
    expect(out).toContain('**Ship v2**') // oldest overdue
    expect(out).toMatch(/days? past its decide-by/)
  })

  it('names the most-connected note from the graph', () => {
    const out = computeFirstInsight(
      st({
        graph: {
          nodes: [
            { id: 'n1', kind: 'outcome', label: 'Launch plan', in_degree: 5 },
            { id: 'n2', kind: 'outcome', label: 'Side note', in_degree: 1 }
          ],
          edges: [{ source: 'n1', target: 'n2', type: 'x' }]
        }
      })
    )
    expect(out).toContain('**Launch plan**')
    expect(out).toMatch(/most-connected|referenced by/)
  })

  it('calls out an orphan hub (referenced but links to none)', () => {
    const out = computeFirstInsight(
      st({
        graph: {
          nodes: [{ id: 'hub', kind: 'topic', label: 'Pricing', in_degree: 3 }],
          edges: [] // hub has no outbound edges
        }
      })
    )
    expect(out).toContain('**Pricing**')
    expect(out).toMatch(/links out to none/)
  })
})

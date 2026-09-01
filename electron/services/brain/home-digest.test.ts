import { describe, it, expect } from 'vitest'
import { buildHomeDigest, featureOf, type HomeDigestInput } from './home-digest'
import type { CausalGraph, CalibrationReport, Insight } from './types'

const CAL: CalibrationReport = {
  buckets: [],
  totals: { logged: 0, resolved: 0, hit_rate: null },
  recent: []
}

/** Graph where every id has in_degree 1 (equal centrality → equal importance). */
function graphWith(ids: string[]): CausalGraph {
  return {
    nodes: ids.map((id) => ({ id, kind: 'outcome', label: id, in_degree: 1 })),
    edges: [],
    today: '2026-07-02'
  }
}

function insight(id: string, confidence: number): Insight {
  const src = id.split('::')[1] ?? id
  return { id, type: id.startsWith('conv') ? 'tension' : 'opportunity', headline: id, why: '', sources: [src], confidence }
}

function base(over: Partial<HomeDigestInput>): HomeDigestInput {
  return {
    insights: [],
    openLoops: [],
    graph: graphWith([]),
    calibration: CAL,
    today: '2026-07-02',
    ...over
  }
}

describe('featureOf', () => {
  it('takes the id prefix before ::, or the whole id', () => {
    expect(featureOf('conv::n1')).toBe('conv')
    expect(featureOf('riskconc::北澜')).toBe('riskconc')
    expect(featureOf('decpress')).toBe('decpress') // no ::
  })
})

describe('home-digest affinity', () => {
  // conv has the higher confidence, so it leads by default.
  const insights = [insight('conv::n1', 0.7), insight('orphan::n2', 0.6)]
  const graph = graphWith(['n1', 'n2'])

  it('no affinity → ranks by base (conv first)', () => {
    const d = buildHomeDigest(base({ insights, graph }))
    expect(d.insights.map((i) => i.id)).toEqual(['conv::n1', 'orphan::n2'])
  })

  it('below AFFINITY_MIN_N → gated neutral, order unchanged despite dislikes', () => {
    const d = buildHomeDigest(
      base({ insights, graph, affinity: { conv: { pos: 0, neg: 3 } } }) // n=3 < 4
    )
    expect(d.insights.map((i) => i.id)).toEqual(['conv::n1', 'orphan::n2'])
  })

  it('above the gate → a disliked feature is demoted below a neutral one', () => {
    const d = buildHomeDigest(
      base({ insights, graph, affinity: { conv: { pos: 0, neg: 6 } } }) // n=6, useful-rate low
    )
    expect(d.insights.map((i) => i.id)).toEqual(['orphan::n2', 'conv::n1'])
  })
})

describe('home-digest person-owed', () => {
  it('surfaces owed people in Needs You with an open-count reason', () => {
    const d = buildHomeDigest(
      base({ owedPeople: [{ name: 'Zoe', org: 'Acme', open: 3, top: 'reply to Zoe' }] })
    )
    const item = d.needs.find((i) => i.subtype === 'person-owed')
    expect(item).toBeTruthy()
    expect(item).toMatchObject({ title: 'Zoe', kind: 'need', reason: '3 open', track: 'Acme' })
  })

  it('a lone heavily-owed person leads Needs You', () => {
    const d = buildHomeDigest(base({ owedPeople: [{ name: 'Max', org: '', open: 5, top: 't' }] }))
    expect(d.needs[0]?.id).toBe('person-owed::Max')
  })

  it('keeps a person-owed within the default-visible window despite overdue decisions', () => {
    // 3 overdue owed-decisions (urgency floor 0.85) + 1 lightly-owed person.
    const openLoops = [1, 2, 3].map((n) => ({
      id: `owed::d${n}`,
      kind: 'owed' as const,
      title: `Decision ${n}`,
      due: '2026-06-01' // overdue vs today 2026-07-02
    }))
    const d = buildHomeDigest(
      base({ openLoops, owedPeople: [{ name: 'Ivy', org: '', open: 1, top: 'reply' }] })
    )
    // Ivy must appear within the first 3 (the default-visible rows), not buried.
    expect(d.needs.slice(0, 3).some((n) => n.subtype === 'person-owed' && n.title === 'Ivy')).toBe(true)
  })
})

describe('home-digest returnReason', () => {
  it('leads with the top owed decision', () => {
    const d = buildHomeDigest(
      base({
        openLoops: [{ id: 'owed::d1', kind: 'owed', title: 'Sign the lease', due: '2026-06-01' }]
      })
    )
    expect(d.returnReason).toContain('Sign the lease')
    expect(d.returnReason).toMatch(/waiting on your call/)
  })

  it('phrases a person you owe in plain language', () => {
    const d = buildHomeDigest(base({ owedPeople: [{ name: 'Zoe', org: 'Acme', open: 3, top: 'reply' }] }))
    expect(d.returnReason).toContain('You still owe Zoe a reply')
  })

  it('falls back to a track to resume when nothing is owed', () => {
    const d = buildHomeDigest(
      base({ tracks: [{ key: 'k1', label: '北澜', open: 2, due_soon: 0, risks: 0, status: 'active' }] })
    )
    expect(d.returnReason).toContain('Pick back up on 北澜')
  })

  it('gives a friendly non-empty nudge for an empty vault', () => {
    const d = buildHomeDigest(base({}))
    expect(d.returnReason).toMatch(/as your brain fills/i)
    expect(d.returnReason.length).toBeGreaterThan(0)
  })
})

describe('home-digest tracks ("Jump back in")', () => {
  it('surfaces active tracks (idle filtered), most-live first, with a reason', () => {
    const d = buildHomeDigest(
      base({
        tracks: [
          { key: 'k1', label: '北澜', open: 3, due_soon: 1, risks: 2, status: 'active' },
          { key: 'k2', label: 'idle-lane', open: 0, due_soon: 0, risks: 0, status: 'idle' },
          { key: 'k3', label: 'orbis', open: 1, due_soon: 0, risks: 0, status: 'active' }
        ]
      })
    )
    expect(d.tracks.map((t) => t.label)).toEqual(['北澜', 'orbis']) // idle dropped, 北澜 more live
    expect(d.tracks[0].reason).toBe('3 open · 1 due soon · 2 risks')
    expect(d.tracks[0].tone).toBe('warning') // has risks
  })

  it('no tracks input → empty tracks', () => {
    expect(buildHomeDigest(base({})).tracks).toEqual([])
  })
})

describe('home-digest salience (novelty + decay modulators)', () => {
  const today = '2026-07-02'

  it('cold-start: no ledgers → ranks by intrinsic base (confidence), unchanged from pre-salience', () => {
    const d = buildHomeDigest(
      base({ insights: [insight('conv::a', 0.9), insight('conv::b', 0.5)], graph: graphWith(['a', 'b']), today })
    )
    expect(d.insights.map((i) => i.id)).toEqual(['conv::a', 'conv::b']) // higher confidence leads
  })

  it('novelty: a freshly first-seen insight outranks an aged-out equal one', () => {
    const d = buildHomeDigest(
      base({
        insights: [insight('conv::old', 0.7), insight('conv::new', 0.7)], // identical base
        graph: graphWith(['old', 'new']),
        today,
        firstSeen: { 'conv::old': '2026-05-01', 'conv::new': '2026-07-02' } // old aged out (>21d), new age 0
      })
    )
    expect(d.insights[0].id).toBe('conv::new')
  })

  it('decay: an insight shown on many days without action fades below an equal calm one', () => {
    const d = buildHomeDigest(
      base({
        insights: [insight('conv::nagged', 0.7), insight('conv::calm', 0.7)], // identical base
        graph: graphWith(['nagged', 'calm']),
        today,
        firstSeen: { 'conv::nagged': today, 'conv::calm': today }, // equal novelty
        impressions: { 'conv::nagged': 12 } // past the grace window → decayed; calm 0 → 1.0
      })
    )
    expect(d.insights[0].id).toBe('conv::calm')
  })

  it('unknown id is treated as brand-new (peak novelty) — it does not distort the base order', () => {
    const d = buildHomeDigest(
      base({
        insights: [insight('conv::known', 0.6), insight('conv::unknown', 0.7)],
        graph: graphWith(['known', 'unknown']),
        today,
        firstSeen: { 'conv::known': today } // known age-0 (peak); unknown absent → also peak
      })
    )
    // Both at peak novelty ⇒ the higher-confidence unknown leads (uniform novelty preserves order).
    expect(d.insights.map((i) => i.id)).toEqual(['conv::unknown', 'conv::known'])
  })
})

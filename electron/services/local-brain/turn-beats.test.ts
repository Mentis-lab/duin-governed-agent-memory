import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readBeats,
  writeBeat,
  gradeBeat,
  aggregateTurnBeats,
  loadTurnBeatRate,
  buildBeatPrompt,
  parseBeatResponse,
  turnBeatTick,
  gradeStagedTurnBeat,
  turnBeatsEnabled,
  beatsToScored,
  scoreTurnBeats,
  recalibrateScored,
  turnBeatReport,
  __resetTurnBeats,
  type TurnBeat,
  type BeatGrounding
} from './turn-beats'
import type { ScoredForecast } from '../brain/calibration-scoring'

// Cold-start A3 emptied the BUILT-IN ontology tracks (they were one operator's real lanes), so
// the beat predictor's track vocabulary is whatever the caller passes — server.ts passes the
// VAULT's. This suite declares its own, which is what the vocabulary genuinely is now; deriving it
// from `DEFAULT_ONTOLOGY` would silently reduce every case to an empty key set.
const TRACKS = [
  { key: 'alpha', match: /alpha/i },
  { key: 'beta', match: /\bbeta\b/i },
  { key: 'gamma', match: /gamma/i }
]
const trackKeys = TRACKS.map((t) => t.key)
const trackOf = (text: string): string | null => TRACKS.find((t) => t.match.test(text))?.key ?? null

const beat = (over: Partial<TurnBeat> = {}): TurnBeat => ({
  id: 'b1',
  threadId: 't1',
  turnIndex: 1,
  created: 0,
  predicted_track: 'alpha',
  predicted_action_class: 'ask-followup',
  next_beat: 'they ask about the channel launch',
  confidence: 0.6,
  baseline_track: 'alpha',
  ...over
})

const grounding = (over: Partial<BeatGrounding> = {}): BeatGrounding => ({
  goalsText: 'Track 1: alpha BD. Track 2: beta M&A.',
  recentTurns: [{ role: 'user', content: 'alpha channel progress update' }],
  operatorFacts: [{ fact: 'prefers conclusion-first' }],
  currentTrack: 'alpha',
  trackKeys,
  ...over
})

describe('gradeBeat (pure scorer)', () => {
  it('hit when predicted_track === actual_track', () => {
    const g = gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'beta' }), 'alpha')
    expect(g.hit).toBe(true)
    expect(g.baseline_hit).toBe(false)
    expect(g.graded).toBe(true)
    expect(g.actual_track).toBe('alpha')
  })
  it('miss when predicted diverges; baseline hits when it stayed', () => {
    const g = gradeBeat(beat({ predicted_track: 'gamma', baseline_track: 'alpha' }), 'alpha')
    expect(g.hit).toBe(false)
    expect(g.baseline_hit).toBe(true)
  })
  it('null actual_track: both null-predictions hit', () => {
    const g = gradeBeat(beat({ predicted_track: null, baseline_track: null }), null)
    expect(g.hit).toBe(true)
    expect(g.baseline_hit).toBe(true)
  })
})

describe('aggregateTurnBeats + gating', () => {
  it('per-outcome counts + hit-rate + baseline-rate over graded beats only', () => {
    const beats = [
      gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha' }), 'alpha'), // hit + base-hit
      gradeBeat(beat({ predicted_track: 'gamma', baseline_track: 'alpha' }), 'beta'), // miss + base-miss
      gradeBeat(beat({ predicted_track: 'beta', baseline_track: 'alpha' }), 'beta'), // hit + base-miss
      beat({ graded: false }) // ungraded → ignored
    ]
    const agg = aggregateTurnBeats(beats)
    expect(agg.observed).toBe(3)
    expect(agg.hits).toBe(2)
    expect(agg.misses).toBe(1)
    expect(agg.baselineHits).toBe(1)
    expect(agg.hitRate).toBeCloseTo(2 / 3)
    expect(agg.baselineRate).toBeCloseTo(1 / 3)
  })
  it('gates below minN (CAL_MIN_N=20 default), ungates at/above', () => {
    const thin = Array.from({ length: 19 }, () => gradeBeat(beat(), 'alpha'))
    expect(aggregateTurnBeats(thin).gated).toBe(true)
    const enough = Array.from({ length: 20 }, () => gradeBeat(beat(), 'alpha'))
    expect(aggregateTurnBeats(enough).gated).toBe(false)
  })
  it('respects a custom minN', () => {
    const beats = Array.from({ length: 3 }, () => gradeBeat(beat(), 'alpha'))
    expect(aggregateTurnBeats(beats, 2).gated).toBe(false)
  })
  it('empty → null rates, gated', () => {
    const agg = aggregateTurnBeats([])
    expect(agg.hitRate).toBeNull()
    expect(agg.baselineRate).toBeNull()
    expect(agg.gated).toBe(true)
  })
})

describe('ledger persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-beats-'))
    __resetTurnBeats()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('write → read roundtrip, append-only jsonl', () => {
    writeBeat(dir, gradeBeat(beat({ id: 'a' }), 'alpha'))
    writeBeat(dir, gradeBeat(beat({ id: 'b' }), 'beta'))
    const rows = readBeats(dir)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    const raw = readFileSync(join(dir, '.duin', '_state', 'turn-beats.jsonl'), 'utf-8').trim().split('\n')
    expect(raw).toHaveLength(2)
  })
  it('null vaultDir is a no-op (never throws, writes nothing)', () => {
    expect(() => writeBeat(null, gradeBeat(beat(), 'alpha'))).not.toThrow()
    expect(readBeats(null)).toEqual([])
  })
  it('loadTurnBeatRate aggregates from disk', () => {
    writeBeat(dir, gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha' }), 'alpha'))
    const r = loadTurnBeatRate(dir, 1)
    expect(r.observed).toBe(1)
    expect(r.hitRate).toBe(1)
    expect(r.gated).toBe(false)
  })
})

describe('buildBeatPrompt / parseBeatResponse (pure)', () => {
  it('prompt carries track keys, current track, dumped goals + facts, recent turns', () => {
    const msgs = buildBeatPrompt(grounding())
    expect(msgs[0].role).toBe('system')
    const user = msgs[1].content
    expect(user).toContain('alpha') // current track + track keys
    expect(user).toContain('Track 1: alpha BD') // goals dumped
    expect(user).toContain('prefers conclusion-first') // operator fact
    expect(user).toContain('channel progress') // recent turn
  })
  it('parses valid JSON, normalizes track to a known key', () => {
    const p = parseBeatResponse('{"predicted_track":"alpha","predicted_action_class":"decide","next_beat":"x","confidence":0.7}', trackKeys)
    expect(p).not.toBeNull()
    expect(p!.predicted_track).toBe('alpha')
    expect(p!.confidence).toBeCloseTo(0.7)
  })
  it('unknown / none / null track → null; confidence clamped', () => {
    expect(parseBeatResponse('{"predicted_track":"nonsense-key","confidence":5}', trackKeys)!.predicted_track).toBeNull()
    expect(parseBeatResponse('{"predicted_track":"none"}', trackKeys)!.predicted_track).toBeNull()
    expect(parseBeatResponse('{"predicted_track":"alpha","confidence":5}', trackKeys)!.confidence).toBe(1)
  })
  it('non-JSON / empty → null', () => {
    expect(parseBeatResponse('no json here', trackKeys)).toBeNull()
    expect(parseBeatResponse(null, trackKeys)).toBeNull()
  })
})

describe('turnBeatTick + gradeStagedTurnBeat (stage→grade, recall-efficacy mirror)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-beats-tick-'))
    __resetTurnBeats()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const okModel = (track: string) => async () =>
    JSON.stringify({ predicted_track: track, predicted_action_class: 'ask-followup', next_beat: 'n', confidence: 0.8 })

  it('stages on turn N (no file yet), grades + persists on turn N+1', async () => {
    // Turn N: predict alpha continues. Nothing is graded/persisted yet.
    const staged = await turnBeatTick({ vaultDir: dir, threadId: 't1', turnIndex: 1, grounding: grounding({ currentTrack: 'alpha' }), runModel: okModel('alpha') })
    expect(staged).not.toBeNull()
    expect(staged!.predicted_track).toBe('alpha')
    expect(staged!.baseline_track).toBe('alpha')
    expect(existsSync(join(dir, '.duin', '_state', 'turn-beats.jsonl'))).toBe(false) // nothing persisted at stage

    // Turn N+1: actual query stays on alpha → predictor hit AND baseline hit.
    const actual = trackOf('alpha launch timing') // → alpha
    const graded = gradeStagedTurnBeat(dir, 't1', actual)
    expect(graded!.hit).toBe(true)
    expect(graded!.baseline_hit).toBe(true)
    const rows = readBeats(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0].graded).toBe(true)
  })

  it('predictor beats baseline: predicts the switch the baseline misses', async () => {
    // Turn N is on alpha, but the model predicts a switch to beta.
    await turnBeatTick({ vaultDir: dir, threadId: 't2', turnIndex: 1, grounding: grounding({ currentTrack: 'alpha' }), runModel: okModel('beta') })
    const actual = trackOf('beta biweekly progress') // → beta
    const graded = gradeStagedTurnBeat(dir, 't2', actual)
    expect(graded!.hit).toBe(true) // predicted the switch
    expect(graded!.baseline_hit).toBe(false) // "stay on alpha" missed
  })

  it('threads are isolated (grading tb does not consume ta)', async () => {
    await turnBeatTick({ vaultDir: dir, threadId: 'ta', turnIndex: 1, grounding: grounding(), runModel: okModel('alpha') })
    // Grading a DIFFERENT thread writes nothing and leaves ta staged.
    expect(gradeStagedTurnBeat(dir, 'tb', 'beta')).toBeNull()
    expect(readBeats(dir)).toEqual([])
    // ta is still gradeable.
    expect(gradeStagedTurnBeat(dir, 'ta', 'alpha')!.hit).toBe(true)
  })

  it('keyless / null model → NO beat staged, no throw', async () => {
    const nullModel = async () => null
    const r = await turnBeatTick({ vaultDir: dir, threadId: 't3', turnIndex: 1, grounding: grounding(), runModel: nullModel })
    expect(r).toBeNull()
    expect(gradeStagedTurnBeat(dir, 't3', 'alpha')).toBeNull() // nothing was staged
    expect(existsSync(join(dir, '.duin', '_state', 'turn-beats.jsonl'))).toBe(false)
  })

  it('grade with no staged beat → null (no crash, no file)', () => {
    expect(gradeStagedTurnBeat(dir, 'never-staged', 'alpha')).toBeNull()
    expect(existsSync(join(dir, '.duin', '_state', 'turn-beats.jsonl'))).toBe(false)
  })
})

describe('kill-switch: DUIN_TURN_BEATS default ON (Phase-1 flip); "0"/"false"/"off" == explicit OFF', () => {
  let dir: string
  const prev = process.env.DUIN_TURN_BEATS
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-beats-off-'))
    __resetTurnBeats()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.DUIN_TURN_BEATS
    else process.env.DUIN_TURN_BEATS = prev
    rmSync(dir, { recursive: true, force: true })
  })

  // Mirror the EXACT guard server.ts wraps every turn-beat call in.
  async function guardedTurn(): Promise<void> {
    if (turnBeatsEnabled()) {
      await turnBeatTick({
        vaultDir: dir,
        threadId: 't1',
        turnIndex: 1,
        grounding: grounding(),
        runModel: async () => JSON.stringify({ predicted_track: 'alpha', confidence: 0.9 })
      })
      gradeStagedTurnBeat(dir, 't1', trackOf('alpha'))
    }
  }

  it('unset → gate TRUE (default ON) → the guarded turn stages + grades a beat', async () => {
    delete process.env.DUIN_TURN_BEATS
    expect(turnBeatsEnabled()).toBe(true)
    await guardedTurn()
    expect(readBeats(dir)).toHaveLength(1)
  })

  it('explicit "0" / "false" / "off" → gate false → guarded turn is fully inert (no file)', async () => {
    for (const off of ['0', 'false', 'OFF']) {
      process.env.DUIN_TURN_BEATS = off
      expect(turnBeatsEnabled()).toBe(false)
    }
    await guardedTurn()
    expect(existsSync(join(dir, '.duin', '_state', 'turn-beats.jsonl'))).toBe(false)
  })

  it('any other value (incl. "1", "") → gate true', async () => {
    process.env.DUIN_TURN_BEATS = '1'
    expect(turnBeatsEnabled()).toBe(true)
    process.env.DUIN_TURN_BEATS = ''
    expect(turnBeatsEnabled()).toBe(true)
    await guardedTurn()
    expect(readBeats(dir)).toHaveLength(1)
  })
})

describe('scoreTurnBeats — proper Brier over confidence (Phase-1 A1 moat instrument)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-beats-score-'))
    __resetTurnBeats()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('beatsToScored maps graded beats → (confidence, hit-outcome); ungraded excluded', () => {
    const scored = beatsToScored([
      gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha', confidence: 0.8 }), 'alpha'), // hit → outcome 1
      gradeBeat(beat({ predicted_track: 'gamma', baseline_track: 'alpha', confidence: 0.6 }), 'beta'), // miss → outcome 0
      beat({ graded: false, confidence: 0.9 }) // ungraded → excluded
    ])
    expect(scored).toEqual([
      { confidence: 0.8, outcome: 1 },
      { confidence: 0.6, outcome: 0 }
    ])
  })

  it('computes a real Brier from the beat ledger (mean (conf - hit)^2)', () => {
    // Two beats: 0.8 conf & hit, 0.6 conf & miss → Brier = ((0.8-1)^2 + (0.6-0)^2)/2 = (0.04+0.36)/2 = 0.20
    writeBeat(dir, gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha', confidence: 0.8 }), 'alpha'))
    writeBeat(dir, gradeBeat(beat({ predicted_track: 'gamma', baseline_track: 'alpha', confidence: 0.6 }), 'beta'))
    const s = scoreTurnBeats(dir, 1)
    expect(s.calibration.n).toBe(2)
    expect(s.calibration.brier).toBeCloseTo(0.2)
    expect(s.trackMatch.observed).toBe(2)
    expect(s.trackMatch.hits).toBe(1)
  })

  it('empty ledger → null Brier, null rates (honest n=0)', () => {
    const s = scoreTurnBeats(dir)
    expect(s.calibration.n).toBe(0)
    expect(s.calibration.brier).toBeNull()
    expect(s.trackMatch.hitRate).toBeNull()
  })

  it('skillScore gated below minN, present at/above (same discipline as forecast score)', () => {
    for (let i = 0; i < 25; i++) writeBeat(dir, gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha', confidence: 0.7 }), i % 3 === 0 ? 'beta' : 'alpha'))
    expect(scoreTurnBeats(dir, 20).calibration.skillScore).not.toBeNull()
    expect(scoreTurnBeats(dir, 40).calibration.skillScore).toBeNull()
  })
})

describe('recalibrateScored — leakage-free over-confidence repair (Phase-1 A5)', () => {
  // 40 beats stated at HIGH confidence (0.9) but right only ~40% → overconfident, skill < 0.
  const overconfident: ScoredForecast[] = Array.from({ length: 40 }, (_, i) => ({
    confidence: 0.9,
    outcome: i % 5 < 2 ? 1 : 0 // 2 of every 5 hit → base rate 0.4
  }))

  it('below minN → identity (recalibrated === raw, no params)', () => {
    const r = recalibrateScored(overconfident.slice(0, 10), 20)
    expect(r.params).toBeNull()
    expect(r.improves).toBe(false)
    expect(r.recalibrated).toEqual(r.raw)
  })

  it('overconfident stream: fit SHRINKS (a<1) and LOO recalibration lowers Brier (skill up)', () => {
    const r = recalibrateScored(overconfident, 20)
    expect(r.raw.skillScore).toBeLessThan(0) // sub-baseline before
    expect(r.params!.a).toBeLessThan(1) // the fix is shrinkage toward base rate, NOT extremization
    expect(r.recalibrated.brier!).toBeLessThan(r.raw.brier!) // leakage-free improvement
    expect(r.improves).toBe(true)
    expect(r.recalibrated.skillScore!).toBeGreaterThan(r.raw.skillScore!)
  })

  it('turnBeatReport bundles trackMatch + calibration + recalibration from one read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-beats-report-'))
    try {
      for (let i = 0; i < 25; i++) writeBeat(dir, gradeBeat(beat({ predicted_track: 'alpha', baseline_track: 'alpha', confidence: 0.9 }), i % 5 < 2 ? 'alpha' : 'beta'))
      const rep = turnBeatReport(dir, 20)
      expect(rep.trackMatch.observed).toBe(25)
      expect(rep.calibration.n).toBe(25)
      expect(rep.recalibration.n).toBe(25)
      expect(rep.recalibration.params!.a).toBeLessThan(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

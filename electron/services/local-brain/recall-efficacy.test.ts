import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  aggregateEfficacy,
  loadRecallEfficacy,
  readObservations,
  recordRecallOutcome,
  recallEfficacyFitness,
  classifyOutcome,
  stageRecalledKinds,
  recallEfficacyTick,
  captureTurnBoundary,
  __resetRecallEfficacy,
  type RecallObservation
} from './recall-efficacy'
import { runCaptureHook, __resetCaptureMemo } from '../capture-hook'

// NETWORK GUARD — not optional hygiene, a data-integrity guard.
//
// recallEfficacyTick now fires Learn's capture arrow, and that arrow POSTs to
// DUIN_BRAIN_URL (default http://127.0.0.1:8799/learn/correction). The operator's LIVE brain
// listens on exactly that port on the dev machine, so an unstubbed suite run would append
// fabricated corrections — 'yes, exactly right', "no, that's wrong…" — straight into the real
// corrections.jsonl that feeds calibration and the RSI fitness engines. Every test in this file
// therefore runs with fetch stubbed, and `posted` collects what capture TRIED to send.
let posted: { url: string; body: Record<string, unknown> }[] = []
beforeEach(() => {
  posted = []
  __resetCaptureMemo()
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
    return { ok: true, status: 200 }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Let the fire-and-forget capture POST settle before asserting on it. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const obs = (kind: string, useful: 0 | 1, ts = 0): RecallObservation => ({ ts, kind, useful })

describe('aggregateEfficacy', () => {
  it('rate = useful/observed per kind', () => {
    const m = aggregateEfficacy([obs('preference', 1), obs('preference', 1), obs('preference', 0), obs('context', 0)])
    expect(m.get('preference')!.rate).toBeCloseTo(2 / 3)
    expect(m.get('preference')!.observed).toBe(3)
    expect(m.get('context')!.rate).toBe(0)
  })

  it('gates a kind below min_n (CAL_MIN_N=20 default)', () => {
    const many = Array.from({ length: 25 }, () => obs('preference', 1))
    const few = Array.from({ length: 19 }, () => obs('context', 1))
    const m = aggregateEfficacy([...many, ...few])
    expect(m.get('preference')!.gated).toBe(false) // 25 ≥ 20
    expect(m.get('context')!.gated).toBe(true) //   19 < 20
  })

  it('respects a custom minN', () => {
    const m = aggregateEfficacy([obs('k', 1), obs('k', 1), obs('k', 0)], 2)
    expect(m.get('k')!.gated).toBe(false) // 3 ≥ 2
  })

  it('empty → empty map', () => {
    expect(aggregateEfficacy([]).size).toBe(0)
  })
})

describe('classifyOutcome', () => {
  it('positive on endorsement of the prior answer', () => {
    expect(classifyOutcome('some prior answer', 'yes, perfect')).toBe('positive')
  })
  it('negative on a correction of the prior answer', () => {
    expect(classifyOutcome('some prior answer', "no, that's wrong — instead do X because it reads better")).toBe('negative')
  })
  it('null on a neutral follow-up (no signal)', () => {
    expect(classifyOutcome('some prior answer', 'now draft the second section')).toBeNull()
  })
})

// ──────────────────── language parity — the ledger's most dangerous failure ────────────────────
// This ledger feeds β_conf calibration and the RSI fitness engines, so a ONE-DIRECTIONAL bias
// here is worse than no ledger at all. The positive arm (`isEndorsement`) has always been
// bilingual; the negative arm (`detectCorrection`) was ASCII-only, so a Chinese session wrote
// only useful=1 rows and calibration learned that every recall kind was working. Each pair below
// is the same operator judgment in two scripts and MUST grade identically. Reverting the CJK
// alternations in capture-hook.ts turns these red — that is the point of pinning them here.
describe('classifyOutcome — language parity (praise and criticism must be heard in the same languages)', () => {
  const PRIOR_ZH = '《北澜》二测时间点是 8–10 月，约 2 万人级别测试。'
  const PRIOR_EN = 'The second beta window is August–October, roughly a 20k-player test.'

  const PAIRS: { name: string; zh: string; en: string; expected: 'positive' | 'negative' }[] = [
    {
      name: 'negation + corrected value + standing rule',
      zh: '不对，你说错了。二测应该是 2026 年 8 月，不是你说的时间。以后回答这类问题请先查 OKR Tracker 再回答。',
      en: "No, you're wrong. The second beta should be August 2026, not the date you gave. From now on check the OKR Tracker before answering this kind of question.",
      expected: 'negative'
    },
    {
      name: 'blunt negation + rule',
      zh: '错了。以后请先查 OKR Tracker 再回答。',
      en: 'Wrong. From now on check the OKR Tracker before you answer.',
      expected: 'negative'
    },
    {
      name: 'should-be correction with a reason',
      zh: '应该是 2026 年 8 月，因为发行档期定在暑期。',
      en: 'It should be August 2026, because the release window is set for the summer.',
      expected: 'negative'
    },
    {
      name: 'standing rule',
      zh: '以后所有双周报都要先写风险。',
      en: 'From now on every biweekly report should lead with risks.',
      expected: 'negative'
    },
    { name: 'endorsement', zh: '对，就是这样', en: 'Yes, exactly', expected: 'positive' },
    {
      // The asymmetry that survives a bilingual detectCorrection: this turn is BOTH an
      // endorsement and an override, and `isEndorsement` used to answer first. Its NEGATION
      // list has no 不过, so the Chinese turn scored useful=1 while the English one — whose
      // "but" that list does carry — scored useful=0. Same judgment, opposite sign.
      name: 'endorsement that carries an override (correction must win, in both scripts)',
      zh: '对，就是这样，不过以后请先查 OKR Tracker 再回答。',
      en: 'Right, exactly — but from now on check the OKR Tracker first.',
      expected: 'negative'
    }
  ]

  for (const p of PAIRS) {
    it(`grades both scripts the same — ${p.name}`, () => {
      const zh = classifyOutcome(PRIOR_ZH, p.zh)
      const en = classifyOutcome(PRIOR_EN, p.en)
      // Asserted against the EXPECTED value, not merely against each other: two nulls would
      // satisfy equality while the loop stayed deaf in both languages.
      expect(zh, `ZH graded ${zh} — the ledger is one-directional`).toBe(p.expected)
      expect(en, `EN graded ${en}`).toBe(p.expected)
      expect(zh).toBe(en)
    })
  }

  it('still records nothing for a neutral follow-up in either script', () => {
    expect(classifyOutcome(PRIOR_ZH, '再写一版更短的')).toBeNull()
    expect(classifyOutcome(PRIOR_EN, 'now draft a shorter version')).toBeNull()
  })
})

describe('recall-efficacy persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recall-eff-'))
    __resetRecallEfficacy()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('write → read roundtrip (dedupes kinds within a turn, one line each)', () => {
    recordRecallOutcome(dir, ['preference', 'preference', 'context'], true)
    const rows = readObservations(dir)
    expect(rows).toHaveLength(2) // preference deduped
    expect(rows.every((r) => r.useful === 1)).toBe(true)
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['preference', 'context']))
  })

  it('null vaultDir / empty kinds are no-ops (never throws, writes nothing)', () => {
    expect(() => recordRecallOutcome(null, ['preference'], true)).not.toThrow()
    expect(() => recordRecallOutcome(dir, [], true)).not.toThrow()
    expect(readObservations(dir)).toEqual([])
    expect(readObservations(null)).toEqual([])
  })

  it('loadRecallEfficacy gates a thin kind, scores an observed one', () => {
    for (let i = 0; i < 20; i++) recordRecallOutcome(dir, ['preference'], i < 15) // 15/20 useful
    recordRecallOutcome(dir, ['context'], true) // 1 obs → gated
    const m = loadRecallEfficacy(dir)
    expect(m.get('preference')!.gated).toBe(false)
    expect(m.get('preference')!.rate).toBeCloseTo(15 / 20)
    expect(m.get('context')!.gated).toBe(true)
  })

  it('append-only: a second turn adds to the ledger, does not overwrite', () => {
    recordRecallOutcome(dir, ['preference'], true)
    recordRecallOutcome(dir, ['preference'], false)
    expect(readObservations(dir)).toHaveLength(2)
    // sanity: the file is real jsonl on disk
    const raw = readFileSync(join(dir, '.duin', '_state', 'recall-efficacy.jsonl'), 'utf-8').trim().split('\n')
    expect(raw).toHaveLength(2)
  })
})

describe('recallEfficacyTick (per-thread attribution, successTick mirror)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recall-tick-'))
    __resetRecallEfficacy()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('grades the PRIOR turn kinds by THIS turn endorsement', () => {
    // Turn N: recall injected a `preference` fact.
    stageRecalledKinds('t1', ['preference'])
    const g1 = recallEfficacyTick(dir, 't1', 'question N', 'answer N', true) // no prior yet
    expect(g1).toBeNull()
    expect(readObservations(dir)).toEqual([])

    // Turn N+1: user endorses answer N.
    stageRecalledKinds('t1', ['context'])
    const g2 = recallEfficacyTick(dir, 't1', 'yes, exactly right', 'answer N+1', true)
    expect(g2).toBe('positive')
    const rows = readObservations(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'preference', useful: 1 })
  })

  it('grades a correction as a NEGATIVE observation on the prior kinds', () => {
    stageRecalledKinds('t2', ['correction', 'failure'])
    recallEfficacyTick(dir, 't2', 'first question', 'first answer', true)
    recallEfficacyTick(dir, 't2', "no, that's wrong, instead avoid that framing because it misleads", 'second answer', true)
    const rows = readObservations(dir)
    expect(rows).toHaveLength(2) // correction + failure both graded
    expect(rows.every((r) => r.useful === 0)).toBe(true)
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['correction', 'failure']))
  })

  it('records nothing on a neutral follow-up', () => {
    stageRecalledKinds('t3', ['preference'])
    recallEfficacyTick(dir, 't3', 'q', 'a', true)
    recallEfficacyTick(dir, 't3', 'now do the next part please', 'a2', true)
    expect(readObservations(dir)).toEqual([])
  })

  it('threads are isolated (no cross-thread grading)', () => {
    stageRecalledKinds('ta', ['preference'])
    recallEfficacyTick(dir, 'ta', 'q', 'a', true) // prior for ta
    // A different thread endorses — must NOT grade ta's kinds.
    recallEfficacyTick(dir, 'tb', 'yes perfect', 'b', true)
    expect(readObservations(dir)).toEqual([])
  })

  it('does NOT roll a stranded turn\'s staged kinds forward after its tick was skipped', () => {
    // Turn N grounds-and-stages, stamped with turn N's user message, then RUN_ERROR/deadline/
    // disconnect fires: recallEfficacyTick never runs, so the staged slot survives. (This is the
    // bug: the tick is the only consumer/deleter of the inflight slot; a skipped tick strands it.)
    stageRecalledKinds('terr', ['preference', 'failure'], 'msg N')

    // Turn N+1 is recall-free (stages nothing) and carries a DIFFERENT user message. Its tick must
    // discard the stale slot instead of adopting it as N+1's prior — the turnKey no longer matches.
    const g1 = recallEfficacyTick(dir, 'terr', 'thanks', 'answer N+1', true)
    expect(g1).toBeNull()

    // Turn N+2 endorses answer N+1. Pre-fix, the stranded ['preference','failure'] would have been
    // rolled forward as N+1's prior and this endorsement would append two FABRICATED useful=1 rows.
    const g2 = recallEfficacyTick(dir, 'terr', 'yes exactly', 'answer N+2', true)
    expect(g2).toBeNull() // N+1 had no staged kinds of its own → nothing to grade
    expect(readObservations(dir)).toEqual([])
  })
})

// THE POINT OF THE SEAM. Before this, `runCaptureHook` had ONE call site — electron/ipc/chat.ts,
// the renderer IPC seam — so a correction typed into the desktop window entered the learn ledger
// and the identical correction arriving over a channel, a headless run or a CRON turn did not.
// Every origin reaches the brain through /agui, and this tick is what /agui already calls.
describe('captureTurnBoundary — Learn hears the UNATTENDED turn (headless / channel / CRON)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recall-cap-'))
    __resetRecallEfficacy()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a channel-originated correction on /agui reaches the learn loop', async () => {
    // Turn N over a non-renderer origin: the brain answers, nothing to grade yet.
    recallEfficacyTick(dir, 'cron-thread', '北澜二测是什么时候？', '《北澜》二测时间点是 8–10 月。', true)
    expect(posted).toHaveLength(0)

    // Turn N+1: a TRUSTED sender corrects that answer. This turn never touches ipc/chat.ts.
    // (Called 'the operator' here until 2026-08-04 — that wording was the trust conflation
    //  itself: this path also carries channel and CRON turns, which are NOT the operator.)
    recallEfficacyTick(
      dir,
      'cron-thread',
      '不对，你说错了。二测应该是 2026 年 8 月。以后回答这类问题请先查 OKR Tracker 再回答。',
      '收到，已更正。',
      true
    )
    await settle()

    expect(posted, 'the /agui turn produced no capture at all').toHaveLength(1)
    expect(posted[0].url).toMatch(/\/learn\/correction$/)
    expect(posted[0].body.polarity).toBe('correction')
    // It must react to the PRIOR answer, not to this turn's own reply.
    expect(String(posted[0].body.ai_output)).toContain('8–10 月')
    expect('source' in posted[0].body).toBe(false) // operator-only stream
  })

  // INGESTION TRUST — the gate, not a tag.
  //
  // Moving capture onto the /agui tick made Learn hear channel, headless and CRON turns, which
  // was the point. It also made it unable to tell WHOSE turn it was: the sibling call four lines
  // above in server.ts (`learnFromTurn(query, answer, execOk)`) had carried the trust tier all
  // along and this path had not. Channel adapters send `execToken: null` deliberately, so a
  // de-privileged sender could write the operator-only corrections stream — and an endorsement
  // on that path mints an operator-sourced fact that autoPromoteCandidates advances.
  //
  // It has to be a GATE rather than a weaker tier because appendCorrection THROWS on a row
  // carrying `source`: the file has no representation for a non-operator row.
  //
  // Reverting the `if (!trusted) return` in captureTurnBoundary turns this red.
  it('an UNTRUSTED turn is never captured, however correction-shaped it is', async () => {
    // Turn N over a de-privileged origin (execOk=false — what a channel adapter produces).
    recallEfficacyTick(dir, 'tg:99887766', '北澜二测是什么时候？', '《北澜》二测时间点是 8–10 月。', false)
    // Turn N+1 is unambiguously a correction WITH a standing rule — the exact shape that
    // captures on the trusted path — so a pass here cannot be the detector simply not firing.
    recallEfficacyTick(
      dir,
      'tg:99887766',
      '不对，你说错了。二测应该是 2026 年 8 月。以后回答这类问题请先查 OKR Tracker 再回答。',
      '收到，已更正。',
      false
    )
    await settle()
    expect(posted, 'a de-privileged turn wrote into the operator-only corrections stream').toHaveLength(0)

    // Control: the identical exchange on a TRUSTED thread does capture, so the assertion above
    // is about trust and not about the input.
    recallEfficacyTick(dir, 'renderer-1', '北澜二测是什么时候？', '《北澜》二测时间点是 8–10 月。', true)
    recallEfficacyTick(
      dir,
      'renderer-1',
      '不对，你说错了。二测应该是 2026 年 8 月。以后回答这类问题请先查 OKR Tracker 再回答。',
      '收到，已更正。',
      true
    )
    await settle()
    expect(posted, 'the trusted control must still capture').toHaveLength(1)
  })

  it('a neutral follow-up on /agui captures nothing', async () => {
    recallEfficacyTick(dir, 'th-neutral', 'q', 'an answer', true)
    recallEfficacyTick(dir, 'th-neutral', 'now do the next part please', 'a2', true)
    await settle()
    expect(posted).toHaveLength(0)
  })

  // The exported entry point exists so the coupling noted on captureTurnBoundary can be undone in
  // ONE line: server.ts should call this directly, OUTSIDE `if (recallCalEnabled())`, so a
  // retrieval-calibration kill-switch can never silence learning capture. Held to the contract here.
  it('captureTurnBoundary fires standalone, and is a no-op with no prior answer to react to', async () => {
    captureTurnBoundary('fresh-thread', 'no, that is wrong, because the tracker says otherwise', true)
    await settle()
    expect(posted, 'captured a reaction to an answer that was never given').toHaveLength(0)

    recallEfficacyTick(dir, 'fresh-thread', 'q', 'The window is August to October.', true)
    captureTurnBoundary('fresh-thread', 'no, that is wrong, because the tracker says otherwise', true)
    await settle()
    expect(posted).toHaveLength(1)
  })

  // ONE TURN, ONE ROW. A renderer turn crosses BOTH seams — ipc/chat.ts fires before the turn
  // runs, the /agui tick fires after the answer completes — and both live in the electron main
  // process. Without the guard this widening would double-count every renderer correction and
  // one-directionally inflate the ledger that feeds calibration and the RSI fitness engines.
  it('a RENDERER turn crossing both seams produces exactly ONE row, not two', async () => {
    const prior = 'The second test window is August to October.'
    const userMsg =
      "No, that's wrong — it should be August 2026, because the OKR tracker is the source of truth. From now on check the tracker first."

    // Seam 1: ipc/chat.ts fires with the conversation id, reading the prior answer from convStore.
    await runCaptureHook(prior, userMsg, { session: 'conv-42' })
    expect(posted, 'the renderer seam itself stopped working').toHaveLength(1)

    // Seam 2: the same turn completes on /agui and its tick fires with the thread id. The two seams
    // label `session` differently and read `ai_output` from different stores, so the guard keys on
    // the operator's turn text — the one thing they provably share.
    recallEfficacyTick(dir, 'conv-42', 'earlier question', prior, true)
    recallEfficacyTick(dir, 'conv-42', userMsg, 'Understood, corrected.', true)
    await settle()

    expect(posted, 'the renderer turn was captured twice').toHaveLength(1)
  })
})

describe('recallEfficacyFitness — per-kind RSI fitness engines (the Apply.RSI P1 mapping)', () => {
  let v: string
  const ledger = (rows: RecallObservation[]) => {
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'recall-efficacy.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  beforeEach(() => { v = mkdtempSync(join(tmpdir(), 'recall-fit-')) })
  afterEach(() => { try { rmSync(v, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('projects each kind as recall-efficacy:<kind> with a Wilson-lo score, n, gated', () => {
    ledger([
      ...Array.from({ length: 25 }, (_, i) => obs('named-skill', 1, 1000 + i)), // n≥CAL_MIN_N
      ...Array.from({ length: 5 }, (_, i) => obs('failure', 0, 1000 + i)), // gated
    ])
    const eng = recallEfficacyFitness(v)
    const ns = eng.find((e) => e.engine === 'recall-efficacy:named-skill')!
    const fa = eng.find((e) => e.engine === 'recall-efficacy:failure')!
    expect(ns.n).toBe(25)
    expect(ns.gated).toBe(false)
    expect(ns.score).toBeGreaterThan(0) // Wilson-lo of 25/25 useful
    expect(fa.n).toBe(5)
    expect(fa.gated).toBe(true) // 5 < CAL_MIN_N → not yet a trustworthy engine
  })

  it('windows by [since, until) ISO dates — the free temporal held-out an A/B needs', () => {
    ledger([
      obs('failure', 1, Date.parse('2026-07-01T00:00:00Z')), // before since → excluded
      obs('failure', 1, Date.parse('2026-07-10T00:00:00Z')), // in window
      obs('failure', 0, Date.parse('2026-07-20T00:00:00Z')), // at/after until → excluded
    ])
    const fa = recallEfficacyFitness(v, '2026-07-05T00:00:00Z', '2026-07-15T00:00:00Z')
      .find((e) => e.engine === 'recall-efficacy:failure')!
    expect(fa.n).toBe(1) // only the in-window observation counts
  })

  it('empty ledger / null vault → no engines', () => {
    expect(recallEfficacyFitness(v)).toEqual([])
    expect(recallEfficacyFitness(null)).toEqual([])
  })
})

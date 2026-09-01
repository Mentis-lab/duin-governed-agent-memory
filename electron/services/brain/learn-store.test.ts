import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendCorrection, runReflect } from './learn-store'
import { loadCorrections } from './learn-native'

describe('learn-store', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ls-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('appendCorrection writes an operator row with status:new + returns total', () => {
    const out = appendCorrection(vault, { skill: 'feishu', why: 'w', candidate_rule: 'r' }, new Date('2026-07-01T00:00:00Z'))
    expect(out).toEqual({ ok: true, total: 1 })
    const rec = JSON.parse(readFileSync(join(sd, 'corrections.jsonl'), 'utf-8').trim())
    expect(rec).toMatchObject({ skill: 'feishu', why: 'w', candidate_rule: 'r', polarity: 'correction', status: 'new', ts: '2026-07-01' })
  })

  // THE LEARN LOOP'S CLOSURE. A confirmed binding asserts "this theme will not recur"; a later
  // correction on that same theme is the held-out evidence that refutes it. `checkRecurrence` was
  // pure, unit-tested, and had NO production caller — every binding sat `status: 'open'` forever, so
  // the guarantee could not fail. A prediction that cannot fail is decoration, by the constitution's
  // own opening line.
  it('a correction on a bound theme FALSIFIES the binding, and the failure is persisted', () => {
    const ledger = join(sd, 'binding-ledger.jsonl')
    writeFileSync(
      ledger,
      JSON.stringify({
        id: 'bind-1',
        theme: ['concurrent', 'workstreams'],
        rule: 'Tracks multiple concurrent workstreams',
        members: 3,
        boundAt: 1,
        prediction: { claim: 'this theme will not recur', openedAt: 1, status: 'open' },
        reverted: null
      }) + '\n',
      'utf-8'
    )

    appendCorrection(vault, { why: 'lost track of concurrent workstreams again', candidate_rule: 'r' })

    const row = JSON.parse(readFileSync(ledger, 'utf-8').trim())
    expect(row.prediction.status).toBe('failed')
    expect(row.prediction.failedAt).toBeGreaterThan(0)
  })

  it('a correction on an UNRELATED theme leaves the binding open', () => {
    const ledger = join(sd, 'binding-ledger.jsonl')
    writeFileSync(
      ledger,
      JSON.stringify({
        id: 'bind-1',
        theme: ['concurrent', 'workstreams'],
        rule: 'r',
        members: 3,
        boundAt: 1,
        prediction: { claim: 'this theme will not recur', openedAt: 1, status: 'open' },
        reverted: null
      }) + '\n',
      'utf-8'
    )

    appendCorrection(vault, { why: 'the invoice formatting was wrong', candidate_rule: 'r' })

    expect(JSON.parse(readFileSync(ledger, 'utf-8').trim()).prediction.status).toBe('open')
  })

  // The capture is the irreplaceable half: a falsification that throws must never cost a correction.
  it('still appends the correction when the ledger is unreadable', () => {
    mkdirSync(join(sd, 'binding-ledger.jsonl'), { recursive: true }) // a DIRECTORY where a file belongs

    const out = appendCorrection(vault, { why: 'concurrent workstreams', candidate_rule: 'r' })

    expect(out.ok).toBe(true)
    expect(out.total).toBe(1)
  })

  it('appendCorrection REJECTS machine rows (source present)', () => {
    expect(() => appendCorrection(vault, { source: 'machine', why: 'x' })).toThrow(/source/)
  })

  it('runReflect writes taste-engine.json (correction_rules refolded) + returns the reflection', () => {
    writeFileSync(
      join(sd, 'corrections.jsonl'),
      [
        JSON.stringify({ ts: '2026-06-01', why: 'feishu reply format bullet', candidate_rule: 'use md' }),
        JSON.stringify({ ts: '2026-06-02', why: 'feishu reply format markdown', candidate_rule: 'use md' }),
        JSON.stringify({ ts: '2026-06-03', why: 'feishu reply format bullet list', candidate_rule: 'use md' })
      ].join('\n') + '\n'
    )
    const r = runReflect(vault, new Date('2026-07-01T00:00:00Z'))
    expect(r.stream_size).toBe(3)
    expect(r.binding_candidates.length).toBeGreaterThanOrEqual(1) // 3 clustered → surfaced
    const taste = JSON.parse(readFileSync(join(sd, 'taste-engine.json'), 'utf-8'))
    expect(taste.correction_rules.length).toBe(3)
    expect(taste.counts.correction_rules).toBe(3)
    expect(taste.generated_at).toBeTruthy()
  })

  // The candidates used to be computed, returned over HTTP, and dropped — so the Learn loop's
  // headline surfacing signal had no history and could not be measured over time. It is now
  // snapshotted, but ONLY on change: learn-bridge polls /learn/reflect on a schedule and reflect()
  // is deterministic, so a blind append would grow the file forever without adding information.
  it('runReflect snapshots binding candidates, and only when the set CHANGES', () => {
    const corrections = [
      JSON.stringify({ ts: '2026-06-01', why: 'feishu reply format bullet', candidate_rule: 'use md' }),
      JSON.stringify({ ts: '2026-06-02', why: 'feishu reply format markdown', candidate_rule: 'use md' }),
      JSON.stringify({ ts: '2026-06-03', why: 'feishu reply format bullet list', candidate_rule: 'use md' })
    ]
    writeFileSync(join(sd, 'corrections.jsonl'), corrections.join('\n') + '\n')
    const path = join(sd, 'binding-candidates.jsonl')

    runReflect(vault, new Date('2026-07-01T00:00:00Z'))
    const afterFirst = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
    expect(afterFirst.length).toBe(1)
    const row = JSON.parse(afterFirst[0])
    expect(row.count).toBe(row.binding_candidates.length)
    expect(row.stream_size).toBe(3)

    // Same corrections, later poll → identical candidate set → no new row.
    runReflect(vault, new Date('2026-07-02T00:00:00Z'))
    expect(readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).length).toBe(1)

    // A new theme changes the set → exactly one more row.
    corrections.push(
      JSON.stringify({ ts: '2026-06-04', why: 'excel column header alignment', candidate_rule: 'freeze row' }),
      JSON.stringify({ ts: '2026-06-05', why: 'excel column header wrong', candidate_rule: 'freeze row' }),
      JSON.stringify({ ts: '2026-06-06', why: 'excel column header drift', candidate_rule: 'freeze row' })
    )
    writeFileSync(join(sd, 'corrections.jsonl'), corrections.join('\n') + '\n')
    runReflect(vault, new Date('2026-07-03T00:00:00Z'))
    expect(readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).length).toBe(2)
  })

  // ── Regression: a TRUNCATED/corrupt taste-engine.json must not be silently destroyed ──
  // `values`/`frameworks` are operator-seeded and NOTHING regenerates them; learn-store's
  // atomicWrite is their only writer. readExistingTaste used to collapse any parse failure into
  // `{}`, and runReflect then overwrote the file with a taste rebuilt from corrections.jsonl
  // alone — a permanent erasure on a 200 ok. Guard = quarantine (preserve + record + stamp),
  // and abstain from the write when the bytes cannot be preserved.
  const corruptions: [string, string][] = [
    ['truncated (unparseable)', '{"seeded":"y","values":[{"v":"clarity"}],"frameworks":['],
    ['a JSON array (parses, but is not a taste object)', '[{"v":"clarity"}]'],
    ['a JSON scalar', '"clarity"'],
    ['JSON null', 'null']
  ]
  for (const [label, bytes] of corruptions) {
    it(`runReflect QUARANTINES a taste-engine.json that is ${label} instead of overwriting it`, () => {
      const tastePath = join(sd, 'taste-engine.json')
      writeFileSync(tastePath, bytes)
      writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify({ ts: '2026-06-01', why: 'w', candidate_rule: 'r' }) + '\n')

      const r = runReflect(vault, new Date('2026-07-01T00:00:00Z'))

      // The prior bytes survive VERBATIM in an ISO-stamped .corrupt sidecar.
      const sidecars = readdirSync(sd).filter((f) => f.startsWith('taste-engine.json.') && f.endsWith('.corrupt'))
      expect(sidecars.length).toBe(1)
      expect(readFileSync(join(sd, sidecars[0]), 'utf-8')).toBe(bytes)
      expect(sidecars[0]).toMatch(/taste-engine\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.corrupt/)
      // …and the loss is RECORDED on the response, not just in a log.
      expect(r.warning).toMatch(/quarantined/)
      expect(r.quarantined).toBe(join(sd, sidecars[0]))
      // The recompute still happened (the loop keeps working) — over a fresh file.
      expect(JSON.parse(readFileSync(tastePath, 'utf-8')).correction_rules.length).toBe(1)
    })
  }

  it('runReflect ABSTAINS from the taste write when the prior bytes cannot be preserved', () => {
    const tastePath = join(sd, 'taste-engine.json')
    const bytes = '{"seeded":"y","values":[{"v":"clarity"}'
    writeFileSync(tastePath, bytes)
    writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify({ ts: '2026-06-01', why: 'w', candidate_rule: 'r' }) + '\n')
    // Make the quarantine rename fail for real (no mocks): freeze the clock so the sidecar name
    // is deterministic, then park a NON-EMPTY DIRECTORY on it — renaming a file onto that is an
    // error on every platform.
    const now = new Date('2026-07-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const sidecar = `${tastePath}.${now.toISOString().replace(/[:.]/g, '-')}.corrupt`
      mkdirSync(sidecar, { recursive: true })
      writeFileSync(join(sidecar, 'occupied'), 'x')

      const r = runReflect(vault, now)
      expect(r.taste_write_skipped).toBe(true)
      expect(r.warning).toMatch(/could not be quarantined/)
      // The unpreservable bytes are STILL THERE, untouched.
      expect(readFileSync(tastePath, 'utf-8')).toBe(bytes)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runReflect carries seeded values/frameworks forward from a HEALTHY taste-engine.json', () => {
    writeFileSync(join(sd, 'taste-engine.json'), JSON.stringify({ seeded: 'operator', values: [{ v: 'clarity' }], frameworks: [{ f: 'MECE' }] }))
    writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify({ ts: '2026-06-01', why: 'w', candidate_rule: 'r' }) + '\n')
    runReflect(vault, new Date('2026-07-01T00:00:00Z'))
    const taste = JSON.parse(readFileSync(join(sd, 'taste-engine.json'), 'utf-8'))
    expect(taste.values).toEqual([{ v: 'clarity' }])
    expect(taste.frameworks).toEqual([{ f: 'MECE' }])
    expect(taste.seeded).toBe('operator')
    expect(readdirSync(sd).filter((f) => f.endsWith('.corrupt'))).toEqual([]) // healthy → no sidecar
  })

  it('null vault → no-op', () => {
    expect(appendCorrection(null, {})).toEqual({ ok: false, total: 0 })
    expect(runReflect(null).stream_size).toBe(0)
  })

  // ONE TURN, ONE ROW — the DURABLE half of the double-seam guard.
  //
  // Capture now fires from two seams (ipc/chat.ts and the /agui turn boundary), and learn-bridge
  // replays queued rows after a restart. capture-hook's in-process memo cannot see across a
  // process boundary, so the ledger needs its own guarantee — otherwise the widening that made
  // headless turns audible would also double-count every renderer correction, inflating the
  // stream that feeds calibration and the RSI fitness engines.
  describe('append dedupe', () => {
    const row = {
      skill: 'capture-hook',
      ai_output: 'The second test window is August to October.',
      correction: 'It should be August 2026.',
      why: 'because the OKR tracker is the source of truth',
      candidate_rule: 'from now on check the tracker first',
      polarity: 'correction'
    }
    const day = new Date('2026-08-03T00:00:00Z')

    it('the SAME judgment arriving twice on the same day is ONE row', () => {
      const first = appendCorrection(vault, { ...row }, day)
      expect(first).toEqual({ ok: true, total: 1 })

      // The second seam posts the same turn. `session` differs — chat.ts sends the conversation
      // id, the /agui tick sends the thread id — and that must NOT make it look like a new row.
      const second = appendCorrection(vault, { ...row, session: 'a-different-thread-id' }, day)
      expect(second).toEqual({ ok: true, total: 1, duplicate: true })

      const lines = readFileSync(join(sd, 'corrections.jsonl'), 'utf-8').trim().split('\n')
      expect(lines, 'the renderer correction was written twice').toHaveLength(1)
    })

    // The guard must not eat RECURRENCE: a theme recurring is exactly what pushes a cluster to
    // MIN_BIND and surfaces a binding candidate. `ts` is part of the key for this reason.
    it('the same judgment on a LATER day appends normally', () => {
      appendCorrection(vault, { ...row }, day)
      const later = appendCorrection(vault, { ...row }, new Date('2026-08-04T00:00:00Z'))
      expect(later).toEqual({ ok: true, total: 2 })
      expect(readFileSync(join(sd, 'corrections.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(2)
    })

    it('a genuinely different judgment on the same day still appends', () => {
      appendCorrection(vault, { ...row }, day)
      const other = appendCorrection(vault, { ...row, correction: 'It should be September 2026.' }, day)
      expect(other).toEqual({ ok: true, total: 2 })
    })
  })

  // THE STATUS LIFECYCLE'S MISSING WRITER.
  //
  // `status` had readers and no writer: learn-native skips 'dropped', computeTaste forwards the
  // status onto every taste rule, and personalization-recall reads `status === 'bound'` twice —
  // once for BETA_CONFIRMED in recall, once to admit the rule into confirmedJudgmentTexts, the
  // corpus retrieval is re-ranked against. appendCorrection hard-codes 'new', so both arms were
  // inert. These tests hold the transition, not just the field.
  describe('correction status lifecycle', () => {
    const bindingLine = (over: Record<string, unknown> = {}): string =>
      JSON.stringify({
        id: 'bind-lead-risks',
        theme: ['lead', 'risks'],
        rule: 'Lead with wins, risks as decision items',
        members: 3,
        boundAt: Date.parse('2026-07-15T00:00:00Z'),
        prediction: { claim: 'this theme will not recur', openedAt: 1, status: 'open' },
        reverted: null,
        ...over
      }) + '\n'

    const constituent = {
      ts: '2026-07-01',
      why: 'because leadership reads the lead first',
      correction: 'lead with the wins',
      candidate_rule: 'always lead with wins and put risks after'
    }

    it('confirming a binding moves its constituent corrections from new to bound', () => {
      writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify(constituent) + '\n')

      // Before the bind exists, the row is plain 'new'.
      expect(runReflect(vault, new Date('2026-07-10T00:00:00Z')).stream_size).toBe(1)
      let taste = JSON.parse(readFileSync(join(sd, 'taste-engine.json'), 'utf-8'))
      expect(taste.correction_rules[0].status).toBe('new')

      // The operator confirms the candidate — POST /state/bind-candidate appends this row.
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())

      runReflect(vault, new Date('2026-07-20T00:00:00Z'))
      taste = JSON.parse(readFileSync(join(sd, 'taste-engine.json'), 'utf-8'))
      expect(taste.correction_rules[0].status, 'the constituent never moved to bound').toBe('bound')
    })

    it('records the transition in an OVERLAY — corrections.jsonl is never rewritten', () => {
      const original = JSON.stringify(constituent) + '\n'
      writeFileSync(join(sd, 'corrections.jsonl'), original)
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())

      runReflect(vault, new Date('2026-07-20T00:00:00Z'))

      // The capture ledger is byte-identical: the append-only contract is intact.
      expect(readFileSync(join(sd, 'corrections.jsonl'), 'utf-8')).toBe(original)
      const overlay = readFileSync(join(sd, 'correction-status.jsonl'), 'utf-8').trim().split('\n')
      expect(overlay).toHaveLength(1)
      expect(JSON.parse(overlay[0]).status).toBe('bound')
      // And the join is what readers see.
      expect(loadCorrections(sd)[0].status).toBe('bound')
    })

    it('is idempotent — a second reflect appends no further transition', () => {
      writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify(constituent) + '\n')
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())
      runReflect(vault, new Date('2026-07-20T00:00:00Z'))
      const after = readFileSync(join(sd, 'correction-status.jsonl'), 'utf-8')
      runReflect(vault, new Date('2026-07-21T00:00:00Z'))
      expect(readFileSync(join(sd, 'correction-status.jsonl'), 'utf-8')).toBe(after)
    })

    // A correction arriving AFTER the bind is the binding's FALSIFIER, not its constituent —
    // binding-ledger's checkRecurrence reads the identical token overlap to mean exactly that.
    it('a correction that POSTDATES the bind is not a constituent', () => {
      writeFileSync(
        join(sd, 'corrections.jsonl'),
        JSON.stringify({ ...constituent, ts: '2026-07-28' }) + '\n'
      )
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())
      runReflect(vault, new Date('2026-08-01T00:00:00Z'))
      expect(loadCorrections(sd)[0].status ?? 'new').toBe('new')
      expect(existsSync(join(sd, 'correction-status.jsonl')), 'wrote a transition for a falsifier').toBe(false)
    })

    it('reverting the binding returns its constituents to new', () => {
      writeFileSync(join(sd, 'corrections.jsonl'), JSON.stringify(constituent) + '\n')
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())
      runReflect(vault, new Date('2026-07-20T00:00:00Z'))
      expect(loadCorrections(sd)[0].status).toBe('bound')

      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine({ reverted: Date.parse('2026-07-25T00:00:00Z') }))
      runReflect(vault, new Date('2026-07-26T00:00:00Z'))
      expect(loadCorrections(sd)[0].status).toBe('new')
    })

    // The reconciler owns the new<->bound edge and NOTHING else, on both sides of the join.
    //
    // This is the sharp edge of keying on content: `correctionKey` deliberately ignores `status`
    // (a key that moved when the status moved could never find its own row), so a RETIRED row and
    // a live row with identical judgment share one key. If the overlay were allowed to answer for
    // both, marking the live one 'bound' would drag the retired one back into the stream — a
    // deletion undone by a bookkeeping write. Inline non-lifecycle statuses therefore win.
    it('an overlay never resurrects a row another arm retired', () => {
      writeFileSync(
        join(sd, 'corrections.jsonl'),
        JSON.stringify({ ...constituent, status: 'dropped' }) + '\n' + JSON.stringify(constituent) + '\n'
      )
      writeFileSync(join(sd, 'binding-ledger.jsonl'), bindingLine())
      runReflect(vault, new Date('2026-07-20T00:00:00Z'))
      const overlay = readFileSync(join(sd, 'correction-status.jsonl'), 'utf-8').trim().split('\n')
      expect(overlay).toHaveLength(1) // only the non-dropped row transitioned

      const rows = loadCorrections(sd)
      expect(rows, 'the dropped row came back').toHaveLength(1)
      expect(rows[0].status).toBe('bound')
    })
  })
})

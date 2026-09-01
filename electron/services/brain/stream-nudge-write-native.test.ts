import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  overlap2,
  entityMatch,
  langFor,
  compactStream,
  applyNudge,
  matchStreams,
  buildNudgePrompt,
  runStreamNudge
} from './stream-nudge-write-native'

describe('stream-nudge — match primitives (PURE)', () => {
  it('overlap2 needs ≥2 shared significant tokens', () => {
    expect(overlap2('bilibili launch event', 'bilibili launch plan')).toBe(true) // bilibili+launch
    expect(overlap2('bilibili event', 'taptap launch')).toBe(false)
  })

  it('entityMatch fires on a single shared latin brand token (cross-language)', () => {
    // one shared token "bilibili" (latin ≥4) → matches despite otherwise-Chinese stream text.
    expect(entityMatch('Bilibili confirmed the deal', 'Bilibili战略伙伴关系承诺')).toBe(true)
    // no shared brand, <2 tokens → no match
    expect(entityMatch('random note', '完全不同的内容')).toBe(false)
  })

  it('langFor maps track → language instruction', () => {
    // Cold-start A4 de-personalized the track keys this switch is stated against.
    expect(langFor('ProjectA')).toBe('Write in 中文 (Chinese).')
    expect(langFor('SupplierCo')).toBe('Write in 中文 (Chinese).')
    expect(langFor('PartnerCo')).toBe('Write in 日本語 (Japanese).')
    expect(langFor('personal')).toBe('Write in English.')
  })
})

describe('stream-nudge — matchStreams / compactStream (PURE)', () => {
  const streams = [
    { id: 'a', status: 'open', title: 'Bilibili launch', objective: 'ship on Bilibili', steps: [] },
    { id: 'b', status: 'engaged', title: 'TapTap page', objective: 'TapTap store', steps: [{ event: 'submit' }] },
    { id: 'c', status: 'declined', title: 'Bilibili launch', objective: 'ship on Bilibili', steps: [] }
  ]

  it('matches only active (open/engaged) streams by subject, capped at 3', () => {
    const m = matchStreams(streams, 'Bilibili launch confirmed')
    expect(m.map((s) => s.id)).toEqual(['a']) // c is declined → excluded; b doesn't share ≥2/brand
  })

  it('caps matches at 3', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, status: 'open', title: 'Bilibili launch', objective: 'ship on Bilibili', steps: [] }))
    expect(matchStreams(many, 'Bilibili launch').length).toBe(3)
  })

  it('compactStream keeps only present keys, in Python order', () => {
    expect(Object.keys(compactStream({ id: 'x', title: 'T', objective: 'O', levels: { risk: 0.2 } }))).toEqual(['title', 'objective', 'levels'])
  })
})

describe('stream-nudge — applyNudge (PURE, in place)', () => {
  it('clamps+rounds levels, marks overlapping steps done, appends a capped log line', () => {
    const s: Record<string, unknown> = {
      id: 'a',
      levels: { risk: 0.5, progress: 0.1, confidence: 0.5 },
      steps: [{ event: 'submit build to store', done: false }, { event: 'press release', done: false }],
      log: []
    }
    applyNudge(s as never, {
      levels: { risk: 0.777, progress: 1.5, confidence: 0.9 }, // progress out of range → unchanged
      steps_done: ['submit build to store now complete'],
      note: 'build submitted'
    }, '2026-07-03T10:00:00')
    expect((s.levels as Record<string, number>)).toEqual({ risk: 0.78, progress: 0.1, confidence: 0.9 })
    expect((s.steps as { done: boolean }[])[0].done).toBe(true) // overlap2: submit+build+store
    expect((s.steps as { done: boolean }[])[1].done).toBe(false)
    expect((s.log as { note: string }[])[0]).toEqual({ ts: '2026-07-03T10:00:00', note: 'build submitted' })
    expect(s.refreshed).toBe('2026-07-03T10:00:00')
  })

  it('caps the log at the last 5 entries', () => {
    const s: Record<string, unknown> = { id: 'a', levels: {}, steps: [], log: Array.from({ length: 5 }, (_, i) => ({ ts: `t${i}`, note: `n${i}` })) }
    applyNudge(s as never, { note: 'newest' }, '2026-07-03T10:00:00')
    const log = s.log as { note: string }[]
    expect(log).toHaveLength(5)
    expect(log[4].note).toBe('newest')
    expect(log[0].note).toBe('n1') // n0 dropped
  })

  it('prompt embeds the compact stream + update + lang rule', () => {
    const p = buildNudgePrompt({ title: 'T' }, 'UPD', 'ProjectA')
    expect(p).toContain('Re-evaluate ONLY this stream')
    expect(p).toContain('Write in 中文 (Chinese).')
    expect(p).toContain('STREAM: {"title":"T"}')
    expect(p.endsWith('UPDATE: UPD')).toBe(true)
  })
})

describe('stream-nudge — runStreamNudge', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-sn-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('empty text → no-op, no model call', async () => {
    let called = false
    const out = await runStreamNudge(vault, '  ', { generate: async () => { called = true; return '{}' } })
    expect(out).toEqual({ ok: true, nudged: [] })
    expect(called).toBe(false)
  })

  it('mutates matched streams + saves; leaves the file when nothing parseable', async () => {
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 'a', status: 'open', title: 'Bilibili launch', objective: 'ship on Bilibili', steps: [{ event: 'submit build', done: false }], levels: { risk: 0.3, progress: 0.1, confidence: 0.5 }, log: [] }),
        JSON.stringify({ id: 'b', status: 'open', title: 'unrelated', objective: 'nothing', steps: [], levels: {}, log: [] })
      ].join('\n') + '\n'
    )
    const out = await runStreamNudge(vault, 'Bilibili launch — build submitted', {
      generate: async () => '{"levels":{"progress":0.6},"steps_done":["submit build done"],"note":"submitted"}',
      now: () => new Date(2026, 6, 3, 10, 0, 0)
    })
    expect(out.nudged).toEqual(['a'])
    const rows = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const a = rows.find((r) => r.id === 'a')
    expect(a.levels.progress).toBe(0.6)
    expect(a.steps[0].done).toBe(true)
    expect(a.log[0].note).toBe('submitted')
    expect(rows.find((r) => r.id === 'b').title).toBe('unrelated') // untouched
  })
})

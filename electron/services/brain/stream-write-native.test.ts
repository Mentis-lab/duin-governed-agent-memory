import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateStream, cleanWhen, bindTask, unbindTask, actFuture, extractStream, jsonFromModel, normalizeStream, type ExtractStreamDeps } from './stream-write-native'

describe('stream-write-native', () => {
  let vault: string
  let fp: string
  const NOW = new Date('2026-07-02T17:05:30')
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-sw-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    fp = join(vault, '.duin', '_state', 'future-nodes.jsonl')
    writeFileSync(
      fp,
      [
        JSON.stringify({ id: 's1', title: 'Old', track: '北澜', source: 'projected' }),
        JSON.stringify({ id: 's2', title: 'Other', source: 'projected' })
      ].join('\n') + '\n'
    )
    // a separate channel-futures file that MUST NOT be pulled into future-nodes on save
    writeFileSync(join(vault, '.duin', '_state', 'channel-futures.jsonl'), JSON.stringify({ id: 'c1', title: 'Channel' }) + '\n')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))
  const nodes = (): Array<Record<string, unknown>> =>
    readFileSync(fp, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

  it('cleanWhen normalizes dashes + extracts the date', () => {
    expect(cleanWhen('2026-06–08')).toBe('2026-06-08') // en-dash → '-', then a full YYYY-MM-DD matches (parity with Python)
    expect(cleanWhen('2026-06 – 2026-08')).toBe('2026-06') // spaced range → only the first date token matches
    expect(cleanWhen('by 2026-07-15 ish')).toBe('2026-07-15')
    expect(cleanWhen('someday')).toBe('')
  })

  it('edits allowed fields, marks source=synced + refreshed, coerces bool/number to string', () => {
    const r = updateStream(vault, 's1', { title: 'New', cleared: true, target: 3 }, NOW)
    expect(r.ok).toBe(true)
    const n = nodes().find((x) => x.id === 's1')!
    expect(n.title).toBe('New')
    expect(n.cleared).toBe('True') // bool → Python-style capitalized string (str(True))
    expect(n.target).toBe('3') // number → string
    expect(n.source).toBe('synced')
    expect(n.refreshed).toBe('2026-07-02T17:05:30')
  })

  it('cleans decide_by, shapes steps, clamps levels', () => {
    updateStream(
      vault,
      's1',
      { decide_by: '2026-08–10', steps: [{ event: 'ship', when: '2026-09-01', done: true }, { junk: 1 }], levels: { risk: 1.4, progress: 0.5 } },
      NOW
    )
    const n = nodes().find((x) => x.id === 's1')!
    expect(n.decide_by).toBe('2026-08-10') // en-dash → '-', full date matches (parity)
    expect(n.steps).toEqual([{ event: 'ship', when: '2026-09-01', lead: '', done: true }])
    expect((n.levels as Record<string, number>).risk).toBe(1) // clamped to 1
    expect((n.levels as Record<string, number>).progress).toBe(0.5)
  })

  it('does NOT pull channel-futures into future-nodes.jsonl on save', () => {
    updateStream(vault, 's1', { title: 'X' }, NOW)
    const ids = nodes().map((n) => n.id)
    expect(ids).toEqual(['s1', 's2']) // c1 stays out
  })

  it('returns ok:false when the node is absent / vault null', () => {
    expect(updateStream(vault, 'ghost', { title: 'x' }, NOW).ok).toBe(false)
    expect(updateStream(null, 's1', { title: 'x' }, NOW).ok).toBe(false)
  })

  describe('bindTask / unbindTask', () => {
    beforeEach(() => {
      mkdirSync(join(vault, '06 Tasks'), { recursive: true })
      writeFileSync(join(vault, '06 Tasks', 'Inbox.md'), '- [ ] ship the thing {{duinTaskId:: t1}}\n')
    })
    const s1 = (): Record<string, unknown> =>
      readFileSync(fp, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).find((n) => n.id === 's1')!

    it('binds a task as a step with the resolved title', () => {
      const r = bindTask(vault, 't1', 's1', '2026-09-01')
      expect(r.ok).toBe(true)
      const steps = s1().steps as Record<string, unknown>[]
      expect(steps).toHaveLength(1)
      expect(steps[0]).toMatchObject({ event: 'ship the thing', when: '2026-09-01', task_id: 't1', gap: false, done: false })
    })
    it('is idempotent (already bound → already:true, no dup step)', () => {
      bindTask(vault, 't1', 's1')
      const again = bindTask(vault, 't1', 's1')
      expect(again).toMatchObject({ ok: true, already: true })
      expect((s1().steps as unknown[]).length).toBe(1)
    })
    it('drops a non-ISO due; falls back to id when title not found', () => {
      bindTask(vault, 'unknownTask', 's1', 'someday')
      const step = (s1().steps as Record<string, unknown>[])[0]
      expect(step.when).toBe('')
      expect(step.event).toBe('unknownTask')
    })
    it('unbind removes the binding; missing stream / vault → error', () => {
      bindTask(vault, 't1', 's1')
      expect(unbindTask(vault, 't1')).toEqual({ ok: true, removed: 1 })
      expect((s1().steps as unknown[]).length).toBe(0)
      expect(bindTask(vault, 't1', 'ghost').ok).toBe(false)
      expect(bindTask(null, 't1', 's1').ok).toBe(false)
    })
  })

  describe('actFuture', () => {
    const node = (id: string): Record<string, unknown> | undefined =>
      readFileSync(fp, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).find((n) => n.id === id)
    it('engage/pass/keep set the right fields; delete removes the node', () => {
      expect(actFuture(vault, 's1', 'engage')).toEqual({ ok: true, id: 's1', action: 'engage' })
      expect(node('s1')!.status).toBe('engaged')
      actFuture(vault, 's1', 'pass')
      expect(node('s1')!.status).toBe('declined')
      expect(node('s1')!.kept).toBe(false)
      actFuture(vault, 's2', 'keep')
      expect(node('s2')!.kept).toBe(true)
      expect(actFuture(vault, 's1', 'delete')).toEqual({ ok: true, id: 's1', action: 'delete' })
      expect(node('s1')).toBeUndefined()
    })
    it('null vault → ok:false', () => {
      expect(actFuture(null, 's1', 'pass').ok).toBe(false)
    })
  })

  describe('jsonFromModel', () => {
    it('strips ```json fences + prose and parses an object', () => {
      expect(jsonFromModel('here:\n```json\n{"a":1}\n```', false)).toEqual({ a: 1 })
      expect(jsonFromModel('no json', false)).toBeNull()
    })
  })

  describe('normalizeStream', () => {
    it('slices text fields, shapes steps, clamps levels, falls back track', () => {
      const n = normalizeStream(
        { objective: 'reach the ceiling', steps: [{ event: 'ship', when: '2026-09–01', lead: '~12mo' }, 'bare step'], levels: { risk: 1.5, progress: 0.2 }, confidence: 0.7, cleared: true },
        'synced'
      )
      expect(n.title).toBe('reach the ceiling') // title falls back to objective
      expect(n.kind).toBe('active') // source=synced
      expect((n.steps as Record<string, unknown>[])[0]).toMatchObject({ event: 'ship', when: '2026-09-01', lead: '~12mo', done: false })
      expect((n.steps as Record<string, unknown>[])[1]).toMatchObject({ event: 'bare step', when: '' })
      expect((n.levels as Record<string, number>).risk).toBe(0.3) // 1.5 out of range → default
      expect(n.cleared).toBe('true') // bool → string (no crash on slice)
      expect(n.track).toBe('unknown') // no keyword match
    })
  })

  describe('extractStream', () => {
    const deps = (out: string): ExtractStreamDeps => ({
      generate: async () => out,
      now: () => new Date('2026-07-02T09:00:00'),
      id: () => 'strm0001'
    })
    it('structures a stream from model JSON and appends it to future-nodes', async () => {
      // `track` is validated against world-update-native's WORLD_TRACK_KEYS, which cold-start A3
      // de-personalized to placeholder keys (ProjectA/orbis/AIT/ProjectB/SupplierCo/personal).
      const r = await extractStream(vault, 'sync my ProjectA launch plan', deps('{"title":"ProjectA launch","objective":"global launch","track":"ProjectA","decide_by":"2026-08"}'))
      expect(r.ok).toBe(true)
      expect(r.stream).toMatchObject({ id: 'strm0001', status: 'open', source: 'synced', track: 'ProjectA', created: '2026-07-02T09:00:00' })
      const ids = readFileSync(fp, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l).id)
      expect(ids).toContain('strm0001')
    })
    it('returns ok:false when the model output is not structurable', async () => {
      const r = await extractStream(vault, 'gibberish', deps('the model said no'))
      expect(r).toEqual({ ok: false, error: 'could not structure that' })
    })
  })
})

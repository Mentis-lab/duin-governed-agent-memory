// GOLDEN for the misc route batch. Live-diff proved auto-track(off) + drivers
// (cache-read) byte-exact on the real vault; this pins save_to_raw (unicode-safe
// filename) + the deterministic auto-track/drivers paths on synthetic fixtures.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveToRaw, autoTrackRisks, inferDrivers, saveUpload, parseContacts, learnLoopStatus } from './misc-routes-native'

describe('misc-routes-native — golden', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-misc-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('saveToRaw: stores under the raw pillar, keeps CJK, sanitizes unsafe chars', () => {
    mkdirSync(join(dir, '00 Raw'), { recursive: true })
    const out = saveToRaw(dir, '会议*记录?.md', Buffer.from('hello'))
    expect(out).toEqual({ stored: '会议_记录_.md', bytes: 5 }) // CJK kept (unicode \w), *? → _
    expect(readFileSync(join(dir, '00 Raw', '会议_记录_.md'), 'utf-8')).toBe('hello')
  })

  it('autoTrackRisks: disabled path is trivial + writes nothing', () => {
    expect(autoTrackRisks(dir, false)).toEqual({ ok: true, enabled: false, graduated: [] })
  })

  it('inferDrivers: no-force returns the cache and never computes a cold miss', async () => {
    const gen = vi.fn(async (): Promise<string> => '[]')
    mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
    writeFileSync(
      join(dir, '.duin', '_state', 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', title: 'one', track: 'work', status: 'open' }),
        JSON.stringify({ id: 's2', title: 'two', track: 'work', status: 'open' })
      ].join('\n'),
      'utf8'
    )
    expect(await inferDrivers(dir, false, { generate: gen })).toEqual({
      drivers: [], generated: '', note: 'cache miss'
    })
    expect(gen).not.toHaveBeenCalled()
    expect(existsSync(join(dir, '.duin', '_state', 'causal-drivers.json'))).toBe(false)
    // with a cache present, no-force returns it verbatim
    const cached = { drivers: [{ driver: 'x', track: '北澜', explains: ['a', 'b'] }], generated: '2026-07-01' }
    writeFileSync(join(dir, '.duin', '_state', 'causal-drivers.json'), JSON.stringify(cached), 'utf-8')
    expect(await inferDrivers(dir, false, { generate: gen })).toEqual(cached)
    expect(existsSync(join(dir, '.duin', '_state', 'causal-drivers.json'))).toBe(true)
  })

  it('parseContacts: name/email/org split; org-hint detection', () => {
    const rows = parseContacts(['- Alice Chen <alice@x.io>, Acme Games, PM', '# comment', 'Bob | Widgets Inc | eng'].join('\n'), 'list.csv')
    expect(rows[0]).toEqual({ name: 'Alice Chen', role: 'PM', org: 'Acme Games', email: 'alice@x.io', kind: 'person', source: 'list.csv' })
    expect(rows[1]).toMatchObject({ name: 'Bob', org: 'Widgets Inc', kind: 'person' }) // "Widgets Inc" has org-hint 'inc'
  })

  it('saveUpload: stores file; contacts parse adds entities with id suffix', () => {
    saveUpload(dir, 'notes.md', Buffer.from('# doc'), '') // non-contacts: just stored
    const out = saveUpload(dir, 'contacts.csv', Buffer.from('Alice <a@x.io>'), 'contacts')
    expect(out.stored).toBe('contacts.csv')
    const added = out.added as Record<string, unknown>[]
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ name: 'Alice', email: 'a@x.io', kind: 'person' })
    expect(String(added[0].id)).toMatch(/^alice-[0-9a-f]{6}$/) // slug + random suffix
  })

  it('learnLoopStatus: deterministic file counts + debt', () => {
    mkdirSync(join(dir, '.duin', '_state', 'judgment-queue'), { recursive: true })
    writeFileSync(join(dir, '.duin', '_state', 'judgment-queue', 'a.json'), '{}')
    writeFileSync(join(dir, '.duin', '_state', 'judgment-queue', 'b.json'), '{}')
    writeFileSync(join(dir, '.duin', '_state', 'judgment-queue', 'skip.txt'), 'x') // non-.json ignored
    writeFileSync(join(dir, '.duin', '_state', 'corrections.jsonl'), ['{"status": "new"}', '{"status":"new"}', '{"status": "promoted"}'].join('\n'))
    writeFileSync(join(dir, '.duin', '_state', 'distill-proposals.jsonl'), ['{"x":"pending-review"}', '{"x":"done"}'].join('\n'))
    mkdirSync(join(dir, '.duin', '_pending'), { recursive: true })
    writeFileSync(join(dir, '.duin', '_pending', 'distill-request-1.signal'), '')
    expect(learnLoopStatus(dir)).toEqual({
      queued: 2, // 2 .json (skip.txt ignored)
      corrections_new: 2, // spaced + compact "status new"
      proposals_pending: 1,
      distill_due: true,
      debt: 6 // 2+2+1+1
    })
    // empty vault → all zeros
    const empty = mkdtempSync(join(tmpdir(), 'duin-learn-empty-'))
    try {
      expect(learnLoopStatus(empty)).toEqual({ queued: 0, corrections_new: 0, proposals_pending: 0, distill_due: false, debt: 0 })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

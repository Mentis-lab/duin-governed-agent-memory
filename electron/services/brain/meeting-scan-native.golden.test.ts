// GOLDEN for scan_chat_meetings — the LLM calls are non-deterministic, so this
// injects a fixed `generate` and pins the found/merge/store pipeline (md5 id,
// field slicing, preserve prior status, meetings.jsonl write).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { meetingScan } from './meeting-scan-native'

describe('meeting-scan-native — golden (found/merge/store pipeline)', () => {
  let dir: string
  const store = () => join(dir, '.duin', '_state', 'meetings.jsonl')
  const write = (rel: string, text: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf-8')
  }
  const midOf = (when: string, what: string): string => createHash('md5').update(when + what, 'utf-8').digest('hex').slice(0, 10)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-meet-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('extracts meetings, writes meetings.jsonl with md5 ids + status pending', async () => {
    write('00 Raw/Wechat/chat.md', 'a'.repeat(60)) // >40 chars so it is scanned
    const gen = async (): Promise<string> => '[{"when":"2026-07-10","who":"Alice","what":"kickoff sync","type":"meeting"},{"what":""}]'
    const r = await meetingScan(dir, { generate: gen }, '2026-07-07')
    expect(r).toEqual({ ok: true, found: 1, total: 1 }) // the {"what":""} item is dropped (no what)
    const rows = readFileSync(store(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0]).toEqual({
      id: midOf('2026-07-10', 'kickoff sync'),
      when: '2026-07-10',
      who: 'Alice',
      what: 'kickoff sync',
      type: 'meeting',
      source: '00 Raw/Wechat/chat.md',
      status: 'pending'
    })
  })

  it('preserves a prior confirm/dismiss decision on re-scan', async () => {
    write('00 Raw/Wechat/chat.md', 'b'.repeat(60))
    const id = midOf('2026-07-10', 'kickoff sync')
    write('.duin/_state/meetings.jsonl', JSON.stringify({ id, when: '2026-07-10', what: 'kickoff sync', status: 'confirmed' }))
    const gen = async (): Promise<string> => '[{"when":"2026-07-10","who":"Alice","what":"kickoff sync","type":"meeting"}]'
    const r = await meetingScan(dir, { generate: gen }, '2026-07-07')
    expect(r.total).toBe(1)
    const rows = readFileSync(store(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0].status).toBe('confirmed') // prior decision preserved, not reset to pending
  })

  it('skips short/empty logs → no meetings', async () => {
    write('00 Raw/Wechat/tiny.md', 'short') // < 40 chars
    const gen = async (): Promise<string> => '[{"when":"x","what":"y"}]'
    expect(await meetingScan(dir, { generate: gen }, '2026-07-07')).toEqual({ ok: true, found: 0, total: 0 })
  })
})

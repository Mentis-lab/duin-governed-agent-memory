import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { meetingAction } from './meeting-write-native'

describe('meeting-write-native', () => {
  let vault: string
  let fp: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-mtg-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    fp = join(vault, '.duin', '_state', 'meetings.jsonl')
    writeFileSync(
      fp,
      [
        JSON.stringify({ id: 'm1', title: 'Sync', status: 'unconfirmed', when: '2026-07-03' }),
        JSON.stringify({ id: 'm2', title: 'Review', status: 'unconfirmed' })
      ].join('\n') + '\n'
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))
  const rows = (): Array<Record<string, unknown>> =>
    readFileSync(fp, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))

  it('confirm sets status=confirmed', () => {
    expect(meetingAction(vault, 'm1', 'confirm')).toEqual({ ok: true, id: 'm1', status: 'confirmed' })
    expect(rows().find((m) => m.id === 'm1')!.status).toBe('confirmed')
  })
  it('dismiss sets status=dismissed and leaves the other meeting alone', () => {
    meetingAction(vault, 'm2', 'dismiss')
    expect(rows().find((m) => m.id === 'm2')!.status).toBe('dismissed')
    expect(rows().find((m) => m.id === 'm1')!.status).toBe('unconfirmed')
  })
  it('unknown action leaves status untouched but returns ok', () => {
    const r = meetingAction(vault, 'm1', 'frob')
    expect(r).toEqual({ ok: true, id: 'm1', status: 'unconfirmed' })
  })
  it('missing id / vault → ok:false not found', () => {
    expect(meetingAction(vault, 'ghost', 'confirm')).toEqual({ ok: false, error: 'not found' })
    expect(meetingAction(null, 'm1', 'confirm').ok).toBe(false)
  })
})

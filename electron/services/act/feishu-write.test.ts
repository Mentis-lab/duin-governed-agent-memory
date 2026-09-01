import { describe, it, expect, vi } from 'vitest'
import {
  buildCreateDocArgs,
  buildBaseRecordArgs,
  buildCalendarEventArgs,
  parseLarkResult,
  feishuCreateDoc,
  feishuBaseAddRecord,
  feishuCreateCalendarEvent
} from './feishu-write'
import type { Exec, ExecResult } from '../brain/feishu-comms-native'

// Pure arg-shaping + mocked-exec tests. The lark-cli subprocess is injected as `exec`,
// so nothing is spawned. (Exact CLI verbs are human-verify; the SHAPE is asserted.)

describe('buildCreateDocArgs', () => {
  it('imports a markdown file as docx with optional title/folder', () => {
    expect(buildCreateDocArgs({ filePath: '/tmp/p.md', title: 'My Doc' })).toEqual([
      'drive', '+import', '--file', '/tmp/p.md', '--type', 'docx', '--title', 'My Doc'
    ])
    expect(buildCreateDocArgs({ filePath: '/tmp/p.md', folderToken: 'fld' })).toContain('--folder-token')
  })
})

describe('buildBaseRecordArgs', () => {
  it('passes fields via an @-file to keep metachars off the command line', () => {
    expect(buildBaseRecordArgs({ appToken: 'app', tableId: 'tbl', fieldsFile: '/tmp/f.json' })).toEqual([
      'base', '+record-create', '--app-token', 'app', '--table-id', 'tbl', '--fields', '@/tmp/f.json'
    ])
  })
})

describe('buildCalendarEventArgs', () => {
  it('shapes summary/start/end with primary default and optional description', () => {
    expect(buildCalendarEventArgs({ summary: 'S', start: '100', end: '200' })).toEqual([
      'calendar', '+event-create', '--calendar-id', 'primary', '--summary', 'S', '--start-time', '100', '--end-time', '200'
    ])
    expect(buildCalendarEventArgs({ summary: 'S', start: '1', end: '2', description: 'd' })).toContain('--description')
  })
})

describe('parseLarkResult', () => {
  it('reads an id/token from a success envelope', () => {
    const r = parseLarkResult({ stdout: JSON.stringify({ ok: true, data: { document_id: 'doc9', url: 'https://x' } }), stderr: '', code: 0 })
    expect(r).toEqual({ ok: true, id: 'doc9', info: 'https://x' })
  })
  it('surfaces an error envelope', () => {
    const r = parseLarkResult({ stdout: JSON.stringify({ error: { message: 'permission denied' } }), stderr: '', code: 0 })
    expect(r).toEqual({ ok: false, error: 'permission denied' })
  })
  it('treats a non-zero exit with no stdout as a failure', () => {
    const r = parseLarkResult({ stdout: '', stderr: 'boom', code: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('boom')
  })
  it('treats non-JSON stdout with a zero exit as success', () => {
    const r = parseLarkResult({ stdout: 'created ok', stderr: '', code: 0 })
    expect(r.ok).toBe(true)
  })
})

function execOnce(result: ExecResult): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = async (args) => {
    calls.push(args)
    return result
  }
  return { exec, calls }
}

describe('feishuCreateDoc', () => {
  it('stages markdown to a temp file and imports it', async () => {
    const { exec, calls } = execOnce({ stdout: JSON.stringify({ ok: true, data: { document_id: 'd1' } }), stderr: '', code: 0 })
    const r = await feishuCreateDoc({ title: 'T', markdown: '# hi\n| a | b |' }, { exec })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('d1')
    // The import references a real staged file (not inline content).
    const args = calls[0]
    expect(args[0]).toBe('drive')
    expect(args[1]).toBe('+import')
    const fileIdx = args.indexOf('--file')
    expect(fileIdx).toBeGreaterThan(-1)
    expect(args[fileIdx + 1]).toMatch(/payload\.md$/)
  })
  it('rejects empty content without exec', async () => {
    const exec = vi.fn() as unknown as Exec
    const r = await feishuCreateDoc({ title: 'T', markdown: '  ' }, { exec })
    expect(r.ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('feishuBaseAddRecord', () => {
  it('stages fields to a temp json file and creates the record', async () => {
    const { exec, calls } = execOnce({ stdout: JSON.stringify({ ok: true, data: { record: { record_id: 'rec1' } } }), stderr: '', code: 0 })
    const r = await feishuBaseAddRecord({ appToken: 'app', tableId: 'tbl', fields: { Name: 'x' } }, { exec })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('rec1')
    const args = calls[0]
    const fIdx = args.indexOf('--fields')
    expect(args[fIdx + 1]).toMatch(/^@.*payload\.json$/)
  })
  it('requires appToken and tableId', async () => {
    const exec = vi.fn() as unknown as Exec
    const r = await feishuBaseAddRecord({ appToken: '', tableId: 't', fields: {} }, { exec })
    expect(r.ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('feishuCreateCalendarEvent', () => {
  it('creates an event via lark-cli', async () => {
    const { exec, calls } = execOnce({ stdout: JSON.stringify({ ok: true, data: { event_id: 'ev1' } }), stderr: '', code: 0 })
    const r = await feishuCreateCalendarEvent({ summary: 'S', start: '1', end: '2' }, { exec })
    expect(r.ok).toBe(true)
    expect(r.id).toBe('ev1')
    expect(calls[0][1]).toBe('+event-create')
  })
  it('requires a summary', async () => {
    const exec = vi.fn() as unknown as Exec
    const r = await feishuCreateCalendarEvent({ summary: '', start: '1', end: '2' }, { exec })
    expect(r.ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

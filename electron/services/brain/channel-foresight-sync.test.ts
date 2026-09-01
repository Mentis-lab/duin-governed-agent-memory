import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bridgeChannelForesight, docTitle } from './channel-foresight-sync'
import type { ExtractedData } from './types'

describe('channel-foresight-sync', () => {
  it('docTitle prefers the H1, else first non-frontmatter line', () => {
    expect(docTitle('---\ntype: event\n---\n# 北澜 booth\nbody')).toBe('北澜 booth')
    expect(docTitle('just a line\nmore')).toBe('just a line')
  })

  it('key-gated: no model → keyless ANCHORS still written, streams skipped', async () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cfs-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    const docs = [{ file: 'src/gcal/7', text: '---\ntype: event\ndate: 2026-08-15\n---\n# 二测 kickoff\nctx' }]
    const out = await bridgeChannelForesight(v, async () => null, () => docs)
    expect(out).toEqual({ anchors: 1, streams: 0 }) // keyless calendar → foresight timeline, no model
    const anchors = readFileSync(join(v, '.duin', '_state', 'channel-anchors.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(anchors[0]).toMatchObject({ id: 'src:src/gcal/7', name: '二测 kickoff', kind: 'event', date: '2026-08-15' })
    rmSync(v, { recursive: true, force: true })
  })

  it('with a model: channel decisions → streams (ignores non-src notes) + events → anchors', async () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cfs-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    const ex: ExtractedData = {
      commitments: [],
      decisions: [
        { note: 'src/slack/1', decide_by: '2026-08-01', cleared: 'go', blocked: 'no' },
        { note: 'my-note.md', decide_by: '2026-08-01', cleared: 'x', blocked: 'y' } // NOT a channel doc → dropped
      ],
      risks: []
    }
    const docs = [
      { file: 'src/slack/1', text: '# 北澜 BW decision\nctx' },
      { file: 'src/gcal/2', text: '---\ntype: event\ndate: 2026-07-10\n---\n# BW opening\nx' }
    ]
    const out = await bridgeChannelForesight(v, async () => ex, () => docs)
    expect(out).toEqual({ anchors: 1, streams: 1 })
    const rows = readFileSync(join(v, '.duin', '_state', 'channel-futures.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0]).toMatchObject({ id: 'src:src/slack/1', title: '北澜 BW decision', decide_by: '2026-08-01' })
    rmSync(v, { recursive: true, force: true })
  })
})

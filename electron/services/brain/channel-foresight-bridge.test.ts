import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractedToStreams, writeChannelFutures, channelEventsToAnchors, writeChannelAnchors, parseSynthMeta } from './channel-foresight-bridge'
import { loadFutures, causalGraph, readAnchorDecls } from './causal-substrate'
import { generateForecasts } from './forecast-generator'
import type { ExtractedData } from './types'

const resolver = (m: Record<string, { title: string; track?: string }>) => (id: string) => m[id] ?? null

describe('channel-foresight-bridge', () => {
  it('maps a DECISION (decide_by + fork) into a foresight stream, namespaced src:', () => {
    const ex: ExtractedData = {
      commitments: [],
      decisions: [{ note: 'src/slack/123', decide_by: '2026-08-01', cleared: 'ship', blocked: 'slip' }],
      risks: []
    }
    const streams = extractedToStreams(ex, resolver({ 'src/slack/123': { title: '北澜 BW booth decision', track: '北澜' } }))
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({
      id: 'src:src/slack/123',
      title: '北澜 BW booth decision',
      track: '北澜',
      status: 'open',
      decide_by: '2026-08-01',
      cleared: 'ship',
      blocked: 'slip'
    })
  })

  it('a decision + commitment for the same note → one (the richer decision) stream', () => {
    const ex: ExtractedData = {
      commitments: [{ note: 'n1', date: '2026-07-10' }],
      decisions: [{ note: 'n1', decide_by: '2026-07-05', cleared: 'a', blocked: 'b' }],
      risks: []
    }
    const streams = extractedToStreams(ex, resolver({ n1: { title: 'T' } }))
    expect(streams).toHaveLength(1)
    expect(streams[0].decide_by).toBe('2026-07-05')
  })

  it('drops items whose note can’t be resolved', () => {
    const ex: ExtractedData = { commitments: [{ note: 'gone', date: '2026-07-01' }], decisions: [], risks: [] }
    expect(extractedToStreams(ex, resolver({}))).toHaveLength(0)
  })

  it('END-TO-END: channel-futures.jsonl flows through loadFutures → the causal graph', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cfb-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'future-nodes.jsonl'), '') // no authored streams (a newcomer)
    const streams = extractedToStreams(
      { commitments: [], decisions: [{ note: 'src/slack/9', decide_by: '2026-08-01', cleared: 'go', blocked: 'no' }], risks: [] },
      resolver({ 'src/slack/9': { title: 'channel decision', track: '北澜' } })
    )
    expect(writeChannelFutures(v, streams)).toBe(1)
    // loadFutures now merges the channel stream
    expect(loadFutures(v).some((s) => s.id === 'src:src/slack/9')).toBe(true)
    // and the causal graph builds its decision node — channel data reached the foresight substrate
    const { nodes } = causalGraph(v, '', new Date('2026-07-01T00:00:00Z'))
    expect(nodes.some((n) => n.id === 'stream:src:src/slack/9')).toBe(true)
    expect(nodes.some((n) => n.kind === 'decision' && n.id === 'decision:src:src/slack/9')).toBe(true)
    rmSync(v, { recursive: true, force: true })
  })

  it('parseSynthMeta reads type/date from frontmatter + title from H1', () => {
    expect(parseSynthMeta('---\ntype: event\ndate: 2026-08-15\ntags: [gcal]\n---\n# 二测 kickoff\nbody')).toEqual({
      type: 'event',
      date: '2026-08-15',
      title: '二测 kickoff'
    })
  })

  it('channelEventsToAnchors: dated events → anchors (with title-token binds); non-events dropped', () => {
    const docs = [
      { file: 'src/gcal/1', text: '---\ntype: event\ndate: 2026-07-10\n---\n# BilibiliWorld opening\nx' },
      { file: 'src/slack/2', text: '---\ntype: note\ndate: 2026-07-01\n---\n# just a message\ny' } // not event → dropped
    ]
    const anchors = channelEventsToAnchors(docs)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ id: 'src:src/gcal/1', name: 'BilibiliWorld opening', kind: 'event', date: '2026-07-10' })
    expect(anchors[0].binds_keywords).toContain('bilibiliworld')
  })

  it('END-TO-END: channel-anchors.jsonl → readAnchorDecls → the causal graph anchor node', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-cfa-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'future-nodes.jsonl'), '')
    const anchors = channelEventsToAnchors([{ file: 'src/gcal/5', text: '---\ntype: event\ndate: 2099-07-10\n---\n# Future Summit\nx' }])
    expect(writeChannelAnchors(v, anchors)).toBe(1)
    expect(readAnchorDecls(v).some((d) => d.id === 'src:src/gcal/5')).toBe(true)
    const { nodes } = causalGraph(v, '', new Date('2026-07-01T00:00:00Z'))
    expect(nodes.some((n) => n.id === 'anchor:src:src/gcal/5' && n.kind === 'anchor')).toBe(true)
    rmSync(v, { recursive: true, force: true })
  })

  it('THE ON-RAMP PAYOFF: a calendar event + related channel decisions → a CONVERGENCE forecast', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-onramp-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'future-nodes.jsonl'), '') // a true newcomer: zero authored streams
    // one calendar event → a future anchor
    writeChannelAnchors(v, channelEventsToAnchors([{ file: 'src/gcal/bw', text: '---\ntype: event\ndate: 2099-07-10\n---\n# BilibiliWorld booth\nx' }]))
    // three channel decisions whose titles overlap the anchor's title tokens → fuzzy-feed it
    const streams = extractedToStreams(
      {
        commitments: [],
        decisions: [
          { note: 'src/slack/1', decide_by: '2099-06-01', cleared: 'a', blocked: 'b' },
          { note: 'src/slack/2', decide_by: '2099-06-02', cleared: 'a', blocked: 'b' },
          { note: 'src/slack/3', decide_by: '2099-06-03', cleared: 'a', blocked: 'b' }
        ],
        risks: []
      },
      (id) => ({ title: `bilibiliworld booth ${id}`, track: '北澜' }) // titles carry the anchor's tokens
    )
    writeChannelFutures(v, streams)
    // the causal graph auto-links the 3 streams to the calendar anchor (fuzzy feeds) → convergence
    const fc = generateForecasts(v, new Date('2026-07-01T00:00:00Z'))
    const conv = fc.find((f) => f.kind === 'convergence' && f.subject === 'BilibiliWorld booth')
    expect(conv).toBeTruthy()
    expect(conv!.basis.length).toBeGreaterThanOrEqual(3) // the 3 channel decisions converge on the calendar event
    rmSync(v, { recursive: true, force: true })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractWorldUpdate, type WorldUpdateDeps } from './world-update-native'

describe('world-update-native', () => {
  let vault: string
  let deltas: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-wu-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    deltas = join(vault, '.duin', '_state', 'world-state-deltas.jsonl')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  const deps = (modelOut: string): WorldUpdateDeps => ({
    generate: async () => modelOut,
    now: () => new Date('2026-07-02T09:00:00'),
    id: () => 'fixedid1'
  })
  const rows = (): Array<Record<string, unknown>> =>
    readFileSync(deltas, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

  it('parses a valid model JSON into a proposed delta and appends it', async () => {
    const out = await extractWorldUpdate(
      vault,
      'Bilibili confirmed the BW booth',
      deps('{"track":"ProjectA","type":"situation","summary":"BW booth confirmed","change":"confirmed","affects":"BW","confidence":0.8}')
    )
    expect(out).toMatchObject({
      id: 'fixedid1',
      ts: '2026-07-02T09:00:00',
      track: 'ProjectA',
      type: 'situation',
      summary: 'BW booth confirmed',
      confidence: 0.8,
      status: 'proposed'
    })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].id).toBe('fixedid1')
  })

  it('falls back to keyword track + text summary when the model returns garbage', async () => {
    const out = await extractWorldUpdate(vault, 'the PartnerCo M&A pipeline', deps('no json here'))
    expect(out.track).toBe('PartnerCo') // keyword fallback via _track_of
    expect(out.summary).toBe('the PartnerCo M&A pipeline') // text[:120] fallback
    expect(out.status).toBe('proposed')
  })

  it('validates an unknown model track via the keyword fallback', async () => {
    const out = await extractWorldUpdate(vault, 'ProjectB lane B note', deps('{"track":"nonsense","type":"belief"}'))
    expect(out.track).toBe('ProjectB')
    expect(out.type).toBe('belief')
  })

  it('heuristic rescue upgrades situation→intent on a first-person plan marker', async () => {
    const out = await extractWorldUpdate(vault, 'I plan to ship the localization next week', deps('{"track":"ProjectA","type":"situation"}'))
    expect(out.type).toBe('intent')
  })

  it('defaults track to unknown when no keyword matches', async () => {
    const out = await extractWorldUpdate(vault, 'a totally generic sentence', deps('{}'))
    expect(out.track).toBe('unknown')
    expect(out.type).toBe('situation')
  })
})

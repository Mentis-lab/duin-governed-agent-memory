import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { actWorldUpdate, promoteBelief, subjectOverlap, buildPromotePrompt } from './world-update-act-write-native'

const NOW = new Date(2026, 6, 3)
const seedDeltas = (sd: string, rows: unknown[]): void => {
  writeFileSync(join(sd, 'world-state-deltas.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

describe('world-update-act — subjectOverlap (PURE)', () => {
  it('true on a shared affects token', () => {
    expect(subjectOverlap({ affects: 'TapTap launch' }, { affects: 'TapTap timing' })).toBe(true)
  })
  it('true on ≥2 shared affects+summary tokens', () => {
    expect(subjectOverlap({ affects: '', summary: 'bilibili event booth' }, { affects: '', summary: 'bilibili booth plan' })).toBe(true)
  })
  it('false when unrelated', () => {
    expect(subjectOverlap({ affects: 'alpha', summary: 'x' }, { affects: 'beta', summary: 'y' })).toBe(false)
  })
})

describe('world-update-act — actWorldUpdate', () => {
  let vault: string
  let sd: string
  const noReproject = { generate: async () => '{}', today: () => NOW, reproject: (): void => {} }
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-wua-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns {ok:false} for an unknown delta', async () => {
    seedDeltas(sd, [{ id: 'a', status: 'proposed' }])
    expect(await actWorldUpdate(vault, 'missing', 'confirm', noReproject)).toEqual({ ok: false })
  })

  it('discard sets status:discarded and does not reproject', async () => {
    seedDeltas(sd, [{ id: 'a', status: 'proposed', track: '北澜' }])
    let reprojected = false
    const out = await actWorldUpdate(vault, 'a', 'discard', { ...noReproject, reproject: () => { reprojected = true } })
    expect(out).toEqual({ ok: true, promoted: null })
    expect(JSON.parse(readFileSync(join(sd, 'world-state-deltas.jsonl'), 'utf-8').trim()).status).toBe('discarded')
    expect(reprojected).toBe(false)
  })

  it('confirm accepts + supersedes a prior live delta on the same track+type+subject + reprojects', async () => {
    seedDeltas(sd, [
      { id: 'old', status: 'accepted', track: '北澜', type: 'situation', affects: 'TapTap launch', summary: 'old' },
      { id: 'new', status: 'proposed', track: '北澜', type: 'situation', affects: 'TapTap launch', summary: 'new' }
    ])
    let reprojected = false
    const out = await actWorldUpdate(vault, 'new', 'confirm', { ...noReproject, reproject: () => { reprojected = true } })
    expect(out).toEqual({ ok: true, promoted: null })
    const rows = readFileSync(join(sd, 'world-state-deltas.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.find((r) => r.id === 'new').status).toBe('accepted')
    expect(rows.find((r) => r.id === 'old')).toMatchObject({ status: 'superseded', superseded_by: 'new' })
    expect(reprojected).toBe(true)
  })

  it('does NOT supersede a delta on a different track/type', async () => {
    seedDeltas(sd, [
      { id: 'other', status: 'accepted', track: 'orbis', type: 'situation', affects: 'TapTap launch' },
      { id: 'new', status: 'proposed', track: '北澜', type: 'situation', affects: 'TapTap launch' }
    ])
    await actWorldUpdate(vault, 'new', 'confirm', noReproject)
    const rows = readFileSync(join(sd, 'world-state-deltas.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.find((r) => r.id === 'other').status).toBe('accepted') // untouched
  })

  it('promote accepts + crystallizes an instinct card + sets promoted_to', async () => {
    mkdirSync(join(vault, '02 Cards', 'instincts'), { recursive: true })
    seedDeltas(sd, [{ id: 'b', status: 'proposed', track: '北澜', type: 'belief', summary: 'TQ thinks TapTap timing is the key lever', confidence: 0.7 }])
    const out = await actWorldUpdate(vault, 'b', 'promote', {
      generate: async () => '{"slug":"taptap timing lever","trigger":"when scheduling launch","action":"lock TapTap window first"}',
      today: () => NOW,
      reproject: (): void => {}
    })
    expect(out.promoted?.ok).toBe(true)
    expect(out.promoted?.id).toBe('I260703-taptap-timing-lever')
    const rows = readFileSync(join(sd, 'world-state-deltas.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0].promoted_to).toBe('I260703-taptap-timing-lever')
    const card = readFileSync(join(vault, '02 Cards', 'instincts', 'I260703-taptap-timing-lever.md'), 'utf-8')
    expect(card).toContain('type: instinct')
    expect(card).toContain('trigger: "when scheduling launch"')
    expect(card).toContain('*Promoted from a confirmed World-State belief (北澜, 2026-07-03).*')
  })
})

describe('world-update-act — promoteBelief', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pb-'))
    mkdirSync(join(vault, '02 Cards', 'instincts'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('sanitizes the slug + refuses to overwrite an existing card', async () => {
    const delta = { summary: 's', track: 'duin', type: 'intent' }
    const gen = { generate: async () => '{"slug":"My Great Idea!!","trigger":"t","action":"a"}', today: () => NOW }
    const first = await promoteBelief(vault, delta, gen)
    expect(first.id).toBe('I260703-my-great-idea') // spaces→-, non-alnum stripped
    const second = await promoteBelief(vault, delta, gen)
    expect(second).toEqual({ ok: false, error: 'exists' })
  })

  it('prompt is verbatim', () => {
    expect(buildPromotePrompt('S')).toContain('Turn this belief/intent of the operator\'s into an instinct')
    expect(buildPromotePrompt('S').endsWith('Belief: S')).toBe(true)
  })
})

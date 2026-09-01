import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readForecastConfidences, buildStyleFingerprint } from './style-fingerprint-service'

let vault: string
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-fp-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

const writeLedger = (rows: object[]) =>
  writeFileSync(join(vault, '.duin', '_state', 'risk-predictions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

describe('readForecastConfidences', () => {
  it('extracts numeric confidences, skips signal-mode + malformed', () => {
    writeLedger([
      { id: 'a', confidence: 0.9, kind: 'driver' },
      { id: 'b', confidence: 0.4, kind: 'cascade' },
      { id: 'c', confidence: 0.95, kind: 'decision-window' }, // signal → skipped
      { id: 'd', kind: 'driver' } // no confidence → skipped
    ])
    const cs = readForecastConfidences(vault).map((f) => f.confidence)
    expect(cs).toEqual([0.9, 0.4])
  })
  it('missing ledger → [] (no throw)', () => {
    expect(readForecastConfidences(vault)).toEqual([])
    expect(readForecastConfidences(null)).toEqual([])
  })
})

describe('buildStyleFingerprint — end-to-end wiring over a temp vault', () => {
  it('cold vault (no decisions, no forecasts) → empty axes, no drift, read-only', () => {
    const r = buildStyleFingerprint(vault, 1_720_000_000_000)
    expect(r.fingerprint.axes).toEqual([])
    expect(r.divergences).toEqual([])
    expect(r.scopedIdioms).toEqual([])
    expect(r.drift).toBeNull()
    expect(r.promotedFactCount).toBe(0)
  })

  it('decisions + forecasts flow through to the fingerprint object', () => {
    // real decision notes in the 05 Decisions pillar (listDecisions discovers them)
    const pillar = join(vault, '05 Decisions')
    mkdirSync(pillar, { recursive: true })
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(pillar, `d${i}.md`), `---\ntype: decision\nreversibility: one-way\ndate: 2026-0${(i % 9) + 1}-01\n---\n# Decision ${i}\n`)
    }
    writeLedger(Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, confidence: 0.9, kind: 'driver' })))
    const r = buildStyleFingerprint(vault, 1_720_000_000_000)
    const rev = r.fingerprint.axes.find((a) => a.id === 'reversibility-lean')!
    expect(rev.countA).toBe(20)
    expect(rev.gate).toBe('norm')
    expect(rev.lean).toBe('A')
    const fo = r.fingerprint.axes.find((a) => a.id === 'forecast-optimism')!
    expect(fo.n).toBe(15)
    expect(r.drift).not.toBeNull()
  })
})

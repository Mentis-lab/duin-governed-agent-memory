import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  registerRevealOutcome,
  readRevealOutcomes,
  revealTrustFromOutcomes,
  revealTrust,
  revealKind,
  type RevealOutcomeRecord
} from './reveal-outcomes'
import { calibration } from './calibration-native'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'reveal-outcomes-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function rec(verdict: 'materialized' | 'refuted', kind = 'llm:mentions'): RevealOutcomeRecord {
  const [source, edgeType] = kind.split(':')
  return { kind, source: source as 'llm', edgeType, confidence: 0.6, verdict, ts: '2026-07-18T00:00:00Z' }
}

describe('revealKind + revealTrustFromOutcomes (pure)', () => {
  it('keys trust per source:edge-type', () => {
    expect(revealKind('llm', 'contradicts')).toBe('llm:contradicts')
  })

  it('computes endorse-rate + Wilson lower bound; higher endorsement => higher trust', () => {
    const mostlyGood = revealTrustFromOutcomes([...Array(9).fill(rec('materialized')), rec('refuted')])
    const mostlyBad = revealTrustFromOutcomes([...Array(9).fill(rec('refuted')), rec('materialized')])
    const g = mostlyGood.get('llm:mentions')!
    const b = mostlyBad.get('llm:mentions')!
    expect(g.n).toBe(10)
    expect(g.wilson_lo).toBeGreaterThan(b.wilson_lo)
    expect(g.wilson_lo).toBeGreaterThanOrEqual(0)
    expect(g.wilson_lo).toBeLessThanOrEqual(1)
  })

  it('gates trust until CAL_MIN_N (20) samples accrue', () => {
    const small = revealTrustFromOutcomes(Array(19).fill(rec('materialized')))
    const enough = revealTrustFromOutcomes(Array(20).fill(rec('materialized')))
    expect(small.get('llm:mentions')!.gated).toBe(true)
    expect(enough.get('llm:mentions')!.gated).toBe(false)
  })

  it('separates trust by source AND edge-type', () => {
    const t = revealTrustFromOutcomes([rec('materialized', 'llm:contradicts'), rec('refuted', 'wiki:mentions')])
    expect([...t.keys()].sort()).toEqual(['llm:contradicts', 'wiki:mentions'])
  })
})

describe('writer + vault read', () => {
  it('registers and reloads outcomes', () => {
    const vault = tmpVault()
    registerRevealOutcome(vault, rec('materialized'))
    registerRevealOutcome(vault, rec('refuted'))
    expect(readRevealOutcomes(vault)).toHaveLength(2)
    expect(revealTrust(vault).get('llm:mentions')!.n).toBe(2)
  })
})

describe('canonical calibration() domain wiring', () => {
  it('surfaces reveal outcomes as the "reveal" calibration domain', () => {
    const vault = tmpVault()
    for (let i = 0; i < 20; i++) registerRevealOutcome(vault, rec(i < 15 ? 'materialized' : 'refuted'))
    const cal = calibration(vault)
    expect(cal.totals.by_domain.reveal).toBeDefined()
    expect(cal.totals.by_domain.reveal.total).toBe(20)
  })
})

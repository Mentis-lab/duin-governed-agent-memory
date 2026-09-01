import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import {
  readRsiTunables,
  rsiTunablesPath,
  RSI_TUNABLE_DEFAULTS,
  RSI_TUNABLE_BOUNDS
} from './rsi-tunables'

// The RSI knob-space is now multi-knob (AlphaEvolve population). Both tunables must
// read + clamp to safe bounds; a corrupt file can never push the brain out of envelope.

const dirs: string[] = []
function vaultWith(json: unknown): string {
  const v = mkdtempSync(join(tmpdir(), 'rsi-tun-'))
  dirs.push(v)
  const p = rsiTunablesPath(v)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(json), 'utf-8')
  return v
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('readRsiTunables — multi-knob population', () => {
  it('missing vault ⇒ defaults for BOTH knobs', () => {
    expect(readRsiTunables(null)).toEqual(RSI_TUNABLE_DEFAULTS)
    expect(RSI_TUNABLE_DEFAULTS.recallFailureLimit).toBe(20)
  })

  it('reads a valid recallFailureLimit', () => {
    expect(readRsiTunables(vaultWith({ recallFailureLimit: 15 })).recallFailureLimit).toBe(15)
  })

  it('clamps recallFailureLimit to [10,30] (out-of-range can never escape the envelope)', () => {
    expect(readRsiTunables(vaultWith({ recallFailureLimit: 999 })).recallFailureLimit).toBe(30)
    expect(readRsiTunables(vaultWith({ recallFailureLimit: 0 })).recallFailureLimit).toBe(10)
    expect(RSI_TUNABLE_BOUNDS.recallFailureLimit).toEqual({ min: 10, max: 30 })
  })

  it('a corrupt recallFailureLimit falls back to its default', () => {
    expect(readRsiTunables(vaultWith({ recallFailureLimit: 'nope' })).recallFailureLimit).toBe(20)
  })

  it('both knobs are independent (one corrupt does not blank the other)', () => {
    const t = readRsiTunables(vaultWith({ namedSkillTopK: 5, recallFailureLimit: 'x' }))
    expect(t).toEqual({ namedSkillTopK: 5, recallFailureLimit: 20 })
  })
})

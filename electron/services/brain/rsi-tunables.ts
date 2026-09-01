// rsi-tunables.ts — the SAFE, brain-read config knobs the RSI self-improve loop is allowed to tune.
// Every value is CLAMPED on read to a bounded range, so a corrupt/out-of-range tunables file (or a
// bad proposed change) can NEVER push the brain outside a safe envelope — the clamp is the floor of
// safety under the RSI loop. Stored at <vault>/.duin/_state/rsi-tunables.json — the one .duin config
// the rsi-proposer is permitted to edit. Missing file ⇒ defaults (byte-identical to pre-RSI behavior).
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface RsiTunables {
  /** how many distilled named-skills to inject into the grounding (Phase 1 read-back). clamp [1,5]. */
  namedSkillTopK: number
  /** how many recent failures to pull into the recall candidate pool (breadth of the
   *  "what went wrong before" grounding). Second RSI knob → a multi-knob population
   *  (AlphaEvolve) the QD archive explores, not a single greedy dimension. clamp [10,30]. */
  recallFailureLimit: number
}

export const RSI_TUNABLE_DEFAULTS: RsiTunables = { namedSkillTopK: 3, recallFailureLimit: 20 }
export const RSI_TUNABLE_BOUNDS: Record<keyof RsiTunables, { min: number; max: number }> = {
  namedSkillTopK: { min: 1, max: 5 },
  recallFailureLimit: { min: 10, max: 30 },
}

export function rsiTunablesPath(vault: string): string {
  return join(vault, '.duin', '_state', 'rsi-tunables.json')
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}

/** Read the tunables, CLAMPED to safe bounds. Missing/corrupt file ⇒ defaults. Never throws. */
export function readRsiTunables(vault: string | null): RsiTunables {
  if (!vault) return { ...RSI_TUNABLE_DEFAULTS }
  try {
    const p = rsiTunablesPath(vault)
    if (!existsSync(p)) return { ...RSI_TUNABLE_DEFAULTS }
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<RsiTunables>
    const bTopK = RSI_TUNABLE_BOUNDS.namedSkillTopK
    const bFail = RSI_TUNABLE_BOUNDS.recallFailureLimit
    return {
      namedSkillTopK: clampInt(raw.namedSkillTopK, bTopK.min, bTopK.max, RSI_TUNABLE_DEFAULTS.namedSkillTopK),
      recallFailureLimit: clampInt(
        raw.recallFailureLimit,
        bFail.min,
        bFail.max,
        RSI_TUNABLE_DEFAULTS.recallFailureLimit
      )
    }
  } catch {
    return { ...RSI_TUNABLE_DEFAULTS }
  }
}

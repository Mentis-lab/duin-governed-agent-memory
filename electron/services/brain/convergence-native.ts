// Native port of resources/brain/server.py :: _convergence (1196) and
// _subject_overlap (918) — the pure ranking leaves of §4b (futures).
//
// _convergence(subject, pool) → [count, activity, grounding]: how many weighted
// evidence layers share >=2 significant tokens with the subject. Weight <=1.5 =
// ACTIVITY (short-term/tasks — the gate); weight >=2.0 = GROUNDING (foundation/
// project/cards — the amplifier). This is what ranks a stream mentioned everywhere
// above one mentioned once, without hardcoding.
//
// Pure given the pool — the pool assembly (_convergence_pool: goals/strategy/cards/
// deltas/tasks/risks contexts) is the fs-heavy piece ported separately. Golden-locked.
import { sigTokens } from './sig-tokens-native'

/** One weighted evidence layer: [text, weight]. */
export type PoolEntry = [string, number]

function interSize(a: Set<string>, b: Set<string>): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a]
  let n = 0
  for (const x of s) if (l.has(x)) n++
  return n
}

/** Python round(x, 1), round-half-to-even. Convergence weights are 0.5-multiples
 *  (exact in float), but replicate the banker's rounding faithfully for safety. */
function pyRound1(x: number): number {
  const scaled = x * 10
  const fl = Math.floor(scaled)
  const diff = scaled - fl
  const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1
  return r / 10
}

/** Port of _convergence → [count, activity, grounding]. */
export function convergence(subject: string, pool: PoolEntry[]): [number, number, number] {
  const st = sigTokens(subject)
  if (st.size === 0) return [0, 0.0, 0.0]
  let count = 0
  let activity = 0.0
  let grounding = 0.0
  for (const [text, w] of pool) {
    if (interSize(sigTokens(text), st) >= 2) {
      count++
      if (w <= 1.5) activity += w
      else grounding += w
    }
  }
  return [count, pyRound1(activity), pyRound1(grounding)]
}

/** Port of _subject_overlap: same subject if affects-tokens intersect, OR >=2
 *  significant tokens shared across affects+summary. */
export function subjectOverlap(
  r1: { affects?: string; summary?: string },
  r2: { affects?: string; summary?: string }
): boolean {
  const a1 = sigTokens(r1.affects || '')
  const a2 = sigTokens(r2.affects || '')
  if (interSize(a1, a2) >= 1) return true
  const t1 = new Set(a1)
  for (const x of sigTokens(r1.summary || '')) t1.add(x)
  const t2 = new Set(a2)
  for (const x of sigTokens(r2.summary || '')) t2.add(x)
  return interSize(t1, t2) >= 2
}

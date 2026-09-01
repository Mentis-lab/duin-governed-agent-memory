// claim-ledger — the persistence + world-state wiring for the claim-metabolism verdict engine
// (see claim-metabolism.ts). SHADOW-FIRST by design: runShadowMetabolism() runs the deterministic
// verdicts against the live world-state and reports what WOULD be verdicted, WITHOUT persisting
// the retirements back or touching the retrieval score. That's the design's "surface, don't
// silently penalize — spot-check before you auto-penalize" discipline, so a wrong verdict can
// only be *seen*, never silently bury content.
//
// NOTE: claim EXTRACTION (notes/chunks → Claim rows) is the Phase-0 substrate and is deliberately
// NOT here yet — this module reads whatever the ledger already holds. Until extraction lands the
// ledger is empty and the route reports an empty (harmless) result; the plumbing + world-state
// judge are in place and inspectable.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { isPinned, type Claim, type WorldState } from './claim-metabolism'
import { migrateLegacyProseTripleIds } from './claim-ids'
import { messageOf } from '../guarded'

function ledgerPath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'claim-ledger.jsonl')
}

export function loadLedger(vaultDir: string): Claim[] {
  const p = ledgerPath(vaultDir)
  if (!existsSync(p)) return []
  const out: Claim[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as Claim)
    } catch (e) { console.debug('[claim-ledger] skip a corrupt line rather than fail the whole load:', messageOf(e)) }
  }
  // One-time, idempotent migration: re-key legacy note-less prose triple ids so a re-derived
  // extraction matches them and carries forward their verdict/validTo/pins. See claim-ids.ts.
  return migrateLegacyProseTripleIds(out)
}

// The ledger is rewritten whole on every save, so bound it — retain the most
// recent entries (by append position) so it can't grow unbounded (and the O(n)
// rewrite can't blow up) across a long-lived install.
const MAX_LEDGER_CLAIMS = 5000
/** How many cap-evicted rows to retain as tombstones (traceability without unbounded growth). */
const MAX_LEDGER_EVICTIONS = 2000

function evictionsPath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'claim-ledger-evictions.jsonl')
}

/** A row the CAP removed, with when + why, so an eviction is traceable instead of silent. */
export interface ClaimEviction {
  evictedAt: number
  reason: 'cap'
  claim: Claim
}

/**
 * A claim row the CAP must never evict by array position.
 *
 * `isPinned` is the SAME guard the rest of the pipeline already uses (mergeLedger, runVerdicts,
 * applySupersessionGuards, reconcileLedgerForPersist) — a human ruling recorded via
 * applyClaimResolution ('confirm'/'revert'). `operatorAuthored` marks a claim the operator wrote
 * rather than one the extractor inferred. Neither is re-derivable: the claim row itself can be
 * re-extracted from the vault, but the operator's DECISION exists nowhere else, and the write here
 * is a whole-file rename-over with no journal. Dropping such a row silently un-does the ruling —
 * the next tick re-extracts the claim unpinned and the deterministic pass re-applies exactly the
 * retirement the operator reverted (the "decision survives every tick" promise in
 * resolveClaimReview's docstring).
 */
function capProtected(c: Claim): boolean {
  return isPinned(c) || c.operatorAuthored === true
}

/**
 * PURE: apply the size cap WITHOUT dropping operator-ruled rows.
 *
 * DEFECT this replaces: `claims.slice(-MAX_LEDGER_CLAIMS)` capped by array POSITION alone. Every
 * other stage of the pipeline checks `isPinned` before touching a row; the writer — the one place
 * where the drop is permanent — did not. reconcileLedgerForPersist returns
 * `[...toPersist, ...rescuedPins]`, so RESCUED pins sit in the tail and survive slice(-N), but a pin
 * that DID survive extraction sits at an arbitrary position inside toPersist and the slice cuts the
 * HEAD of exactly that array. Both the wipe-guard and the pin re-injection run strictly before the
 * cap, so neither covers it.
 *
 * Rule: protected rows are never evictable. The cap is spent on the protected rows first, and only
 * the UNPROTECTED remainder is trimmed (most recent kept, matching the old by-append-position
 * intent). Relative order is preserved so the file stays append-ordered. If protected rows alone
 * exceed the cap we keep them all and let the file run over — capacity is a soft budget, an
 * operator's ruling is not.
 */
export function capLedgerClaims(claims: Claim[], max = MAX_LEDGER_CLAIMS): { kept: Claim[]; evicted: Claim[] } {
  if (claims.length <= max) return { kept: claims, evicted: [] }
  const protectedCount = claims.reduce((n, c) => n + (capProtected(c) ? 1 : 0), 0)
  const unprotectedBudget = Math.max(0, max - protectedCount)
  // Walk from the NEWEST end so the surviving unprotected rows are the most recent ones.
  const drop = new Set<number>()
  let seenUnprotected = 0
  for (let i = claims.length - 1; i >= 0; i--) {
    if (capProtected(claims[i])) continue
    seenUnprotected++
    if (seenUnprotected > unprotectedBudget) drop.add(i)
  }
  const kept: Claim[] = []
  const evicted: Claim[] = []
  claims.forEach((c, i) => (drop.has(i) ? evicted : kept).push(c))
  return { kept, evicted }
}

/** Append cap-evicted rows to a bounded tombstone JSONL so "where did that claim go?" is answerable. */
function recordEvictions(vaultDir: string, evicted: Claim[], now: number): void {
  if (!evicted.length) return
  const p = evictionsPath(vaultDir)
  try {
    const prior: string[] = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()) : []
    const fresh = evicted.map((c) => JSON.stringify({ evictedAt: now, reason: 'cap', claim: c } satisfies ClaimEviction))
    const all = [...prior, ...fresh].slice(-MAX_LEDGER_EVICTIONS)
    const tmp = p + '.tmp'
    writeFileSync(tmp, all.join('\n') + '\n', 'utf-8')
    renameSync(tmp, p)
  } catch (e) {
    // Never let tombstoning fail the ledger write itself — but say so loudly, because a failed
    // tombstone means this eviction batch is untraceable.
    console.warn('[claim-ledger] failed to record cap evictions (rows dropped WITHOUT a tombstone):', messageOf(e))
  }
}

/** Read the cap-eviction tombstones (audit surface for "the cap dropped something"). */
export function loadLedgerEvictions(vaultDir: string): ClaimEviction[] {
  const p = evictionsPath(vaultDir)
  if (!existsSync(p)) return []
  const out: ClaimEviction[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as ClaimEviction)
    } catch (e) { console.debug('[claim-ledger] skip a corrupt eviction line:', messageOf(e)) }
  }
  return out
}

export function saveLedger(vaultDir: string, claims: Claim[], now = Date.now()): void {
  const p = ledgerPath(vaultDir)
  mkdirSync(dirname(p), { recursive: true })
  // CAP (data-loss fix): pin-aware, and every dropped row is tombstoned — see capLedgerClaims.
  const { kept: capped, evicted } = capLedgerClaims(claims)
  recordEvictions(vaultDir, evicted, now)
  // ATOMIC write (data-loss fix): write a temp file then rename over the target, so a crash
  // mid-write can't truncate the ledger jsonl (the whole file is rewritten each save).
  const body = capped.map((c) => JSON.stringify(c)).join('\n') + (capped.length ? '\n' : '')
  const tmp = p + '.tmp'
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, p)
}

/** 'YYYY-MM-DD' (or 'YYYY-MM') → epoch ms, or null if unparseable. */
export function parseDateMs(s: string | undefined | null): number | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1)
  return Number.isNaN(t) ? null : t
}

const RESOLVED_STATUS = /resolved|closed|done|archived|decided-final/i
const PASSED_STATUS = /done|complete|passed|closed|cleared/i

/**
 * PURE: map the loaded world rows → the WorldState the judge reads. Conservative, deterministic
 * signals only — a decision is "resolved" once its review window has passed (or status says so);
 * a stream is "passed" once its decide-by date is behind us (or status says so).
 *
 * ANCHORS (world-model Stage 1): an anchor is "past" once its window has CLOSED — `window_end` if
 * present, else `date` — strictly before `now`. Both the anchor id and its display name are added,
 * because claim refs (subject / object / justifications) cite anchors either way. Anchors with no
 * parseable date are skipped entirely rather than guessed at: the original deferral here was about
 * never emitting a low-confidence 'past anchor' verdict, and that discipline is preserved — an
 * anchor only enters the set when its closure is unambiguous. Matching is exact-string, the same
 * rule already used for decisions and streams, so this adds no new class of false positive.
 */
export function gatherWorldState(
  decisions: { id: string; status?: string; reviewOn?: string }[],
  streams: { id?: string; status?: string; decide_by?: string }[],
  now: number,
  anchors: { id?: string; name?: string; date?: string; window_end?: string }[] = []
): WorldState {
  const resolvedDecisions = new Set<string>()
  for (const d of decisions) {
    const reviewMs = parseDateMs(d.reviewOn)
    if ((reviewMs !== null && reviewMs < now) || (d.status && RESOLVED_STATUS.test(d.status))) {
      resolvedDecisions.add(d.id)
    }
  }
  const passedStreams = new Set<string>()
  for (const s of streams) {
    if (!s.id) continue
    const byMs = parseDateMs(s.decide_by)
    if ((byMs !== null && byMs < now) || (s.status && PASSED_STATUS.test(s.status))) {
      passedStreams.add(s.id)
    }
  }
  const pastAnchors = new Set<string>()
  for (const a of anchors) {
    // Closure = the END of the window when there is one; a multi-day event is not past on day 1.
    const endMs = parseDateMs(a.window_end) ?? parseDateMs(a.date)
    if (endMs === null || endMs >= now) continue
    if (a.id) pastAnchors.add(a.id)
    if (a.name) pastAnchors.add(a.name)
  }
  return { pastAnchors, resolvedDecisions, passedStreams }
}


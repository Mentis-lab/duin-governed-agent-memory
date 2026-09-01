// claim-recall — read-side arm of the claim-metabolism moat (Memory S4). The verdict engine
// (claim-metabolism.ts) decides which claims are RETIRED (superseded / stale / orphaned) and
// persists them (claim-extract.ts::runLiveMetabolism). This closes the loop on the READ side: a
// one-shot retrieval hit whose note is backed by a retired claim is DEMOTED, so the answer model
// grounds on fresh evidence instead of a superseded note the embedder still found "similar".
//
// Conservative BY DESIGN — the fix for the "called by mistake" failure must never bury a good note:
//   - DEMOTE, never drop: the hit's score is multiplied down and clamped at FRESH_FLOOR, then the
//     list is re-ranked. A demoted hit can still surface if nothing fresher matched.
//   - Match a retired claim to a hit only on a HIGH-precision signal: a basename join
//     (basename(claim.notePath) === basename(hit.file)) OR a token overlap that covers ≥75% of the
//     CLAIM's tokens (see MIN_COVERAGE) between the claim's subject/object and the hit.
//   - PURE + generic over {file, snippet?, score} so it unit-tests without the index store.
//
// GATED (DUIN_CLAIM_RECALL) and ledger-driven: with the live metabolism off the persisted ledger
// is empty ⇒ no retired claims ⇒ a no-op. Real lift accrues as the ledger fills. See
// [[claim-metabolism]] (freshness/FRESH_FLOOR) and [[claim-extract]] (runLiveMetabolism persist).

import { basename } from 'path'
import { type Claim, freshness, FRESH_FLOOR } from './claim-metabolism'
import { cjkTokens } from './cjk-tokens'

/**
 * Fraction of a RETIRED CLAIM's own tokens that must appear in the hit for the token arm to fire.
 * Coverage, not a raw count: the claim side is a short subject/object phrase while the hit side is a
 * filename plus a ~240-char snippet, so an ABSOLUTE "≥2 shared tokens" threshold is trivially met by
 * incidental collisions (dates, 公司/合作/渠道, a shared vendor name) and the demoter degenerates into
 * a blanket one. Measured on the live 342-retired-claim ledger against the top-5 hits of 25 probes:
 * the shipped rule fired on 84.8% of hits (83.9% of CJK ones); ≥2-shared + coverage ≥ 0.75 fires on
 * 34.4%, against a floor of 22.4% for the basename join alone — i.e. the alias arm still contributes
 * real matches (ProjectA (ProjectA) → ProjectA/…/商务双周报, 赵慕青 (Nora) → 半导体-SupplierCo/BRAIN.md) instead of
 * matching everything.
 */
const MIN_COVERAGE = 0.75
/** A token arm still needs ≥2 shared tokens: one common token at coverage 1.0 is a 1-token claim. */
const MIN_SHARED = 2

const HOUR = 3_600_000
const DEFAULT_STALE_H = 24

/**
 * Freshness threshold (ms) beyond which the ledger's RETIRED verdicts are treated as untrustworthy
 * and demotion is skipped. DUIN_CLAIM_RECALL_STALE_H overrides the 24h default; ≤ 0 (or "off")
 * DISABLES the gate (always demote — the pre-gate behaviour). Flag-safe by construction.
 */
export function ledgerStaleThresholdMs(): number {
  const raw = process.env.DUIN_CLAIM_RECALL_STALE_H
  if (raw !== undefined) {
    if (/^off$/i.test(raw.trim())) return Number.POSITIVE_INFINITY
    const h = Number(raw)
    if (Number.isFinite(h)) return h <= 0 ? Number.POSITIVE_INFINITY : h * HOUR
  }
  return DEFAULT_STALE_H * HOUR
}

/**
 * Best-effort "when was this ledger last metabolized", derived from the freshest write-time stamp
 * across its claims. The metabolism re-stamps `observedAt` to `now` for every surviving claim each
 * healthy tick and sets `validTo` = write-time when it retires one, so the MAX of these lags real
 * time exactly by how long the metabolism has been FROZEN. Returns null when the ledger carries no
 * usable timestamp (⇒ caller cannot judge staleness ⇒ demotes as before — the safe default). The
 * server passes only the loaded array (not the vault dir), so a data-derived clock — not an fs
 * mtime — is what keeps this gate working on the live 3-arg call without touching the server.
 */
export function ledgerUpdatedAt(ledger: Claim[]): number | null {
  let max = 0
  for (const c of ledger) {
    const t = Math.max(c.observedAt ?? 0, c.validFrom ?? 0, c.validTo ?? 0, c.lastUsefulAt ?? 0)
    if (t > max) max = t
  }
  return max > 0 ? max : null
}

// Common non-distinctive words excluded from the overlap match — otherwise a retired claim whose
// subject/object contains e.g. "project"/"meeting"/"should" spends its coverage budget on tokens
// that match everything. (CJK bigrams aren't affected — a bigram is never an English stopword.)
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'will',
  'would', 'should', 'could', 'about', 'into', 'than', 'then', 'they', 'their', 'there', 'which',
  'what', 'when', 'where', 'project', 'meeting', 'because', 'status', 'update', 'decision', 'plan',
  'notes', 'note', 'todo', 'task', 'value', 'thing', 'stuff', 'other', 'these', 'those', 'been'
])

/** Word/number tokens, lowercased, minus common non-distinctive stopwords. CJK runs become
 *  overlapping BIGRAMS via the shared [[cjk-tokens]] tokenizer: the whole-run tokens this used to
 *  emit were clause-length, so they only ever matched an exact clause repeat — the CJK half of this
 *  join was effectively dead, and what fired instead was the ≥5-char "strong token" shortcut. */
function tokenize(s: string): Set<string> {
  return new Set(cjkTokens(s, { stop: STOPWORDS }))
}

/**
 * High-precision overlap: ≥MIN_SHARED shared tokens AND those covering ≥MIN_COVERAGE of `a`
 * (the CLAIM side — the short, specific one). Direction matters: coverage is measured over the
 * claim's tokens, so "does this hit contain substantially all of what the claim is about?", not
 * "do these two strings happen to share a couple of words". The old ≥5-char strong-token shortcut
 * is GONE — measured, it was the dominant false-match source (re-adding it to this rule pushes the
 * fire rate straight back from 34.4% to 76.8%), because one longish shared token says nothing about
 * whether the hit is the claim's subject.
 */
function overlaps(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0) return false
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared >= MIN_SHARED && shared / a.size >= MIN_COVERAGE
}

/**
 * The SYMMETRIC read of the freshness matcher (store.reinforce-arm): the ids of ACTIVE claims
 * (validTo===null) whose backing note SURVIVED in the grounding hits — i.e. was retrieved, wasn't
 * demoted as stale, and went into the prompt. That is "usefully recalled" (the claim's note grounded
 * the answer), NOT the refuted reinforce-on-re-observation. Same high-precision join as
 * applyClaimFreshness (basename OR the coverage-gated token overlap). Returns {id, base} so a caller
 * can additionally require the base was CITED in the endorsed answer. PURE.
 */
export function activeClaimsForHits(
  hits: { file: string; snippet?: string }[],
  ledger: Claim[]
): { id: string; base: string }[] {
  if (hits.length === 0) return []
  const active = ledger.filter((c) => c.validTo === null)
  if (active.length === 0) return []
  const hitInfo = hits.map((h) => ({
    base: basename(h.file || '').toLowerCase(),
    tokens: tokenize(`${basename(h.file || '')} ${h.snippet ?? ''}`)
  }))
  const out: { id: string; base: string }[] = []
  for (const c of active) {
    const cbase = basename(c.notePath || '').toLowerCase()
    const ctokens = tokenize(`${c.subject} ${c.object} ${c.entityKey ?? ''}`)
    if (hitInfo.some((h) => (cbase && cbase === h.base) || overlaps(ctokens, h.tokens))) {
      out.push({ id: c.id, base: cbase })
    }
  }
  return out
}

/**
 * Re-rank hits by demoting any whose note is backed by a RETIRED claim. Returns a NEW array in the
 * adjusted order (stable for ties); never drops a hit and never reorders when nothing matches. The
 * demotion multiplier is the retired claim's freshness (HARD_PENALTY) clamped up to FRESH_FLOOR, so
 * a superseded note sinks below fresh peers without being buried.
 */
export function applyClaimFreshness<T extends { file: string; snippet?: string; score: number }>(
  hits: T[],
  ledger: Claim[],
  now: number,
  opts?: { ledgerUpdatedAt?: number | null; staleThresholdMs?: number }
): T[] {
  if (hits.length < 2) return hits
  const retired = ledger.filter((c) => c.validTo !== null)
  if (!retired.length) return hits
  // FRESHNESS GATE. A retired verdict is only trustworthy while the metabolism is actually running.
  // If the ledger has not been written for longer than the threshold (the metabolism froze — the
  // exact failure this phase fixes upstream), do NOT demote a LIVE retrieval hit on a multi-day-stale
  // "retired" flag that may itself be obsolete. Skip demotion entirely (never bury a good note on
  // stale evidence). Unknown age (null) ⇒ demote as before — the conservative default preserves the
  // moat. Env DUIN_CLAIM_RECALL_STALE_H tunes/disables it.
  const updatedAt = opts?.ledgerUpdatedAt !== undefined ? opts.ledgerUpdatedAt : ledgerUpdatedAt(ledger)
  const threshold = opts?.staleThresholdMs ?? ledgerStaleThresholdMs()
  if (updatedAt !== null && now - updatedAt > threshold) {
    console.debug(
      `[claim-recall] ledger stale (${((now - updatedAt) / HOUR).toFixed(1)}h > ` +
        `${(threshold / HOUR).toFixed(1)}h) — skipping demotion; not demoting live hits on stale verdicts.`
    )
    return hits
  }
  const retiredInfo = retired.map((c) => ({
    base: basename(c.notePath || '').toLowerCase(),
    // Include the resolved canonical entity (claim-entities.ts) so recall matches a hit that uses a
    // DIFFERENT alias of the same entity than this claim's raw subject.
    tokens: tokenize(`${c.subject} ${c.object} ${c.entityKey ?? ''}`),
    claim: c
  }))

  const scored = hits.map((h, i) => {
    const hbase = basename(h.file || '').toLowerCase()
    const htokens = tokenize(`${basename(h.file || '')} ${h.snippet ?? ''}`)
    const match = retiredInfo.find((r) => (r.base && r.base === hbase) || overlaps(r.tokens, htokens))
    const score = match ? h.score * Math.max(FRESH_FLOOR, freshness(match.claim, now)) : h.score
    return { hit: h, score, i }
  })
  // Only re-materialize when something actually moved — otherwise return the input untouched.
  const changed = scored.some((s) => s.score !== s.hit.score)
  if (!changed) return hits
  scored.sort((a, b) => b.score - a.score || a.i - b.i) // stable: ties keep original order
  return scored.map((s) => ({ ...s.hit, score: s.score }))
}

/** Whether read-side claim-recall demotion is switched on. Default ON (validated live: demotes
 *  hits backed by retired claims without burying good notes — grounding stayed rich).
 *  DUIN_CLAIM_RECALL=0 ⇒ byte-identical retrieval (no demotion). */
export function claimRecallEnabled(): boolean {
  return process.env.DUIN_CLAIM_RECALL !== '0'
}

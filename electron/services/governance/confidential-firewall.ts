// confidential-firewall — the egress firewall (legacy harness adjudicator._is_confidential_lane
// / content_jury.firewall_clear). A HARD block: content on a confidential lane must NEVER
// reach an external model (the cross-family jury, the A/B measurer, any cloud call the
// operator didn't explicitly drive). When a send would carry flagged content, the caller
// ABSTAINS rather than leaks — the harness's rule is "abstain, don't send," and a lost
// second-opinion is always cheaper than an IP/personal-data leak.
//
// This guards AUTONOMOUS background sends (govern jury, judgment-measure), not the
// operator's own chosen chat model — that's the operator's explicit choice. Pure +
// unit-tested. The denylist is overridable so project-specific lanes can be added without
// a code change.

import { readSettings } from '../settings-helper'

/** Confidential-lane terms (IP + personal). Case-insensitive substring match.
 *
 *  COLD-START A3 (2026-07-25): the shipped default is EMPTY, and the real terms live in per-vault
 *  state at `.duin/_state/confidential-denylist.json`.
 *
 *  This list is FUNCTIONAL, not decorative — it is what stops a pre-release title or a colleague's
 *  name reaching an external model. It previously shipped the author's actual confidential terms
 *  compiled into the binary, which is the exact leak this workstream exists to close: every user
 *  received the author's IP list, and it told them what the secrets were.
 *
 *  Empty is the correct default because the terms are per-operator: a fresh install has no
 *  confidential lanes to protect. An operator with real ones MUST populate the vault file — see
 *  loadConfidentialDenylist. The firewall is only as good as that file, so it fails OPEN on an
 *  empty list by design (there is nothing to block), not by accident. */
export const DEFAULT_DENYLIST: string[] = []

export interface FirewallResult {
  /** true ⇒ contains confidential content and must NOT be sent externally. */
  blocked: boolean
  /** which denylist terms tripped it (for the abstain log). */
  hits: string[]
}

/** Does this text carry confidential-lane content? PURE. Case-insensitive; CJK terms
 *  match as substrings (no word boundaries), Latin terms match on word-ish boundaries so a short
 *  latin term doesn't fire inside a longer token (e.g. "3rd" must not match "23rd"). */
export function inspect(text: string, denylist: string[] = activeDenylist()): FirewallResult {
  const t = (text ?? '').toLowerCase()
  if (!t) return { blocked: false, hits: [] }
  const hits: string[] = []
  for (const raw of denylist) {
    const term = raw.toLowerCase()
    if (!term) continue
    const isLatin = [...term].every((c) => c.charCodeAt(0) < 128)
    let hit: boolean
    if (isLatin) {
      // boundary-aware: not preceded/followed by a word char (avoids 23rd / substrings)
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      hit = new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'i').test(t)
    } else {
      hit = t.includes(term) // CJK — substring is the right granularity
    }
    if (hit) hits.push(raw)
  }
  return { blocked: hits.length > 0, hits }
}

/** true ⇒ SAFE to send this text to an external model. PURE. */
export function firewallClear(text: string, denylist: string[] = activeDenylist()): boolean {
  return !inspect(text, denylist).blocked
}

/** Guard a batch of texts (e.g. all messages in an external request): blocked if ANY
 *  fragment is confidential. PURE. */
export function firewallClearAll(texts: string[], denylist: string[] = activeDenylist()): FirewallResult {
  const hits = new Set<string>()
  for (const t of texts) for (const h of inspect(t, denylist).hits) hits.add(h)
  return { blocked: hits.size > 0, hits: [...hits] }
}

// The list in force for the CURRENT vault. Resolved lazily on first use so every existing
// call site (firewallClear(text) with no second arg) keeps its protection without being
// rewritten — an egress guard that requires each caller to remember to pass a list is one
// forgotten call away from a leak.
let _activeDenylist: string[] | null = null

export function activeDenylist(): string[] {
  if (_activeDenylist) return _activeDenylist
  let dir: string | null
  try {
    // STATIC import, deliberately. This was a lazy `require('../settings-helper')` on the theory
    // that a static import would drag the settings layer into this pure guard — but a bare
    // require is copied verbatim into the single-file out/main/index.js, where '../settings-helper'
    // does not resolve. It threw on every call, `dir` fell to null, and loadConfidentialDenylist
    // returns [] for a null dir: THE EGRESS FIREWALL RAN WITH AN EMPTY DENYLIST IN EVERY PACKAGED
    // BUILD, including on vaults that had a populated confidential-denylist.json. Confirmed
    // 2026-08-04 by reading the shipped asar.
    //
    // A static import is safe here and is the same fix skill-loader.ts already carries: there is
    // no cycle, settings-helper explicitly tolerates a missing electron `app` (so tests and
    // non-main contexts still import cleanly), and nothing under src/ imports this module, so the
    // renderer is unaffected. This value is needed SYNCHRONOUSLY by a security check, so
    // fire-and-forget import() — the fix used for the best-effort audit sinks — is not applicable.
    dir = (readSettings().localBrainNotesDir as string) || null
  } catch {
    dir = null
  }
  _activeDenylist = loadConfidentialDenylist(dir)
  return _activeDenylist
}

/** TEST/boot hook: force the active list (null ⇒ re-resolve from the vault on next use). */
export function setActiveDenylist(list: string[] | null): void {
  _activeDenylist = list
}

/** Load the operator's confidential terms from vault state. Best-effort: a missing or malformed
 *  file yields an EMPTY list, which blocks nothing — so a vault that needs protection must have
 *  this file. Callers that guard autonomous egress should pass the result into `inspect`. */
export function loadConfidentialDenylist(vaultDir: string | null | undefined): string[] {
  if (!vaultDir) return []
  try {
    // Lazy requires: keep this module importable where fs/path are unavailable (it is a pure
    // string guard used from tests and the renderer-facing contract surface).
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    const { join } = require('node:path') as typeof import('node:path')
    const raw = JSON.parse(
      readFileSync(join(vaultDir, '.duin', '_state', 'confidential-denylist.json'), 'utf-8')
    ) as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  } catch {
    return []
  }
}

// telos-native.ts — WS0.1 (telos-read). Today `world-state-native.ts` name-drops
// `me.md`/`GOALS` as a `priors` LABEL but never opens them. This module actually
// reads the operator's goal doc (`<vaultDir>/GOALS.md`) and derives, per World
// State track, a `telos` = the destination that track heads toward, **lane-stamped**
// (`confidential:<lane>` for the ProjectB / SupplierCo tracks, else `open`) so a downstream
// arc render can exclude confidential telos from a non-matching-audience output.
//
// Generic, NOT operator-hardcoded: the parse walks GOALS headings and maps each section to
// an ontology track via the same `trackOf` regexes the rest of the brain uses. A
// second operator with their own GOALS.md + `.duin/ontology.json` gets the same
// treatment. The read is cached per vault (parse once, not every worldState call).
// Missing GOALS.md → graceful: every track's telos.text is null, lanes still stamped.
//
// Gated behind `DUIN_TELOS` (default OFF). OFF ⇒ this module is never touched by
// worldState → no GOALS read, no telos field, byte-identical to today. Mirrors the
// `DUIN_TURN_BEATS === '1'` / `DUIN_RECALL_CAL === '1'` / `DUIN_SKILL_EMBED === '1'`
// gate style exactly (only the literal string '1' arms it).

import { readFileSync } from 'fs'
import { join } from 'path'
import { loadOntology, normalizeTrackKey } from './ontology'

/** `open` = renderable to any audience; `confidential:<lane>` = excluded from a
 *  non-matching-audience arc render (the lane partition guard rides on the telos). */
export type TelosLane = 'open' | `confidential:${string}`

export interface Telos {
  /** The destination text this track heads toward, or null when GOALS has no clean
   *  match for the track (missing file, or no section maps to the key). */
  text: string | null
  lane: TelosLane
}

/** The lane guard, from turn one. Keyed on the default ontology track keys; anything
 *  not listed is `open`. ProjectB (personal career optionality / Lane B) and SupplierCo (a
 *  supplier contact) are confidential per the ticket lane-partition guard + me.md ⛔ block;
 *  `personal` is treated as confidential:personal (life/health/supplier-adjacent). */
export const LANE_MAP: Record<string, TelosLane> = {
  ProjectB: 'confidential:projectb',
  SupplierCo: 'confidential:personal',
  personal: 'confidential:personal'
}

/** Lane for a track key. Exact-key hit on LANE_MAP first; then a tolerant fallback so
 *  a vault whose ontology uses `projectb`/`supplierco` keys still lands confidential. */
export function laneOf(key: string): TelosLane {
  const current = normalizeTrackKey(key) // legacy built-in keys resolve to their current lane
  if (current in LANE_MAP) return LANE_MAP[current]
  const k = current.toLowerCase()
  if (k.includes('projectb')) return 'confidential:projectb'
  // (`k` is already lowercased, so a mixed-case literal here could never match — the CJK key this
  // replaced was case-invariant, the latin placeholder is not. `includes('supplierco')` covers it.)
  if (k.includes('supplierco') || k === 'personal') {
    return 'confidential:personal'
  }
  return 'open'
}

/** The kill-switch. Default OFF ⇒ worldState never reads GOALS, never attaches a
 *  telos → byte-identical to today. Only the literal '1' arms it. */
export function telosEnabled(): boolean {
  return process.env.DUIN_TELOS === '1'
}

// ── parse ────────────────────────────────────────────────────────────────────

type Section = { heading: string; body: string[] }

/** First ontology track (in ontology order) whose regex matches the section HEADING.
 *  Heading-only on purpose: bodies bleed cross-track keywords (a confidential track's
 *  body can mention `PartnerCo`), which would mis-map the section. */
function trackForHeading(heading: string, tracks: { key: string; match: RegExp }[]): string | null {
  for (const t of tracks) if (t.match.test(heading)) return t.key
  return null
}

/** Strip the `Track N ·` / `N.` numbering prefix off a heading title. */
function cleanHeading(h: string): string {
  return h
    .replace(/^Track\s+\d+\s*[·:.\-–—]\s*/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim()
}

const OBJECTIVE_LINE =
  /^\s*(?:[-*]\s*)?\*\*\s*(?:goal|primary objective|objective|role|mission|north[-\s]?star|targets?(?:\s*&\s*milestones?)?)\s*[:：]?\s*\*\*[:：]?\s*(.+?)\s*$/i

/** Destination text for a section: prefer an explicit objective/goal/role/mission
 *  line in the body, else fall back to the (de-numbered) heading title. */
function telosTextOf(sec: Section): string {
  for (const raw of sec.body) {
    const m = OBJECTIVE_LINE.exec(raw)
    if (m && m[1] && m[1].trim()) return m[1].trim()
  }
  return cleanHeading(sec.heading)
}

/**
 * Parse a GOALS.md body into a per-track-key destination map. Pure (no fs) so it is
 * unit-testable in isolation. Every ontology track key is present in the result;
 * value is the destination text or null when no section maps to that key. First
 * section that maps to a key wins (the Current-Cycle section precedes the cross-cycle
 * restatement in the canonical layout).
 */
export function parseGoals(
  md: string,
  tracks: { key: string; match: RegExp }[]
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const t of tracks) out[t.key] = null

  const sections: Section[] = []
  let cur: Section | null = null
  for (const ln of md.split(/\r?\n/)) {
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(ln)
    if (h) {
      cur = { heading: h[1], body: [] }
      sections.push(cur)
    } else if (cur) {
      cur.body.push(ln)
    }
  }

  for (const sec of sections) {
    const key = trackForHeading(sec.heading, tracks)
    if (!key || out[key] != null) continue // unknown heading, or key already filled
    out[key] = telosTextOf(sec)
  }
  return out
}

// ── cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, Record<string, Telos>>()
let _reads = 0 // successful GOALS.md file reads — introspection for the cache test

function buildMap(text: string | null, tracks: { key: string; match: RegExp }[]): Record<string, Telos> {
  const parsed = text ? parseGoals(text, tracks) : null
  const map: Record<string, Telos> = {}
  for (const t of tracks) {
    map[t.key] = { text: parsed ? (parsed[t.key] ?? null) : null, lane: laneOf(t.key) }
  }
  return map
}

/**
 * Per-track telos map for a vault, cached (parse GOALS.md once, not every worldState
 * call). Missing/unreadable GOALS.md → graceful: all telos.text null, lanes stamped.
 * Keys align with the default ontology tracks (the same set worldState iterates).
 */
export function loadTelos(vaultDir: string | null): Record<string, Telos> {
  // PER-VAULT tracks. Was `defaultOntology()`, which was correct only while the default shipped
  // one operator's six lanes; since cold-start A3 emptied it, reading the default would give every
  // vault an empty telos map with no way to configure it. `loadOntology(null)` still yields the
  // default, so the null-vault path is unchanged.
  const tracks = loadOntology(vaultDir).tracks
  if (!vaultDir) return buildMap(null, tracks)
  const hit = cache.get(vaultDir)
  if (hit) return hit
  let text: string | null
  try {
    text = readFileSync(join(vaultDir, 'GOALS.md'), 'utf-8')
    _reads++
  } catch {
    text = null
  }
  const map = buildMap(text, tracks)
  cache.set(vaultDir, map)
  return map
}

/** Test / hot-reload aid — drop a vault's cached telos (or all) + reset read counter. */
export function clearTelosCache(vaultDir?: string): void {
  if (vaultDir) cache.delete(vaultDir)
  else {
    cache.clear()
    _reads = 0
  }
}

/** Test-only: count of successful GOALS.md file reads (the cache-reads-once probe). */
export function telosReads(): number {
  return _reads
}

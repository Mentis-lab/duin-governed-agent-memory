// ontology.ts — the per-operator ontology (world tracks, risk/deadline keyword
// sets, decision nouns, detector thresholds) lifted OUT of source so any vault can
// override it without a code change. The built-in defaults below are the operator's; a
// second operator drops a `<vaultDir>/.duin/ontology.json` to retrack the engine to
// their own world.
//
// Why this exists: a system whose whole thesis is per-operator calibration should
// not hard-code ONE operator's tracks and keyword regexes in
// source. This is the choke point that turns "one operator's personal tool" into "a product
// any operator can adopt."
//
// Regexes are stored as pattern strings (JSON-serialisable) and compiled with the
// `i` flag. Loading NEVER throws: a missing file, malformed JSON, or a bad regex
// pattern falls back to the built-in defaults (matches the tolerant-parse ethos of
// the rest of the brain).

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface OntologyData {
  /** Ordered tracks; first `match` (regex source) that tests true wins. */
  tracks: { key: string; match: string }[]
  /** Risk-language regex source (task flagged as carrying risk). */
  riskKw: string
  /** Deadline-language regex source (task treated as a hard deadline). */
  deadlineKw: string
  /** Per-track localized noun for the decision-window title. */
  decideNoun: Record<string, string>
  thresholds: {
    /** deadline-collision lookahead window, days (default 5). */
    collisionWindowDays: number
    /** decision-window-closing lookahead, days (default 21). */
    decisionWindowDays: number
    /** world-state "imminent" window, days (default 3). */
    imminentDays: number
  }
}

export interface CompiledOntology {
  tracks: { key: string; match: RegExp }[]
  riskKw: RegExp
  deadlineKw: RegExp
  decideNoun: Record<string, string>
  thresholds: OntologyData['thresholds']
  /** First track whose regex matches `text`, else null. */
  trackOf(text: string): string | null
}

// COLD-START A3 (2026-07-25): tracks ship EMPTY.
//
// The track keys and their match regexes named the author's real projects, partner companies and
// colleagues, and `decideNoun` carried per-project wording. Those are operator facts. The generic
// halves — risk / deadline keyword families and the numeric thresholds — ARE product defaults and
// stay, so a fresh vault still detects risk and deadline language; it just has no preloaded lanes
// to file them under until the operator defines tracks.
export const DEFAULT_ONTOLOGY: OntologyData = {
  tracks: [],
  riskKw: '风险|risk|滑点|HOLD|blocker|赶工|催|冻结|deadline|截止|预案|逾期|卡点',
  deadlineKw: '冻结|送达|生产|交付|deliver|final|截止|deadline|上线|发布|到位',
  decideNoun: {},
  thresholds: { collisionWindowDays: 5, decisionWindowDays: 21, imminentDays: 3 }
}

// ── legacy track keys ───────────────────────────────────────────────────────
//
// The built-in track keys were renamed on 2026-09-01 (`3rd` → `PartnerCo`, `AIX` → `Tooling`)
// when the last operator-identifying tokens left the source. Vaults written before that carry the
// OLD keys in `.duin/_state/world-state-deltas.jsonl`, `future-nodes.jsonl`, `tracks.json` lanes,
// `.duin/ontology.json` and GOALS sections. Every place a track key is READ funnels through
// `normalizeTrackKey`, so that data keeps resolving to the new keys without the operator having to
// rewrite files or add an ontology override. Writers emit the new keys only.
export const LEGACY_TRACK_KEYS: Readonly<Record<string, string>> = {
  '3rd': 'PartnerCo',
  AIX: 'Tooling'
}
const LEGACY_TRACK_KEYS_LOWER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_TRACK_KEYS).map(([k, v]) => [k.toLowerCase(), v])
)

/** Map a legacy built-in track key (any case, surrounding whitespace tolerated) onto its current
 *  key. Anything that is not a legacy key is returned UNCHANGED (not even trimmed), so this is
 *  safe to apply at every read boundary. */
export function normalizeTrackKey(key: string): string {
  if (typeof key !== 'string' || !key) return key
  const t = key.trim()
  return LEGACY_TRACK_KEYS[t] ?? LEGACY_TRACK_KEYS_LOWER[t.toLowerCase()] ?? key
}

function compile(data: OntologyData): CompiledOntology {
  // Keys are normalized here so a vault's ontology.json written with the legacy keys (and the
  // built-in default, should it ever regrow one) both compile to the current key set.
  const tracks = data.tracks.map((t) => ({ key: normalizeTrackKey(t.key), match: new RegExp(t.match, 'i') }))
  const decideNoun: Record<string, string> = {}
  for (const [k, v] of Object.entries(data.decideNoun ?? {})) decideNoun[normalizeTrackKey(k)] = v
  return {
    tracks,
    riskKw: new RegExp(data.riskKw, 'i'),
    deadlineKw: new RegExp(data.deadlineKw, 'i'),
    decideNoun,
    thresholds: data.thresholds,
    trackOf(text: string): string | null {
      for (const t of tracks) if (t.match.test(text)) return t.key
      return null
    }
  }
}

const DEFAULT_COMPILED = compile(DEFAULT_ONTOLOGY)
const cache = new Map<string, CompiledOntology>()

/** The built-in (product-default) ontology, compiled once. Used as the vault-agnostic default. */
export function defaultOntology(): CompiledOntology {
  return DEFAULT_COMPILED
}

/**
 * Load `<vaultDir>/.duin/ontology.json`, shallow-merged over the built-in defaults,
 * compiled and cached per vault. Never throws — a missing/malformed file, or any
 * invalid regex pattern, falls back to the defaults.
 */
export function loadOntology(vaultDir: string | null | undefined): CompiledOntology {
  if (!vaultDir) return DEFAULT_COMPILED
  const hit = cache.get(vaultDir)
  if (hit) return hit
  let compiled = DEFAULT_COMPILED
  try {
    const p = join(vaultDir, '.duin', 'ontology.json')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<OntologyData>
      const merged: OntologyData = {
        tracks:
          Array.isArray(raw.tracks) && raw.tracks.length ? raw.tracks : DEFAULT_ONTOLOGY.tracks,
        riskKw: typeof raw.riskKw === 'string' && raw.riskKw ? raw.riskKw : DEFAULT_ONTOLOGY.riskKw,
        deadlineKw:
          typeof raw.deadlineKw === 'string' && raw.deadlineKw
            ? raw.deadlineKw
            : DEFAULT_ONTOLOGY.deadlineKw,
        decideNoun:
          raw.decideNoun && typeof raw.decideNoun === 'object'
            ? raw.decideNoun
            : DEFAULT_ONTOLOGY.decideNoun,
        thresholds: { ...DEFAULT_ONTOLOGY.thresholds, ...(raw.thresholds || {}) }
      }
      compiled = compile(merged) // throws on a bad regex → caught below → defaults
    }
  } catch {
    compiled = DEFAULT_COMPILED
  }
  cache.set(vaultDir, compiled)
  return compiled
}

/** Test / hot-reload aid — drop a vault's cached ontology (or all). */
export function clearOntologyCache(vaultDir?: string): void {
  if (vaultDir) cache.delete(vaultDir)
  else cache.clear()
}

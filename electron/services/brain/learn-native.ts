// learn-native — TS port of learn.py: the corrections→reflect→taste loop (the
// other compounding moat-code, twin of the calibration loop). PURE logic + reads;
// the append/persist writes stay a separate store concern (coherent-ownership, like
// calibration-store) so this is testable + parity-verifiable without touching the
// two-writer'd taste files. Loop: capture (append) → reflect (cluster + recompute
// taste) → consume (read taste). Taste = the FAST arrow (behavior shifts before any
// node is promoted); a theme recurring ≥MIN_BIND is a binding candidate ("3× → rule").
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { brainStateDir } from './brain-state-dir'
import { CJK_CLASS } from './cjk-tokens'

export const MIN_BIND = 3
/** The pair test for "these two corrections are the same theme". Both gate behavior, so both are
 *  registered in calibration-registry.ts with the measurement behind them.
 *
 *  What this does NOT do: cluster corrections that share a theme but no vocabulary. It is lexical,
 *  so paraphrases of one preference sit in different clusters.
 *
 *  BIND_OVERLAP_MIN was 3 through 2026-07-30, and in that state the gate could effectively never
 *  fire. Measured over the live 166-row stream: the median correction carries 4 tokens (43 rows
 *  carry fewer than 4, 10 carry none), so demanding a 3-token intersection demands near-duplicates.
 *  36 of 12,090 pairs passed the pair test, yet no cluster reached MIN_BIND — 0 binding candidates
 *  in 166 corrections. Relaxing this floor to 2 at the UNCHANGED Jaccard yields 4 clusters ≥MIN_BIND
 *  on the same stream; relaxing the Jaccard instead (0.30 → 0.10) still yields 0. That asymmetry is
 *  how we know the absolute floor was the binding constraint and the ratio never was. */
export const BIND_JACCARD_MIN = 0.3
export const BIND_OVERLAP_MIN = 2
const STOP = new Set(
  (
    'the a an and or but if then so as at by from of to in on for with ' +
    'is are be was were do does did can will just this that these those it your you ' +
    'no not has have had one make makes made always our we i ' +
    'prefers prefer wants want should would could'
  ).split(/\s+/)
)

export interface Correction {
  ts?: string
  session?: string
  skill?: string
  artifact?: string
  ai_output?: string
  correction?: string
  why?: string
  candidate_rule?: string
  touches?: unknown
  polarity?: string
  status?: string
  source?: string
  [k: string]: unknown
}
export interface Taste {
  values: unknown[]
  frameworks: unknown[]
  correction_rules: Record<string, unknown>[]
  counts?: { values: number; frameworks: number; correction_rules: number }
  generated_at?: string
  [k: string]: unknown
}
export interface Reflection {
  stream_size: number
  themes: string[]
  binding_candidates: { count: number; theme: string[]; sample: string }[]
  taste_counts: Record<string, number>
  /** Non-fatal loss/abstain notice from the WRITE side (learn-store): the prior
   *  taste-engine.json was unreadable or not a taste object, so its bytes were
   *  quarantined (or the write was skipped). Surfaced on the route response so a
   *  seeded-values loss is visible instead of announced only to a log. */
  warning?: string
  /** Path of the ISO-stamped `.corrupt` sidecar the prior bytes were moved to. */
  quarantined?: string
  /** True when runReflect deliberately did NOT persist taste (bytes it could not preserve). */
  taste_write_skipped?: boolean
}

const stateDir = brainStateDir // canonical resolver (was: join(vaultDir, '.duin', '_state'))

/** Run class for both tokenizers below. Carries the tokenizer's full CJK set (kanji +
 *  KANA), not the bare ideograph range — kana counted as a delimiter, so a Japanese
 *  correction contributed no themes and could never cluster. */
const TOK_RE = new RegExp(`[a-z0-9${CJK_CLASS}]+`, 'g')

/** Tokenize: alnum + CJK runs, minus stopwords, len>1 (port of _toks). */
export function toks(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of (text || '').toLowerCase().matchAll(TOK_RE)) {
    const t = m[0]
    if (!STOP.has(t) && t.length > 1) out.add(t)
  }
  return out
}

/** Ordered tokenize: same normalization/filter as `toks` but preserves order + repeats
 *  (an ARRAY, not a Set) so adjacent bigrams can be built for theme extraction. */
export function toksSeq(text: string): string[] {
  const out: string[] = []
  for (const m of (text || '').toLowerCase().matchAll(TOK_RE)) {
    const t = m[0]
    if (!STOP.has(t) && t.length > 1) out.push(t)
  }
  return out
}

/**
 * Stable CONTENT identity for a correction row — the same judgment, about the same prior answer,
 * on the same day, hashes the same wherever it came from.
 *
 * Two things need it. (1) learn-store's append dedupe: capture now fires from two seams (the
 * renderer's ipc/chat.ts and the /agui turn boundary) and a replayed learn-bridge queue can
 * re-POST a row after a restart, so the ledger needs one identity to recognise "I already have
 * this". (2) the status overlay: corrections.jsonl is append-only and MUST stay that way, so a
 * status transition is recorded against this key in a sidecar rather than by rewriting a row.
 *
 * `session` is deliberately EXCLUDED. It is the field the two seams label differently — chat.ts
 * passes the conversation id, the /agui tick passes the thread id — and they are the same turn.
 * `status` and `touches` are excluded for the same reason a key must be stable: they are the
 * mutable part, and a key that changed when the status changed could never find its own row.
 */
export function correctionKey(row: Correction): string {
  const parts = [
    String(row.ts ?? '').slice(0, 10),
    String(row.skill ?? ''),
    String(row.artifact ?? ''),
    String(row.ai_output ?? ''),
    String(row.correction ?? ''),
    String(row.why ?? ''),
    String(row.candidate_rule ?? ''),
    String(row.polarity ?? 'correction')
  ]
  // NUL-joined, not space-joined: a separator that can occur INSIDE a field would let two
  // different rows shift text across the boundary and collide on a single key.
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/** The status OVERLAY file — the sidecar that lets a correction's status change without
 *  corrections.jsonl ever being rewritten. */
export const CORRECTION_STATUS_FILE = 'correction-status.jsonl'

/** The states the new<->bound lifecycle owns. Anything else written INLINE on a row is another
 *  arm's verdict — notably 'dropped', which retires a row from the stream — and the overlay is
 *  not allowed to override it. Without that asymmetry an overlay row could RESURRECT a retired
 *  correction, because `correctionKey` deliberately ignores `status` and so a retired row and a
 *  live row with identical content share one key. Inline non-lifecycle statuses therefore win. */
export const LIFECYCLE_STATUSES = new Set(['', 'new', 'bound'])

/**
 * Effective status per correction key, from the append-only overlay sidecar (last row wins).
 *
 * WHY A SIDECAR AND NOT AN IN-PLACE EDIT. corrections.jsonl is the capture ledger and its
 * append-only contract is the reason it is trustworthy: a row, once written, is never rewritten,
 * so no read-modify-write can ever truncate the operator's judgment history. A lifecycle still
 * needs somewhere to record that a row's status moved, so the transition goes in a second
 * append-only file keyed by `correctionKey` and the two are joined on read. Nothing mutates.
 *
 * Unparseable lines are skipped, not fatal — a torn overlay line must never make the corrections
 * themselves unreadable. Missing file → empty map (the overwhelmingly common cold case).
 */
export function loadStatusOverlay(stateDirPath: string): Map<string, string> {
  const out = new Map<string, string>()
  let txt: string
  try {
    txt = readFileSync(join(stateDirPath, CORRECTION_STATUS_FILE), 'utf-8')
  } catch {
    return out
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { key?: unknown; status?: unknown }
      const key = String(r.key ?? '')
      const status = String(r.status ?? '')
      if (key && status) out.set(key, status) // later row wins: the file IS the transition log
    } catch {
      /* torn overlay line: a status we cannot read must not cost us the corrections */
    }
  }
  return out
}

/** Operator-only stream: skip machine (`source`) rows + dropped. Port of load_corrections.
 *  Now joins the status overlay so a row reads with its CURRENT status rather than the one it
 *  was captured with — that join is what makes `status === 'dropped'` below, and the
 *  `status === 'bound'` readers downstream in personalization-recall, mean anything at all. */
export function loadCorrections(stateDirPath: string): Correction[] {
  const rows: Correction[] = []
  let txt: string
  try {
    txt = readFileSync(join(stateDirPath, 'corrections.jsonl'), 'utf-8')
  } catch {
    return rows
  }
  const overlay = loadStatusOverlay(stateDirPath)
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    let r: Correction
    try {
      r = JSON.parse(line) as Correction
    } catch {
      continue
    }
    if (r.source) continue // machine row — excluded by the operator-only contract
    // Applied BEFORE the dropped check: an overlay is the only way a row can reach 'dropped'
    // after capture, so joining afterwards would make the check unreachable for exactly the
    // rows it exists to catch.
    if (overlay.size && LIFECYCLE_STATUSES.has(String(r.status ?? ''))) {
      const live = overlay.get(correctionKey(r))
      if (live) r = { ...r, status: live } // copy, never mutate the parsed row in place
    }
    if (r.status === 'dropped') continue
    rows.push(r)
  }
  return rows
}

/** Compile the taste object: seeded values/frameworks + reusable corrections as
 *  correction_rules. Pure port of build_taste's COMPUTE (the file write is the store's
 *  job). `generated_at` is set by the writer (nondeterministic) — omitted here. */
export function computeTaste(corrections: Correction[], existing: Partial<Taste> = {}): Taste {
  const taste: Taste = {
    ...existing,
    values: existing.values ?? [],
    frameworks: existing.frameworks ?? [],
    correction_rules: []
  }
  const rules: Record<string, unknown>[] = []
  corrections.forEach((r, i) => {
    if (r.candidate_rule || r.correction || r.why) {
      rules.push({
        ts: r.ts,
        skill: r.skill ?? '',
        why: r.why ?? '',
        correction: r.correction ?? '',
        candidate_rule: r.candidate_rule ?? '',
        polarity: r.polarity ?? 'correction',
        status: r.status ?? 'new',
        source_type: 'correction',
        source_path: `corrections.jsonl:${i + 1}`
      })
    }
  })
  taste.correction_rules = rules
  taste.counts = {
    values: taste.values.length,
    frameworks: taste.frameworks.length,
    correction_rules: rules.length
  }
  return taste
}

/** Recency-weighted themes + lexical recurrence clusters; a cluster ≥MIN_BIND is a
 *  binding candidate (surface for confirm — the "3× → rule"). Pure port of reflect
 *  (minus the build_taste write; returns taste_counts from a computeTaste). */
export function reflect(corrections: Correction[], today: Date = new Date(), existingTaste: Partial<Taste> = {}): Reflection {
  const items = corrections.map((r) => {
    const text = [r.why ?? '', r.correction ?? '', r.candidate_rule ?? ''].join(' ')
    return { toks: toks(text), row: r }
  })
  // Unigram doc-frequency (Set-based, one count per correction) — the existing signal,
  // kept as the backfill when there aren't enough recurring phrases.
  const freq = new Map<string, number>()
  for (const it of items) for (const t of it.toks) freq.set(t, (freq.get(t) ?? 0) + 1)
  const unigramThemes = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t)

  // Primary themes: adjacent BIGRAMS across corrections (ordered tokens), freq>=2, desc.
  // Bigrams carry the real phrase ("lead risks") vs. bare recurring words. If fewer than 5
  // qualify, backfill with the unigram list so a thin stream still gets themes.
  const bigramFreq = new Map<string, number>()
  for (const it of items) {
    const seq = toksSeq([it.row.why ?? '', it.row.correction ?? '', it.row.candidate_rule ?? ''].join(' '))
    for (let k = 0; k + 1 < seq.length; k++) bigramFreq.set(`${seq[k]} ${seq[k + 1]}`, (bigramFreq.get(`${seq[k]} ${seq[k + 1]}`) ?? 0) + 1)
  }
  const bigramThemes = [...bigramFreq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t)
  const themes =
    bigramThemes.length >= 5
      ? bigramThemes
      : [...bigramThemes, ...unigramThemes.filter((u) => !bigramThemes.includes(u))].slice(0, 12)

  const used = new Array(items.length).fill(false)
  const binding: Reflection['binding_candidates'] = []
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue
    const grp = [i]
    used[i] = true
    for (let j = i + 1; j < items.length; j++) {
      if (used[j] || !items[i].toks.size || !items[j].toks.size) continue
      const a = items[i].toks
      const b = items[j].toks
      let inter = 0
      for (const t of a) if (b.has(t)) inter++
      const uni = a.size + b.size - inter
      if (uni && inter / uni >= BIND_JACCARD_MIN && inter >= BIND_OVERLAP_MIN) {
        grp.push(j)
        used[j] = true
      }
    }
    if (grp.length >= MIN_BIND) {
      // intersection of ALL group members' tokens
      let common = new Set(items[grp[0]].toks)
      for (const k of grp.slice(1)) common = new Set([...common].filter((t) => items[k].toks.has(t)))
      binding.push({
        count: grp.length,
        theme: [...common].sort().slice(0, 6),
        sample: String(items[grp[0]].row.why || items[grp[0]].row.correction || '').slice(0, 160)
      })
    }
  }
  const taste = computeTaste(corrections, existingTaste)
  void today // recency salience is computed in Python but unused by the output; kept for signature fidelity
  return { stream_size: corrections.length, themes, binding_candidates: binding, taste_counts: taste.counts ?? {} }
}

/** Consumption arrow: the chat/insight path reads this before reasoning. Port of get_taste. */
export function getTaste(vaultDir: string | null): Taste {
  const empty: Taste = { values: [], frameworks: [], correction_rules: [] }
  if (!vaultDir) return empty
  try {
    return JSON.parse(readFileSync(join(stateDir(vaultDir), 'taste-engine.json'), 'utf-8')) as Taste
  } catch {
    return empty
  }
}

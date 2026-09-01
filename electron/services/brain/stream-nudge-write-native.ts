// Model-backed WRITE — port of nudge_streams (server.py:2070): the incremental living-state
// move. A just-logged update touches ONLY the streams it's ABOUT — matched by subject
// overlap — and each matched stream (≤3) is re-evaluated in isolation: levels nudged, done
// steps advanced, a one-line log entry appended. Mutates + saves future-nodes.jsonl.
//
// Extraction-style writes (structure the given update against a given stream) → injected bare
// oneshot generate, one call per matched stream; no /agui grounding, no chat-turn learn ticks.
// Empty text ⇒ {ok:true,nudged:[]} and no model calls, matching Python.
//
// Self-contained (replicates the small sigTokens / future-nodes loaders per the handoff's
// replicate-don't-export convention). future-nodes.jsonl ONLY (Python _load/_save_futures).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { extractFirstJsonObject } from './extraction-util'
import { normalizeTrackKey } from './ontology'
import { messageOf } from '../guarded'
import { CJK_CLASS } from './cjk-tokens'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

// ── subject-overlap primitives (port of _sig_tokens / _overlap2 / _entity_match) ──
const STOP_TOK = new Set(['task', 'risk', 'with', 'that', 'this', 'from', 'into', 'biweekly', 'report', 'project', 'delivery'])
// CJK runs of >=2, with the tokenizer's full CJK class (kanji + KANA) rather than the bare
// ideograph range — kana bounded a run, so a Japanese update produced no bigrams and matched
// no stream, meaning it silently nudged nothing.
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]{2,}`, 'g')
function sigTokens(s: string): Set<string> {
  const lc = (s || '').toLowerCase()
  const toks = new Set([...lc.matchAll(/[a-z0-9]{4,}/g)].map((m) => m[0]))
  for (const run of lc.matchAll(CJK_RUN_RE)) {
    const r = run[0]
    for (let i = 0; i < r.length - 1; i++) toks.add(r.slice(i, i + 2))
  }
  for (const st of STOP_TOK) toks.delete(st)
  return toks
}
function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = []
  for (const x of a) if (b.has(x)) out.push(x)
  return out
}
/** ≥2 shared significant tokens. Port of _overlap2. */
export function overlap2(a: string, b: string): boolean {
  return intersect(sigTokens(a), sigTokens(b)).length >= 2
}
/** Looser nudge match: ≥2 shared tokens OR a single shared latin brand/proper-noun (≥4).
 *  Port of _entity_match — so an English capture still matches a Chinese stream. */
export function entityMatch(a: string, b: string): boolean {
  const shared = intersect(sigTokens(a), sigTokens(b))
  if (shared.length >= 2) return true
  return shared.some((t) => /^[a-z0-9]{4,}$/.test(t))
}
/** Per-domain language instruction. Port of _lang_for (server.py:1360). */
export function langFor(track: string): string {
  const t = normalizeTrackKey(track) // futures saved under a legacy key keep their language
  if (t === 'ProjectA' || t === 'SupplierCo') return 'Write in 中文 (Chinese).'
  if (t === 'PartnerCo') return 'Write in 日本語 (Japanese).'
  return 'Write in English.'
}

interface StreamNodeLike {
  id?: string
  status?: string
  title?: string
  objective?: string
  decision?: string
  steps?: { event?: string; done?: boolean }[]
  levels?: Record<string, number>
  log?: { ts: string; note: string }[]
  refreshed?: string
  [k: string]: unknown
}

/** Build the per-stream re-evaluation prompt. Verbatim from server.py:2085-2088. The embedded
 *  STREAM is JSON.stringify'd (compact) — Python uses json.dumps(ensure_ascii=False) whose
 *  default `, `/`: ` separators differ only in whitespace inside the prompt (immaterial to the
 *  model; instruction text is verbatim). */
export function buildNudgePrompt(compact: Record<string, unknown>, text: string, track: string): string {
  return (
    'A STREAM from the operator\'s plan, and a NEW UPDATE he just logged. Re-evaluate ONLY this stream in light of ' +
    'the update — nothing else. Return ONLY JSON: {"levels":{"risk":0-1,"progress":0-1,' +
    '"confidence":0-1}, "steps_done":[exact event text of steps that are now COMPLETE], "note": one ' +
    `short line on what changed}. ${langFor(track)}\n\nSTREAM: ${JSON.stringify(compact)}\n\nUPDATE: ${text}`
  )
}

/** Compact projection fed to the prompt: {title,objective,decision,steps,levels} present-keys,
 *  in that order. Port of the dict-comprehension at server.py:2083. PURE. */
export function compactStream(s: StreamNodeLike): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['title', 'objective', 'decision', 'steps', 'levels'] as const) {
    if (k in s && s[k] !== undefined) out[k] = s[k]
  }
  return out
}

/**
 * Apply one parsed nudge result to a stream IN PLACE — PURE (deterministic given the model
 * object). Clamps+rounds levels, marks overlapping steps done, appends a capped log line,
 * stamps refreshed. Returns true if the stream is considered nudged (Python appends the id
 * regardless of whether fields changed, as long as the model returned an object). Mirrors
 * server.py:2093-2106.
 */
export function applyNudge(s: StreamNodeLike, g: Record<string, unknown>, refreshed: string): void {
  const lv = (g.levels && typeof g.levels === 'object' && !Array.isArray(g.levels) ? g.levels : {}) as Record<string, unknown>
  for (const k of ['risk', 'progress', 'confidence'] as const) {
    const v = lv[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
      const levels = (s.levels as Record<string, number>) ?? {}
      levels[k] = Math.round(v * 100) / 100
      s.levels = levels
    }
  }
  const stepsDone = Array.isArray(g.steps_done) ? (g.steps_done as unknown[]) : []
  for (const st of s.steps ?? []) {
    if (stepsDone.some((d) => overlap2(String(st.event ?? ''), String(d)))) st.done = true
  }
  const note = String((g.note ?? '') as string).trim().slice(0, 160)
  if (note) {
    const log = Array.isArray(s.log) ? s.log : []
    log.push({ ts: refreshed, note })
    s.log = log.slice(-5)
  }
  s.refreshed = refreshed
}

function loadFutureNodes(vaultDir: string): StreamNodeLike[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    throw e // a transient lock/IO error must not degrade to [] → the re-save below would overwrite the file empty
  }
  const rows: StreamNodeLike[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as StreamNodeLike)
    } catch (e) { console.debug('[stream-nudge-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}
function saveFutureNodes(vaultDir: string, rows: StreamNodeLike[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const path = futuresPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}
function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export type GenerateFn = (prompt: string) => Promise<string>
export interface RunStreamNudgeDeps {
  generate: GenerateFn
  now?: () => Date
}

/** Select the active streams (open/engaged) whose subject matches the update, capped at 3.
 *  PURE — exported so matching is testable without a model. Port of server.py:2078-2080. */
export function matchStreams(streams: StreamNodeLike[], text: string): StreamNodeLike[] {
  return streams
    .filter((s) => s.status === 'open' || s.status === 'engaged')
    .filter((s) => {
      const subj = `${s.title ?? ''} ${s.objective ?? ''} ` + (s.steps ?? []).map((st) => st.event ?? '').join(' ')
      return entityMatch(text, subj)
    })
    .slice(0, 3)
}

export async function runStreamNudge(
  vaultDir: string,
  text: string,
  deps: RunStreamNudgeDeps
): Promise<{ ok: boolean; nudged: string[] }> {
  if (!(text || '').trim()) return { ok: true, nudged: [] }
  if (!vaultDir) return { ok: true, nudged: [] }
  const streams = loadFutureNodes(vaultDir)
  const matched = matchStreams(streams, text)
  const nudged: string[] = []
  for (const s of matched) {
    const prompt = buildNudgePrompt(compactStream(s), text, String(s.track ?? ''))
    const raw = await deps.generate(prompt)
    const g = extractFirstJsonObject(raw)
    if (!g || Object.keys(g).length === 0) continue
    const refreshed = localIsoSeconds((deps.now ?? (() => new Date()))())
    applyNudge(s, g, refreshed)
    if (s.id) nudged.push(s.id)
  }
  if (nudged.length) saveFutureNodes(vaultDir, streams)
  return { ok: true, nudged }
}

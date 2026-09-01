// cascade-engine-native — the shared propose → adversarial-judge → stage machinery behind the
// cascades (cascade_decision/track/project). Ports _propose_then_judge + _stage_cascade +
// the cascade-pending store. Model-backed (generateOnce); best-effort, never throws.
//
// Verification: the LLM passes are nondeterministic, so proposeThenJudge is unit-tested via an
// injected `generate` (canned candidates + verdicts). stageCascade + the store are deterministic.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { generateOnce } from './generate-once-native'
import { jsonFromModel, loadFutureNodes, saveFutureNodes, normalizeStream } from './stream-write-native'
import { loadTrackRegistry } from './tracks-native'
import { messageOf } from '../guarded'

const cascadePath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'cascade-pending.jsonl')
// COLD-START A4 (2026-07-25): the per-project language routing named the author's real projects
// and companies and told the model to answer a stranger in Chinese or Japanese for them. Replaced
// with a rule that follows the SOURCE material, which is what the original was approximating.
const LANG_RULE =
  'LANGUAGE — write each item in the language of the material it derives from. If the source note ' +
  'or conversation is in a given language, stay in that language; otherwise match the operator. ' +
  'Match all field text to it.'
const randId = (): string => Math.random().toString(16).slice(2, 10).padEnd(8, '0')
const localIsoSeconds = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const nameOf = (c: Record<string, unknown>): string => String(c.title || c.label || c.change || '').trim()

export type Generate = (prompt: string, task?: 'chat' | 'extraction' | 'title' | 'code' | 'reason') => Promise<string>
export interface CascadeDeps {
  generate: Generate
  now: () => Date
  id: () => string
}
const defaultDeps: CascadeDeps = { generate: generateOnce, now: () => new Date(), id: randId }

export function loadCascadePending(vaultDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let txt: string
  try {
    txt = readFileSync(cascadePath(vaultDir), 'utf-8')
  } catch {
    return out
  }
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[cascade-engine-native] skip malformed:', messageOf(e)) }
  }
  return out
}

function saveCascadePending(vaultDir: string, items: Record<string, unknown>[]): void {
  const p = cascadePath(vaultDir)
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
  const body = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, p)
}

/** Two role-separated model passes: a GENERATOR proposes candidates, an adversarial JUDGE
 *  (default-kill) keeps only real/distinct/grounded ones. Port of _propose_then_judge. */
export async function proposeThenJudge(genPrompt: string, what: string, deps: CascadeDeps = defaultDeps): Promise<Record<string, unknown>[]> {
  const gen = jsonFromModel(await deps.generate(genPrompt, 'reason'), true)
  const cands = Array.isArray(gen) ? (gen as unknown[]).filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !!nameOf(c as Record<string, unknown>)).slice(0, 6) : []
  if (!cands.length) return []
  const judgePrompt =
    `You are the ADVERSARIAL JUDGE of a second brain. Below are proposed ${what}. Default to KILL. Keep one ` +
    'ONLY if it is REAL and grounded in the operator\'s actual work (not generic or speculative), DISTINCT ' +
    '(not a duplicate of an existing node), and genuinely belongs. Output ONLY a JSON array aligned BY INDEX: ' +
    '[{"idx":<int>,"keep":<bool>,"reason":"<=80 chars"}].\n\nCANDIDATES:\n' +
    JSON.stringify(cands.map((c, i) => ({ idx: i, title: nameOf(c), objective: String(c.objective || c.goal || '').slice(0, 120) })))
  const verdicts = jsonFromModel(await deps.generate(judgePrompt, 'reason'), true)
  if (!Array.isArray(verdicts) || !verdicts.length) return cands // judge unavailable → keep (provisional anyway)
  const keep = new Set((verdicts as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !!(v as Record<string, unknown>).keep).map((v) => v.idx))
  return cands.filter((_, i) => keep.has(i))
}

/** Append judged proposals to the cascade-pending review tray. Port of _stage_cascade. */
export function stageCascade(vaultDir: string, kind: string, source: string, proposals: Record<string, unknown>[], deps: CascadeDeps = defaultDeps): number {
  const now = localIsoSeconds(deps.now())
  const items = loadCascadePending(vaultDir)
  for (const p of proposals) items.push({ id: deps.id(), kind, source, proposal: p, status: 'pending', created: now })
  saveCascadePending(vaultDir, items)
  return proposals.length
}

/** New project → propose the TRACKS it carries, judge, STAGE for review (high-stakes tier).
 *  Port of cascade_project. Best-effort; returns the count staged. */
export async function cascadeProject(vaultDir: string | null, name: string, deps: CascadeDeps = defaultDeps): Promise<number> {
  if (!vaultDir) return 0
  try {
    const existing = loadTrackRegistry(vaultDir).map((t) => t.label || '')
    const gen =
      'You are the PROJECTION ENGINE. A new PROJECT was just created. Propose 2-4 durable TRACKS (lanes ' +
      'of work) it carries — each a long-running thread the project advances along. Ground them in the ' +
      "project's likely scope; do NOT duplicate existing tracks. If you can't ground a track, omit it.\n" +
      `${LANG_RULE}\nPROJECT: ${JSON.stringify(name)}\nEXISTING TRACKS (do NOT duplicate):\n${JSON.stringify(existing)}\n` +
      'Output ONLY a JSON array: [{"label","goal","keywords":["..."]}].'
    const surv = await proposeThenJudge(gen, `TRACKS for the project «${name}»`, deps)
    return surv.length ? stageCascade(vaultDir, 'project-track', name, surv, deps) : 0
  } catch {
    return 0
  }
}

let cascadeTrackRunning = false // single-flight, mirrors Python's _cascade_lock (blocking=False)

/** New track → propose its MOVES, judge, AUTO-LAND survivors as provisional streams (low-stakes
 *  tier). Port of cascade_track. Best-effort; returns the count landed. */
export async function cascadeTrack(
  vaultDir: string | null,
  track: { id?: string; label?: string; goal?: string; lane?: string; keywords?: unknown },
  deps: CascadeDeps = defaultDeps
): Promise<number> {
  if (!vaultDir || cascadeTrackRunning) return 0
  cascadeTrackRunning = true
  try {
    const lane = track.lane || ''
    const existing = loadFutureNodes(vaultDir).map((s) => String(s.title ?? '')).slice(0, 40)
    const gen =
      'You are the PROJECTION ENGINE. A new TRACK was just created. Propose 2-4 concrete near-term MOVES ' +
      '(streams) that advance it — each a chain from a trigger toward a goal. Ground them STRICTLY in the ' +
      "track's goal + keywords + the operator's real work; do NOT invent dates (leave decide_by empty, set " +
      '"confirm" to a short question if a key fact is unknown). If you cannot ground a move, omit it.\n' +
      `${LANG_RULE}\nTRACK: ${JSON.stringify({ label: track.label, goal: track.goal, lane: track.lane, keywords: track.keywords })}\n` +
      `EXISTING STREAMS (do NOT duplicate):\n${JSON.stringify(existing)}\n` +
      'Output ONLY a JSON array: [{"title","objective","trigger","confirm","cleared","blocked"}].'
    const survivors = await proposeThenJudge(gen, `MOVES for the track «${track.label ?? ''}»`, deps)
    if (!survivors.length) return 0
    const now = localIsoSeconds(deps.now())
    const nodes = survivors.map((s) => {
      const n = normalizeStream(s, 'cascade')
      n.track = lane
      n.parent = track.id ?? ''
      n.parent_label = track.label ?? ''
      n.id = deps.id()
      n.status = 'open'
      n.created = now
      n.refreshed = now
      n.source = 'cascade' // provisional: auto-applied but soft + confirm-able
      return n
    })
    saveFutureNodes(vaultDir, [...loadFutureNodes(vaultDir), ...nodes])
    return nodes.length
  } catch {
    return 0
  } finally {
    cascadeTrackRunning = false
  }
}

/** A decision was made → detect affected streams, judge, STAGE for review (high-stakes tier).
 *  Port of cascade_decision. Best-effort; returns the count staged. */
export async function cascadeDecision(
  vaultDir: string | null,
  decision: { title?: string; call?: string; rationale?: string },
  deps: CascadeDeps = defaultDeps
): Promise<number> {
  if (!vaultDir) return 0
  try {
    const streams = loadFutureNodes(vaultDir)
      .filter((s) => s.status === 'open' || s.status === 'engaged' || s.status === 'synced')
      .map((s) => ({ id: s.id, title: String(s.title ?? '').slice(0, 60), track: s.track ?? '' }))
      .slice(0, 40)
    if (!streams.length) return 0
    const dtxt = JSON.stringify({ title: decision.title, call: decision.call, rationale: decision.rationale })
    const gen =
      'A DECISION was just made. From the STREAMS below, identify ONLY those the decision genuinely ' +
      'AFFECTS, and the concrete change to each (resolves a fork / raises or lowers risk / unblocks / ' +
      'supersedes / changes the deadline). Be strict — most streams are unaffected.\n' +
      `${LANG_RULE}\nDECISION: ${dtxt}\nSTREAMS:\n${JSON.stringify(streams)}\n` +
      'Output ONLY a JSON array: [{"stream_id","title","change":"<=80 chars"}].'
    const surv = await proposeThenJudge(gen, 'affected streams from a decision', deps)
    return surv.length ? stageCascade(vaultDir, 'decision-affected', decision.title ?? '', surv, deps) : 0
  } catch {
    return 0 // never throws — matches the Python background-thread contract
  }
}

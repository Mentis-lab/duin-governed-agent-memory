// Model-backed WRITE — port of extract_stream (server.py:1878): the "sync" loop where the operator
// describes a strategic STREAM in his own words and it's structured into ONE future-node
// (objective → ordered dependent steps gated by a key decision, with the decision deadline
// back-propagated from the target window through step lead times). Appended to
// `.duin/_state/future-nodes.jsonl`.
//
// Like world-update this is an EXTRACTION write (structure the given description) so a bare
// model oneshot is faithful — the model call is injected as `generate`; no /agui grounding,
// no chat-turn learn ticks (machine turn). Keyless / unparseable ⇒ {ok:false} exactly as
// Python (extract_stream returns an error when the model can't structure it).
//
// Also ports _normalize_stream (server.py:1772) — the messy-model-JSON → persisted-schema
// coercer reused by 4 Python callers; exported PURE here for the later stream routes.
//
// PURE except the single load→append→save of future-nodes.jsonl. The future-nodes loaders
// are replicated locally (small; per the handoff's replicate-don't-export convention) and
// operate on future-nodes.jsonl ALONE — matching Python _load_futures/_save_futures, NOT the
// merging causal-substrate.loadFutures.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { defaultOntology, loadOntology, normalizeTrackKey, type CompiledOntology } from './ontology'
import { readAnchorDecls } from './causal-substrate'
import { extractFirstJsonObject } from './extraction-util'
import { cleanWhen } from './stream-write-native'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

// Verbatim from server.py:1355-1357 (reused by several model-backed prompts — cascade creators too).
export const LANG_RULE =
  'LANGUAGE — write each item in the language of its DOMAIN: ProjectA / VendorCo (Chinese game business) ' +
  'in 中文; PartnerCo (a Japanese company) in 日本語 (Japanese); DUIN / harness, ProjectB, and personal ' +
  'in English. Match all field text to it.'

// str(x or "") — falsy (incl. '', 0, false, null) → '', else String(x). Matches Python's
// `str(g.get(k) or "")` for the normal (string/number) case the model emits.
const sOr = (...vals: unknown[]): string => {
  for (const v of vals) if (v) return String(v)
  return ''
}
// _lvl: keep a number in [0,1], else the default.
const lvl = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt

export interface StreamStep {
  event: string
  when: string
  lead: string
  done: boolean
  task_id: string
  gap: boolean
}
export interface NormalizedStream {
  title: string
  objective: string
  parent: string
  parent_label: string
  anchor_id: string
  track: string
  kind: string
  target: string
  trigger: string
  decision: string
  decide_by: string
  steps: StreamStep[]
  cleared: string
  blocked: string
  confirm: string
  levels: { risk: number; progress: number; confidence: number }
  confidence: number
  log: unknown[]
  source: string
}

/**
 * Map a raw projected/synced stream JSON onto the persisted schema — PURE, defensive about
 * field types (the LLM naturally returns bools/ints/lists where strings are expected; a bare
 * slice on those would crash the whole projection). Port of _normalize_stream. Key ORDER
 * matches Python. `kind` defaults to 'active' for synced streams, else 'emerging'.
 */
export function normalizeStream(
  g: Record<string, unknown>,
  source = 'inferred',
  // The vocabulary the model's `track` is validated against. Was the module-level built-in track
  // list; cold-start A3 emptied that, which silently rewrote EVERY synced stream's track to
  // 'unknown' regardless of the vault's own ontology. Callers holding a vaultDir pass
  // `loadOntology(vaultDir)`; the default keeps the function pure and callable without one.
  onto: CompiledOntology = defaultOntology()
): NormalizedStream {
  const rawTrack = typeof g.track === 'string' ? normalizeTrackKey(g.track) : '' // legacy key → current
  const track = onto.tracks.some((t) => t.key === rawTrack)
    ? rawTrack
    : onto.trackOf(`${sOr(g.title)} ${sOr(g.objective)}`) || 'unknown'

  const steps: StreamStep[] = []
  const rawSteps = Array.isArray(g.steps) ? (g.steps as unknown[]).slice(0, 7) : []
  for (const st of rawSteps) {
    if (st && typeof st === 'object' && !Array.isArray(st)) {
      const s = st as Record<string, unknown>
      steps.push({
        event: String(s.event ?? '').slice(0, 160),
        when: cleanWhen(String(s.when ?? '')),
        lead: String(s.lead ?? '').slice(0, 24),
        done: Boolean(s.done),
        task_id: sOr(s.task_id),
        gap: Boolean(s.gap)
      })
    } else if (typeof st === 'string') {
      steps.push({ event: st.slice(0, 160), when: '', lead: '', done: false, task_id: '', gap: false })
    }
  }

  const conf = typeof g.confidence === 'number' && Number.isFinite(g.confidence) ? g.confidence : 0.5
  const lv = (g.levels && typeof g.levels === 'object' && !Array.isArray(g.levels) ? g.levels : {}) as Record<string, unknown>
  const kind =
    g.kind === 'active' || g.kind === 'emerging' ? g.kind : source === 'synced' ? 'active' : 'emerging'

  return {
    title: sOr(g.title, g.objective).slice(0, 80),
    objective: sOr(g.objective).slice(0, 240),
    parent: sOr(g.parent).slice(0, 40),
    parent_label: sOr(g.parent_label).slice(0, 80),
    anchor_id: sOr(g.anchor_id).slice(0, 48),
    track,
    kind,
    target: sOr(g.target).slice(0, 40),
    trigger: sOr(g.trigger).slice(0, 240),
    decision: sOr(g.decision).slice(0, 240),
    decide_by: cleanWhen(sOr(g.decide_by)),
    steps,
    cleared: sOr(g.cleared).slice(0, 240),
    blocked: sOr(g.blocked).slice(0, 240),
    confirm: sOr(g.confirm).slice(0, 160),
    levels: { risk: lvl(lv.risk, 0.3), progress: lvl(lv.progress, 0.1), confidence: lvl(lv.confidence, conf) },
    confidence: conf,
    log: [],
    source
  }
}

// Local-time ISO date (YYYY-MM-DD) — matches Python date.today().isoformat().
function localIsoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
// Local-time ISO seconds — matches Python datetime.now().isoformat(timespec='seconds').
function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The stream-sync prompt — verbatim from server.py:1885-1898. `anchorMenu` is the declared-
 *  anchor list (or '(none)'), `todayIso` the local date. Exported for string-diffing. */
export function buildStreamSyncPrompt(text: string, anchorMenu: string, todayIso: string): string {
  return (
    'The operator is SYNCING a strategic STREAM to his second brain — a plan/opportunity he\'s describing in his own ' +
    'words. Structure it as ONE stream: an objective reached via an ordered chain of dependent steps, gated ' +
    'by a key decision. CRUCIAL: if the objective has a target window and steps carry lead times, ' +
    'BACK-PROPAGATE the latest the decision can be made (target − total lead time) into decide_by — surface ' +
    'the hidden deadline.\n\nReturn ONLY a JSON object: {"title": short name, "objective": the goal incl. ' +
    'its target window, "target": target date/window, "anchor_id": id of the declared ANCHOR this serves ' +
    '(from the ANCHOR MENU below; "" if none fits), "track": "ProjectA"|"PartnerCo"|"Tooling"|"personal", ' +
    '"trigger": the near-term first event, "decision": the key decision to make, "decide_by": "YYYY-MM" ' +
    '(back-propagated), "steps": [{"event", "when", "lead": e.g. "~12mo"}], "cleared": the payoff if ' +
    'the path clears, "blocked": the risk/problem if it doesn\'t, "confidence": 0.0-1.0}.\n' +
    `${LANG_RULE}\n\nToday is ${todayIso}.\n\n` +
    `=== DECLARED ANCHORS (bind via anchor_id) ===\n${anchorMenu || '(none)'}\n\nThe operator's description:\n${text}`
  )
}

/** Build the anchor menu block: non-confidential declared anchors, one per line. PURE. */
export function buildAnchorMenu(decls: { id: string; name: string; date: string; track: string; confidential: boolean }[]): string {
  return decls
    .filter((d) => !d.confidential)
    .map((d) => `- ${d.id} · ${d.name} · ${d.date || 'undated'} · ${d.track || ''}`)
    .join('\n')
}

function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return rows
    throw e // a transient lock/IO error must not degrade to [] → the append below would overwrite the file empty
  }
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[stream-sync-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}
function saveFutureNodes(vaultDir: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const path = futuresPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

export type GenerateFn = (prompt: string) => Promise<string>

export interface RunStreamSyncDeps {
  generate: GenerateFn
  now?: () => Date
  today?: () => Date
  uid?: () => string
}

export interface StreamNode extends NormalizedStream {
  id: string
  status: string
  created: string
  refreshed: string
}

export interface RunStreamSyncResult {
  ok: boolean
  stream?: StreamNode
  error?: string
}

/**
 * Run the sync: build the anchor menu + prompt, call the model, parse the object, and on
 * success normalize it + stamp id/status/created/refreshed and append ONE node to
 * future-nodes.jsonl. Returns {ok:false,error} when the model can't structure it (matching
 * Python's `if not g` guard).
 */
export async function runStreamSync(
  vaultDir: string,
  text: string,
  deps: RunStreamSyncDeps
): Promise<RunStreamSyncResult> {
  if (!vaultDir) return { ok: false, error: 'no vault' }
  const today = (deps.today ?? (() => new Date()))()
  const menu = buildAnchorMenu(readAnchorDecls(vaultDir))
  const prompt = buildStreamSyncPrompt(text, menu, localIsoDate(today))
  const raw = await deps.generate(prompt)
  const g = extractFirstJsonObject(raw)
  if (!g || Object.keys(g).length === 0) return { ok: false, error: 'could not structure that' }

  const now = (deps.now ?? (() => new Date()))()
  const ts = localIsoSeconds(now)
  const uid = (deps.uid ?? (() => randomUUID().replace(/-/g, '').slice(0, 8)))()
  const node: StreamNode = {
    ...normalizeStream(g, 'synced', loadOntology(vaultDir)),
    id: uid,
    status: 'open',
    created: ts,
    refreshed: ts
  }
  const rows = loadFutureNodes(vaultDir)
  rows.push(node as unknown as Record<string, unknown>)
  saveFutureNodes(vaultDir, rows)
  return { ok: true, stream: node }
}

// world-update-native — capture loop: turn a free-text update into a structured world-state
// delta, logged as a PROPOSED draft (human-gated; applied only on world-update-act confirm).
// Port of extract_world_update. Model-backed via generateOnce (was _run_oneshot). Owns
// world-state-deltas.jsonl (append).
//
// Verification note: the LLM extraction is nondeterministic, so this is NOT byte-diffable vs the
// Python golden. The deterministic scaffolding — prompt build, JSON parse, track/type fallbacks,
// row shape — is unit-tested via an injected `generate` (canned model output). The `id`/`ts` are
// injectable for deterministic assertions.
import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { generateOnce } from './generate-once-native'
import { normalizeTrackKey } from './ontology'
import { messageOf } from '../guarded'

const deltasPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'world-state-deltas.jsonl')

// Port of _WORLD_TRACKS (key + keyword matcher). Order matters (first match wins).
const WORLD_TRACKS: { key: string; match: RegExp }[] = [
  { key: 'ProjectA', match: /ProjectA|VendorCo|vendorco|发行|B站|bilibili|抖音|douyin|taptap|xbox|playstation|ps5|steam|二测|试玩|发布会/i },
  { key: 'PartnerCo', match: /PartnerCo|partnerco|a colleague|\bpartner\b/i },
  { key: 'Tooling', match: /\bTooling\b|harness|duin|operator|vendor/i },
  { key: 'ProjectB', match: /projectb|a contact/i },
  { key: 'SupplierCo', match: /SupplierCo|supplierco|\bsupplier\b/i },
  { key: 'personal', match: /health|travel|personal|身体|体检|健康|签证|护照/i }
]
export const WORLD_TRACK_KEYS = new Set(WORLD_TRACKS.map((t) => t.key))
const TRACK_KEYS = WORLD_TRACK_KEYS
export const trackOf = (text: string): string | null => WORLD_TRACKS.find((t) => t.match.test(text))?.key ?? null

const PROMPT_HEAD =
  'Extract ONE structured world-state update from this note about the operator\'s work/life. Return ONLY a ' +
  'JSON object, no prose: {track: one of ProjectA|PartnerCo|personal|unknown, ' +
  'type: one of situation|belief|intent (situation=a fact/status changed; belief=the operator thinks/judges ' +
  'something is true; intent=the operator wants/plans/commits to do something), ' +
  'summary: a concise one-line restatement (keep names/dates), change: what specifically changed or is ' +
  'new, affects: the task/risk/person/decision it touches (short), confidence: a number 0.0-1.0}. ' +
  'Write summary/change/affects in the TRACK\'s language: ProjectA → 中文; PartnerCo → 日本語; else English ' +
  '(keep brand names like Bilibili/TapTap/Xbox as-is so they still match).\n\nNote: '

const localIsoSeconds = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const randId = (): string => Math.random().toString(16).slice(2, 10).padEnd(8, '0')

export interface WorldDelta {
  id: string
  ts: string
  text: string
  track: string
  type: string
  summary: string
  change: string
  affects: string
  confidence: unknown
  status: string
}

export interface WorldUpdateDeps {
  generate: (prompt: string, task?: 'chat' | 'extraction' | 'title' | 'code' | 'reason') => Promise<string>
  now: () => Date
  id: () => string
}
const defaultDeps: WorldUpdateDeps = { generate: generateOnce, now: () => new Date(), id: randId }

/** Extract a structured world-state delta from free text, append it as a proposed draft, return it.
 *  Port of extract_world_update. Model-backed; deterministic parse + track/type fallbacks. */
export async function extractWorldUpdate(
  vaultDir: string | null,
  text: string,
  deps: WorldUpdateDeps = defaultDeps
): Promise<WorldDelta> {
  const raw = await deps.generate(PROMPT_HEAD + text, 'extraction')
  let d: Record<string, unknown> = {}
  const m = /\{[\s\S]*\}/.exec(raw)
  if (m) {
    try {
      d = JSON.parse(m[0]) as Record<string, unknown>
    } catch {
      d = {}
    }
  }
  // The model may echo a legacy key it saw in older notes/deltas; fold it before validating.
  let track = typeof d.track === 'string' ? normalizeTrackKey(d.track) : ''
  if (!TRACK_KEYS.has(track)) track = trackOf(text) ?? 'unknown' // model unsure → keyword fallback
  let dtype = d.type === 'situation' || d.type === 'belief' || d.type === 'intent' ? (d.type as string) : 'situation'
  if (dtype === 'situation') {
    // heuristic rescue — first-person intent/belief markers the model often misses
    if (/i want|i plan|i intend|i will|i'?ll|i should|we should|i need to|打算|计划|想要|准备|我要|得去/i.test(text)) {
      dtype = 'intent'
    } else if (/i think|i believe|i feel|my read|my sense|i suspect|认为|觉得|相信|我判断|我感觉/i.test(text)) {
      dtype = 'belief'
    }
  }
  const row: WorldDelta = {
    id: deps.id(),
    ts: localIsoSeconds(deps.now()),
    text: text.slice(0, 500),
    track,
    type: dtype,
    summary: (typeof d.summary === 'string' && d.summary) || text.slice(0, 120),
    change: typeof d.change === 'string' ? d.change : '',
    affects: typeof d.affects === 'string' ? d.affects : '',
    confidence: d.confidence ?? 0.5,
    status: 'proposed'
  }
  if (vaultDir) {
    const p = deltasPath(vaultDir)
    try {
      mkdirSync(dirname(p), { recursive: true })
      appendFileSync(p, JSON.stringify(row) + '\n', 'utf-8')
    } catch (e) { console.debug('[world-update-native] best-effort; the delta is still returned for the caller:', messageOf(e)) }
  }
  return row
}

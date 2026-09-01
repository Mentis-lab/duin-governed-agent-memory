// world-update-act (native) — the human gate + reconcile for world-state deltas. Port of
// act_world_update (server.py:962) + promote_belief (928). confirm/discard/promote a proposed
// delta: confirming makes it live AND supersedes prior live deltas on the same track+subject
// (current state, not a log); promote also crystallizes a belief into an I* instinct card. On
// accept, fires a native re-projection (runProjectFutures — now that the projection engine is
// ported, this is the native _reproject_async that previously kept world-update-act proxied).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { runProjectFutures } from './project-futures-native'
import { normalizeTrackKey } from './ontology'
import { messageOf } from '../guarded'
import { recordEvent } from '../event-log'
import { seedFacts } from './operator-model'
import { CJK_CLASS } from './cjk-tokens'

const deltasPath = (v: string): string => join(v, '.duin', '_state', 'world-state-deltas.jsonl')
const INSTINCT_PILLARS = ['DUIN/Instincts', '02 Cards/instincts']

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
function instinctsPillar(base: string): string {
  return join(base, INSTINCT_PILLARS.find((c) => isDir(join(base, ...c.split('/')))) ?? INSTINCT_PILLARS[0])
}

interface Delta {
  id?: string
  status?: string
  track?: string
  type?: string
  summary?: string
  affects?: string
  confidence?: number
  superseded_by?: string
  promoted_to?: string
  [k: string]: unknown
}

function loadDeltas(v: string): Delta[] {
  let txt: string
  try {
    txt = readFileSync(deltasPath(v), 'utf-8')
  } catch {
    return []
  }
  const rows: Delta[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Delta)
    } catch (e) { console.debug('[world-update-act-write-native] skip:', messageOf(e)) }
  }
  return rows
}
function saveDeltas(v: string, rows: Delta[]): void {
  const path = deltasPath(v)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  renameSync(tmp, path)
}

// _sig_tokens (CJK-bigram) + _subject_overlap (server.py:910/918).
const STOP_TOK = new Set(['task', 'risk', 'with', 'that', 'this', 'from', 'into', 'biweekly', 'report', 'project', 'delivery'])
// CJK runs of >=2, with the tokenizer's full CJK class (kanji + KANA) rather than the bare
// ideograph range — kana bounded a run, so two Japanese deltas on the same subject shared no
// bigram and neither superseded the other.
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]{2,}`, 'g')
function sigTokens(s: string): Set<string> {
  const lc = (s || '').toLowerCase()
  const t = new Set([...lc.matchAll(/[a-z0-9]{4,}/g)].map((m) => m[0]))
  for (const run of lc.matchAll(CJK_RUN_RE)) {
    const r = run[0]
    for (let i = 0; i < r.length - 1; i++) t.add(r.slice(i, i + 2))
  }
  for (const st of STOP_TOK) t.delete(st)
  return t
}
function inter(a: Set<string>, b: Set<string>): number {
  let c = 0
  for (const x of a) if (b.has(x)) c++
  return c
}
/** Same subject? Share an affects token, or ≥2 significant tokens across affects+summary. */
export function subjectOverlap(r1: Delta, r2: Delta): boolean {
  const a1 = sigTokens(r1.affects ?? '')
  const a2 = sigTokens(r2.affects ?? '')
  if (inter(a1, a2) > 0) return true
  const t1 = new Set([...a1, ...sigTokens(r1.summary ?? '')])
  const t2 = new Set([...a2, ...sigTokens(r2.summary ?? '')])
  return inter(t1, t2) >= 2
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function yymmdd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export type GenerateFn = (prompt: string) => Promise<string>

export interface PromoteResult {
  ok: boolean
  id?: string
  path?: string
  error?: string
}

/** Build promote_belief's instinct-extraction prompt — verbatim from server.py:934-936. */
export function buildPromotePrompt(summary: string): string {
  return (
    'Turn this belief/intent of the operator\'s into an instinct. Return ONLY JSON: {slug: 3-6 ' +
    'kebab-case english words, trigger: when it fires (one line), action: what to do (one ' +
    'line)}.\n\nBelief: ' + summary
  )
}

/** Crystallize a confirmed belief/intent into a draft I* instinct card. Port of promote_belief. */
export async function promoteBelief(vaultDir: string, delta: Delta, deps: { generate: GenerateFn; today?: () => Date }): Promise<PromoteResult> {
  const summary = delta.summary ?? ''
  const track = delta.track ?? ''
  const raw = await deps.generate(buildPromotePrompt(summary))
  let j: Record<string, unknown> = {}
  const m = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  try {
    if (m) j = JSON.parse(m) as Record<string, unknown>
  } catch {
    j = {}
  }
  const slug = (String(j.slug || 'world-state-belief').toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 48)) || 'world-state-belief'
  const date = (deps.today ?? (() => new Date()))()
  const cid = `I${yymmdd(date)}-${slug}`
  const abs = instinctsPillar(vaultDir)
  const path = join(abs, cid + '.md')
  if (existsSync(path)) return { ok: false, error: 'exists' }
  const trig = String(j.trigger ?? '')
  const act = String(j.action ?? '')
  const conf = delta.confidence ?? 0.6
  const body =
    `---\ntype: instinct\ncreated: ${isoDate(date)}\nconfidence: ${conf}\n` +
    `status: draft\ntrigger: "${trig}"\naction: "${act}"\n` +
    `source-context: DUIN world-state belief capture (${track})\n---\n\n` +
    `# ${cid}\n\n> ${summary}\n\n**Trigger:** ${trig}\n\n**Action:** ${act}\n\n` +
    `*Promoted from a confirmed World-State ${delta.type ?? 'belief'} (${track}, ${isoDate(date)}).*\n`
  mkdirSync(abs, { recursive: true })
  writeFileSync(path, body, 'utf-8')
  // Schema-graft ③ (forward-note): record a self-authored "recheck" note for the promoted belief.
  // Always-on (cheap audit; only the turn-open resurface is hot-path/flagged). Never breaks promote.
  try {
    recordEvent({
      type: 'note.forward.recorded',
      actorKind: 'model',
      entityKind: 'instinct',
      entityId: cid,
      severity: 'info',
      payload: { note: 'recheck outcome of promoted belief', belief: summary, recheck: null }
    })
  } catch { /* telemetry never breaks a promote */ }
  // Schema-graft ① (ladder link, GATED DUIN_LADDER): a promoted instinct (medium tier) also enters
  // the govern gate (slow tier) as a provisional operator-fact, making taste→instinct→gated one
  // ladder. Default off = today's behavior exactly. Best-effort.
  if (process.env.DUIN_LADDER === '1' && summary.trim()) {
    try { seedFacts([{ fact: summary.trim(), kind: 'principle', status: 'provisional' }]) } catch { /* best-effort */ }
  }
  return { ok: true, id: cid, path: relative(vaultDir, path).replace(/\\/g, '/') }
}

export interface ActWorldUpdateDeps {
  generate: GenerateFn
  today?: () => Date
  /** Fire the re-projection on accept (native _reproject_async). Injected for tests; default fires
   *  runProjectFutures(force) in the background. */
  reproject?: () => void
}

export interface ActWorldUpdateResult {
  ok: boolean
  promoted?: PromoteResult | null
}

/**
 * Confirm / discard / promote a proposed world-state delta. Port of act_world_update. Confirming
 * makes it accepted and supersedes prior live deltas on the same track+type+subject; promote also
 * crystallizes an instinct. On accept, fires a native re-projection.
 */
export async function actWorldUpdate(vaultDir: string, uid: string, action: string, deps: ActWorldUpdateDeps): Promise<ActWorldUpdateResult> {
  const rows = loadDeltas(vaultDir)
  const target = rows.find((r) => r.id === uid)
  if (!target) return { ok: false }
  const accept = action === 'confirm' || action === 'promote'
  target.status = accept ? 'accepted' : 'discarded'
  let promo: PromoteResult | null = null
  if (accept) {
    for (const r of rows) {
      // Track keys compared through normalizeTrackKey: a delta written under a legacy key
      // (`3rd`, `AIX`) and one written under its current key are the same lane.
      if (
        r !== target &&
        r.status === 'accepted' &&
        normalizeTrackKey(r.track ?? '') === normalizeTrackKey(target.track ?? '') &&
        r.type === target.type &&
        subjectOverlap(r, target)
      ) {
        r.status = 'superseded'
        r.superseded_by = uid
      }
    }
    if (action === 'promote') {
      promo = await promoteBelief(vaultDir, target, deps)
      if (promo.ok && promo.id) target.promoted_to = promo.id
    }
  }
  saveDeltas(vaultDir, rows)
  if (accept) {
    const reproject = deps.reproject ?? ((): void => { void runProjectFutures(vaultDir, { generate: deps.generate, force: true }) })
    reproject()
  }
  return { ok: true, promoted: promo }
}

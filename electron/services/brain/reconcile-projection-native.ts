// The reconciliation core of the projection engine — the deterministic heart of project_futures
// (server.py:1449-1512). Given the CURRENT futures + the model's freshly-generated streams, it
// reconciles them into the set to persist: dismissed subjects stay dismissed, operator-synced streams
// aren't clobbered, an overlapping prior stream lends its id/status/created/log (claim-once, so many
// same-token streams don't all collapse onto one id), nudge/calibration levels + step done/task_id
// links survive re-projection, engaged streams the operator committed to are PINNED even if not regenerated,
// and every final id is unique. PURE + deterministic (model output + clock/id injected) — this is
// the subtle part that most needs tests; the prompt/context-building/model-call/persist ORCHESTRATION
// is a separate follow-up (needs the 5 context-builders + _resolve_step_to_task).

import { normalizeStream } from './stream-sync-write-native'
import { defaultOntology, type CompiledOntology } from './ontology'
import { CJK_CLASS } from './cjk-tokens'

const STOP_TOK = new Set(['task', 'risk', 'with', 'that', 'this', 'from', 'into', 'biweekly', 'report', 'project', 'delivery'])
// CJK runs of >=2, with the tokenizer's full CJK class (kanji + KANA) rather than the bare
// ideograph range — kana bounded a run, so a Japanese stream produced no bigrams and never
// overlapped a prior one, minting a duplicate instead of reclaiming its id.
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
/** ≥2 shared significant tokens (project_futures' _overlap). */
function overlap(a: string, b: string): boolean {
  const A = sigTokens(a)
  const B = sigTokens(b)
  let c = 0
  for (const x of A) if (B.has(x)) c++
  return c >= 2
}

const keyOf = (s: Record<string, unknown>): string => `${String(s.title ?? '')} ${String(s.objective ?? '')}`.trim()

interface Step {
  event?: string
  done?: boolean
  task_id?: string
  gap?: boolean
  [k: string]: unknown
}

export interface ReconcileDeps {
  now?: () => Date
  uid?: () => string
  /** Ground each fresh stream's steps to real tasks (port of _resolve_step_to_task, injected so the
   *  reconciliation stays pure/testable). Mutates the node's steps in place. Default: no-op. */
  groundSteps?: (node: Record<string, unknown>) => void
  /** Track vocabulary the fresh streams are normalized against. Injected (rather than read here)
   *  to keep the reconciliation pure. Omitted → the built-in default, which since cold-start A3
   *  declares no tracks, so every stream normalizes to track 'unknown'. */
  ontology?: CompiledOntology
}

function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Reconcile freshly-generated streams against the existing set. Returns the node list to persist, or
 * null when nothing fresh survived (caller keeps the existing streams — never wipe good ones). Port
 * of project_futures' reconciliation body (server.py:1449-1512).
 */
export function reconcileProjection(
  existing: Record<string, unknown>[],
  gen: Record<string, unknown>[],
  deps: ReconcileDeps = {}
): Record<string, unknown>[] | null {
  const now = (deps.now ?? (() => new Date()))()
  const nowIso = localIsoSeconds(now)
  const mkId = deps.uid ?? (() => Math.random().toString(16).slice(2, 10))
  const ground = deps.groundSteps ?? ((): void => {})

  const declined = existing.filter((s) => s.status === 'declined')
  const synced = existing.filter((s) => s.source === 'synced' && (s.status === 'open' || s.status === 'engaged'))
  const active = existing.filter((s) => (s.status === 'open' || s.status === 'engaged') && s.source !== 'synced')

  const fresh: Record<string, unknown>[] = []
  const claimed = new Set<unknown>()
  for (const g of gen) {
    const nf = normalizeStream(g, 'inferred', deps.ontology ?? defaultOntology()) as unknown as Record<string, unknown>
    const key = keyOf(nf)
    if (!key) continue
    if (declined.some((d) => overlap(key, keyOf(d)))) continue // the operator passed on this — don't resurface
    if (synced.some((s) => overlap(key, keyOf(s)))) continue // don't clobber an operator-synced stream

    // claim-once: a prior id is inheritable by at most ONE fresh stream (fixes token-collision).
    const prior = active.find((p) => !claimed.has(p.id) && overlap(key, keyOf(p)))
    if (prior) claimed.add(prior.id)

    nf.id = prior ? prior.id : mkId()
    nf.status = prior ? prior.status : 'open'
    nf.created = prior ? prior.created : nowIso
    nf.log = prior ? (Array.isArray(prior.log) ? prior.log : []) : []
    nf.refreshed = nowIso

    if (prior) {
      // preserve nudge/calibration levels + step done/task_id links across re-projection
      if (prior.levels) nf.levels = prior.levels
      const priSteps = (Array.isArray(prior.steps) ? prior.steps : []) as Step[]
      const done = new Set(priSteps.filter((st) => st.done).map((st) => st.event ?? ''))
      const nfSteps = (Array.isArray(nf.steps) ? nf.steps : []) as Step[]
      for (const st of nfSteps) {
        const ev = st.event ?? ''
        if ([...done].some((de) => de && overlap(ev, de))) st.done = true
        const m = priSteps.find((ps) => ps.event && overlap(ev, ps.event))
        if (m && m.task_id) {
          st.task_id = m.task_id
          st.gap = m.gap ?? false
        }
      }
    }
    ground(nf)
    fresh.push(nf)
  }
  if (!fresh.length) return null // empty/failed projection → caller keeps existing (never wipe)

  // pin: engaged streams the operator committed to survive even if not regenerated this round
  const freshKeys = fresh.map(keyOf)
  const pinned = active.filter((s) => s.status === 'engaged' && !freshKeys.some((fk) => overlap(keyOf(s), fk)))

  const allnodes = [...synced, ...pinned, ...fresh, ...declined]
  // final guarantee: every id unique (heals any pre-existing collision)
  const seen = new Set<unknown>()
  for (const n of allnodes) {
    if (seen.has(n.id)) n.id = mkId()
    seen.add(n.id)
  }
  return allnodes
}

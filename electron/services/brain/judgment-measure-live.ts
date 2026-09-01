// judgment-measure-live — the real (key-gated) LLM adapter for the A/B behavioral prune
// (judgment-measure.ts owns the PURE scoring). For each promoted fact it asks the model to
// (1) propose probe queries where the fact applies, (2) answer each WITH the fact injected
// as a rule vs WITHOUT, (3) grade whether each answer honors the fact — a flip (with-pass,
// without-fail) means the fact earned its slot. Expensive (several model calls per fact),
// so it runs ON-DEMAND, not on a turn tick. No engine → empty (keyless-safe). Pruning
// stays a CANDIDATE verdict — never auto-deletes; the operator/govern loop decides.
import { chatOnce, routeModel, getOllamaModels, type RouteTask } from '../providers/registry'
import { listByStatus, recordMeasurement } from './operator-model'
import { measureFacts, measureFact, type MeasureDeps, type FactMeasurement } from './judgment-measure'
import { firewallClear } from '../governance/confidential-firewall'
import { messageOf } from '../guarded'
import type { JudgeDeps, JudgeLabel } from './grounding-eval-live'

// ── Model routing (provider-agnostic + local-first) ──────────────────────────
// The measure pass makes model calls, and P6 runs it on a SCHEDULE. To keep that
// recurring cost minimal + private — and to stay portable across DUIN's many
// model APIs / a local model instead of pinning one provider like the old legacy harness
// harness — the model is chosen through this injectable router, never hardcoded.
/** The slice of the provider registry the measure pass needs. Injectable so a
 *  scheduled pass can PREFER a local model and tests can assert selection without
 *  a live registry (no provider/model is baked in). */
export interface MeasureModelRouter {
  /** Detected local (Ollama) model names — empty when no local model is running. */
  localModels(): string[]
  /** The provider-agnostic task router (registry.routeModel): first BYO-key catalog
   *  model in the task's tier order, else a local model, else null. */
  route(task: RouteTask, preferred?: string): string | null
}

/** Default router = the real provider registry. */
export const registryRouter: MeasureModelRouter = {
  localModels: () => getOllamaModels(),
  route: (task, preferred) => routeModel(task, preferred)
}

/** LOCAL-FIRST model selection for the RECURRING measure pass. Prefers a detected
 *  local (Ollama) model — zero billable cost, private, safe to run on a clock —
 *  and falls back to the operator's configured CLOUD provider via the normal
 *  provider order (routeModel) only when no local model is available. Fully
 *  provider-agnostic: local names come from Ollama auto-detection and the cloud
 *  fallback is whatever key the operator configured — nothing is pinned. */
export function selectMeasureModelLocalFirst(router: MeasureModelRouter = registryRouter): string | null {
  try {
    const local = router.localModels()
    if (local.length > 0) return `ollama:${local[0]}`
    return router.route('extraction')
  } catch {
    return null
  }
}

/** LOCAL-ONLY model selection: a detected local (Ollama) model, or NULL — NEVER the billable cloud
 *  fallback. The scheduled measure-tick uses this when backgroundAutonomy is OFF (the default), so an
 *  unattended install measures only with a free local model and is a true no-op when none is running
 *  (createMeasureDeps degrades every method to empty on a null model → zero calls, zero cost). */
export function selectMeasureModelLocalOnly(router: MeasureModelRouter = registryRouter): string | null {
  try {
    const local = router.localModels()
    return local.length > 0 ? `ollama:${local[0]}` : null
  } catch {
    return null
  }
}

/** Build the live A/B deps from a model selector. Each method degrades to
 *  empty/false when the selector yields no usable model (keyless-safe). The
 *  selector is called fresh per request so detection/config changes are picked up. */
export function createMeasureDeps(selectModel: () => string | null): MeasureDeps {
  const model = (): string | null => {
    try {
      return selectModel()
    } catch {
      return null
    }
  }
  return {
    async probes(factText) {
      const m = model()
      if (!m) return []
      try {
        const r = await chatOnce(
          [
            {
              role: 'system',
              content:
                'Generate exactly 3 short, realistic operator requests where the following rule WOULD apply. ' +
                'One per line, no numbering, no preamble.'
            },
            { role: 'user', content: factText }
          ],
          m,
          undefined,
          { purpose: 'other', role: 'judgment-measure-probe' }
        )
        return r.content
          .split('\n')
          .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 3)
      } catch {
        return []
      }
    },
    async answer(query, factText) {
      const m = model()
      if (!m) return ''
      const sys = factText ? `Follow this rule when answering: ${factText}` : 'Answer the request normally.'
      try {
        const r = await chatOnce([{ role: 'system', content: sys }, { role: 'user', content: query }], m, undefined, {
          purpose: 'other',
          role: 'judgment-measure-answer'
        })
        return r.content
      } catch (e) {
        // THROW, do not return ''. measureFact wraps each trial in a try/catch whose comment says a
        // thrown probe/answer/grade "drops that trial" — swallowing here made that safety net
        // unreachable, so a transient 429 became `withPass=false, withoutPass=false` → 'both-fail'.
        // Three of those and measureVerdict returns 'prune-candidate': "proven inert, never changed
        // an answer". That verdict is PERSISTED and four callers demote the fact on it. A provider
        // outage was permanently mislabelling real operator facts as useless.
        throw new Error(`judgment-measure answer failed: ${messageOf(e)}`, { cause: e })
      }
    },
    async grade(factText, answer) {
      const m = model()
      if (!m || !answer) return false
      try {
        const r = await chatOnce(
          [
            { role: 'system', content: 'Does the ANSWER follow the RULE? Reply with exactly "yes" or "no".' },
            { role: 'user', content: `RULE: ${factText}\n\nANSWER: ${answer}` }
          ],
          m,
          undefined,
          { purpose: 'other', role: 'judgment-measure-grade' }
        )
        return /\byes\b/i.test(r.content)
      } catch (e) {
        // Same reason as `answer` above. `false` here means "the answer did NOT follow the rule",
        // which is evidence. "I could not obtain a grade" is the ABSENCE of evidence, and the two
        // must not share a representation (constitution property 8). Throwing routes it to the
        // trial-drop the caller already implements and documents.
        throw new Error(`judgment-measure grade failed: ${messageOf(e)}`, { cause: e })
      }
    }
  }
}

// ── Grounding-eval-live JUDGE (Foundation 1-b) ───────────────────────────────
// The real-label grounding-precision eval (grounding-eval-live.ts) needs an LLM to decide, for a fact
// the matchStale signal FLAGGED, whether it is GENUINELY obsolete or a still-VALID operator preference
// that merely mentions a resolved topic. That judge is built HERE (the live-adapter home) so the scorer
// stays pure/electron-free, reusing the SAME injectable-model + keyless-safe pattern as createMeasureDeps
// and the SAME local-first selection (selectMeasureModelLocalFirst) — no provider is pinned, no key
// required. No engine ⇒ the judge ABSTAINS (null), so a keyless eval claims no precision.

const JUDGE_SYSTEM =
  'You judge whether a durable OPERATOR fact is now OBSOLETE. It was auto-flagged because it mentions a ' +
  'topic that has since RESOLVED. Decide the real question: is the fact GENUINELY obsolete (its content ' +
  'no longer applies), or is it a still-VALID operator preference/rule that merely NAMES the resolved ' +
  'topic (e.g. a general working style that happens to mention a finished project)? Reply with exactly ' +
  'one word: "stale" (genuinely obsolete) or "valid" (still a good preference).'

/** Build a live JudgeDeps from a model selector (mirrors createMeasureDeps). Each call degrades to an
 *  ABSTAIN (null) when the selector yields no usable model, on any parse miss, or on any error —
 *  keyless-safe + fail-open, so a run without an engine produces no fabricated label. The selector is
 *  called fresh per request so detection/config changes are picked up. */
export function createJudgeDeps(selectModel: () => string | null): JudgeDeps {
  const model = (): string | null => {
    try {
      return selectModel()
    } catch {
      return null
    }
  }
  return {
    async judgeStale(factText: string, matchedTopic: string): Promise<JudgeLabel | null> {
      const m = model()
      if (!m || !factText) return null
      const topicLine = matchedTopic ? `\n\nResolved topic it mentions: ${matchedTopic}` : ''
      try {
        const r = await chatOnce(
          [
            { role: 'system', content: JUDGE_SYSTEM },
            { role: 'user', content: `FACT: ${factText}${topicLine}` }
          ],
          m,
          undefined,
          { purpose: 'other', role: 'grounding-eval-judge' }
        )
        const t = r.content.toLowerCase()
        const stale = /\bstale\b|\bobsolete\b/.test(t)
        const valid = /\bvalid\b/.test(t)
        if (stale === valid) return null // ambiguous / neither → ABSTAIN (never guess)
        return stale ? 'stale' : 'valid'
      } catch {
        return null
      }
    }
  }
}

/** LOCAL-FIRST judge for the grounding-eval-live debug route — prefers a zero-cost local model, falls
 *  back to the operator's configured cloud provider, abstains when neither exists. */
export const localFirstJudgeDeps: JudgeDeps = createJudgeDeps(() => selectMeasureModelLocalFirst())

/** On-demand default (POST /state/measure-facts + MCP tool): task-routed extraction
 *  model — unchanged behavior. */
export const defaultMeasureDeps: MeasureDeps = createMeasureDeps(() => {
  try {
    return routeModel('extraction')
  } catch {
    return null
  }
})

/** Scheduled/recurring default (the P6 measure-tick): LOCAL-FIRST selection so the
 *  clock-driven pass prefers a zero-cost local model and only touches cloud when none
 *  is available — see selectMeasureModelLocalFirst. */
export const localFirstMeasureDeps: MeasureDeps = createMeasureDeps(() => selectMeasureModelLocalFirst())

/** Scheduled LOCAL-ONLY default: prefers a zero-cost local model and NEVER falls back to a billable
 *  cloud provider. The measure-tick uses this whenever backgroundAutonomy is OFF (the default) so a
 *  default unattended install can never surprise-bill; with a local model it still measures for free. */
export const localOnlyMeasureDeps: MeasureDeps = createMeasureDeps(() => selectMeasureModelLocalOnly())

export interface MeasurePassResult {
  measured: number
  keep: number
  pruneCandidates: FactMeasurement[]
  inconclusive: number
  results: FactMeasurement[]
}

/** Options for a measure pass. */
export interface MeasurePassOptions {
  /** Batch cap: measure at most this many facts this pass (≥0). Omitted ⇒ measure all
   *  (the on-demand default). The scheduled tick sets a small cap so a recurring pass is
   *  bounded even when it falls back to a cloud model. */
  limit?: number
}

/** Measure PROMOTED + PROVISIONAL facts and summarize. Returns empty when there are no
 *  eligible facts or no engine. Persists each measured efficacy signal onto its fact (additive —
 *  never changes status or prunes; prune-candidates remain human-gated review items).
 *  With `limit`, measures at most N facts, PRIORITIZING un-measured facts so a capped/recurring
 *  pass grows efficacy COVERAGE rather than re-measuring the same head every tick. */
export async function runMeasurePass(
  deps: MeasureDeps = defaultMeasureDeps,
  opts: MeasurePassOptions = {}
): Promise<MeasurePassResult> {
  // Confidential-lane firewall: a promoted fact carrying confidential content must NOT reach the
  // external A/B model (mirrors operator-govern). Filtered at the source, not per call-site.
  // Item 14: measure PROVISIONAL facts too, so the govern loop's behavioral oracle has an efficacy
  // signal to gate on BEFORE the confirm decision (doubles the A/B pool — bounded by measure cadence).
  const eligible = [...listByStatus('promoted'), ...listByStatus('provisional')].filter((f) => firewallClear(f.fact))
  // Un-measured facts first, then oldest measurement first. Coverage still wins the budget
  // while any fact lacks a signal; once coverage is complete the un-measured key is constant
  // for everyone and the tie-break takes over, so a capped pass ROTATES. Sorting on coverage
  // alone left the batch re-measuring the same first N facts forever at 100% coverage — which
  // also meant a scoring change could never reach the verdicts already on disk.
  eligible.sort((a, b) => {
    const cover = Number(a.efficacy != null) - Number(b.efficacy != null)
    if (cover !== 0) return cover
    return (a.efficacy?.measuredAt ?? 0) - (b.efficacy?.measuredAt ?? 0)
  })
  const { limit } = opts
  const selected = (typeof limit === 'number' && limit >= 0 ? eligible.slice(0, limit) : eligible).map((f) => ({
    id: f.id,
    text: f.fact
  }))
  if (selected.length === 0) return { measured: 0, keep: 0, pruneCandidates: [], inconclusive: 0, results: [] }
  const results = await measureFacts(selected, deps)
  for (const r of results) recordMeasurement(r.id, r) // persist each efficacy signal (additive)
  return measurePassSummary(results)
}

/** Item 13 — measure ONE fact incrementally (on promotion) + persist its efficacy. Fire-and-forget
 *  safe: no engine / fact-not-found / confidential-firewall → no-op. */
export async function measureOne(id: string, deps: MeasureDeps = defaultMeasureDeps): Promise<void> {
  const f = [...listByStatus('promoted'), ...listByStatus('provisional')].find((x) => x.id === id)
  if (!f || !firewallClear(f.fact)) return
  const v = await measureFact(f.fact, deps)
  recordMeasurement(id, v)
}

function measurePassSummary(results: FactMeasurement[]): MeasurePassResult {
  return {
    measured: results.length,
    keep: results.filter((r) => r.verdict === 'keep').length,
    pruneCandidates: results.filter((r) => r.verdict === 'prune-candidate'),
    inconclusive: results.filter((r) => r.verdict === 'inconclusive').length,
    results
  }
}

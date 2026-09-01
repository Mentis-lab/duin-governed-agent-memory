// personalization-blocks — the CONSUME end of DUIN's compounding-personalization
// loops, rendered as prompt blocks for buildGroundedMessages. These close three
// arrows that were previously computed-but-never-consumed:
//   - taste-engine.json (corrections→reflect→taste) → "how the operator corrects you"
//   - failure-ledger    (recurring failures)        → "known failure modes, avoid"
//   - calibration rates  (forecast/signal efficacy)  → "which kinds have held up"
// Pure functions: (data) → string. Empty input → '' so the prompt is byte-identical
// to the pre-change shape when there's nothing learned yet. Type-only imports (erased
// at runtime) keep this module free of the heavy electron/db graph, so it unit-tests
// standalone.
import type { Taste } from '../brain/learn-native'
import type { FailureLedgerRecord } from '../failure-ledger'
import type { KindRate } from '../brain/calibration-weight'
import { normalizeRuleText } from './personalization-recall'

const asText = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)

/** "HOW THE OPERATOR HAS CORRECTED YOU" — the taste engine's correction_rules
 *  (bound/confirmed first, then most recent), plus any seeded values/frameworks.
 *  This is the FAST arrow: behavior shifts from a correction before any node is
 *  promoted. Capped so a long ledger can't dominate the prompt. */
export function renderTasteBlock(taste: Taste | null | undefined, excludeRules?: Set<string>): string {
  if (!taste) return ''
  const rules = Array.isArray(taste.correction_rules) ? taste.correction_rules : []
  const ranked = [...rules].sort((a, b) => {
    const boundRank = (r: Record<string, unknown>): number => {
      const s = String(r.status ?? '')
      return s === 'bound' || s === 'confirmed' ? 1 : 0
    }
    const db = boundRank(b) - boundRank(a)
    if (db !== 0) return db
    return String(b.ts ?? '').localeCompare(String(a.ts ?? ''))
  })
  const ruleLines = ranked
    .map((r) => {
      // Veto-leak guard (Phase 0.1): the `correction` field holds "what was wrong" —
      // for a veto, the REJECTED inference itself (forwarded with polarity 'correction'
      // and an empty candidate_rule). Rendering it under "Corrections to honor" flips
      // "stop inferring X" into "do X". Only a distilled `candidate_rule` is a rule to
      // honor; never surface raw correction/veto text as positive guidance.
      const isCorrection = String(r.polarity ?? '') === 'correction'
      const rule = asText(r.candidate_rule).trim() || (isCorrection ? '' : asText(r.correction).trim())
      if (!rule) return ''
      // Phase 1b: a bound rule now grounds via the operator block; drop the taste duplicate.
      if (excludeRules && excludeRules.has(normalizeRuleText(rule))) return ''
      const why = asText(r.why).trim()
      return `- ${rule}${why ? ` (why: ${why})` : ''}`
    })
    .filter(Boolean)
    .slice(0, 12)

  const values = (Array.isArray(taste.values) ? taste.values : [])
    .map(asText)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
  const frameworks = (Array.isArray(taste.frameworks) ? taste.frameworks : [])
    .map(asText)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)

  if (ruleLines.length === 0 && values.length === 0 && frameworks.length === 0) return ''

  const sections: string[] = [
    'OPERATOR TASTE — durable guidance the operator has taught you through corrections. ' +
      'Apply these to how you write and decide; a standing correction outranks your default style.'
  ]
  if (ruleLines.length) sections.push(`Corrections to honor:\n${ruleLines.join('\n')}`)
  if (values.length) sections.push(`Values: ${values.join(' · ')}`)
  if (frameworks.length) sections.push(`Frameworks: ${frameworks.join(' · ')}`)
  return sections.join('\n')
}

/** "KNOWN FAILURE MODES" — the most systematic recurring failures (highest count,
 *  then most recent). Moves the failure ledger from advisory dashboards to
 *  generation-time avoidance so the model doesn't re-walk the same mistake. */
export function renderFailureBlock(failures: FailureLedgerRecord[] | null | undefined): string {
  if (!failures || failures.length === 0) return ''
  const ranked = [...failures]
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, 6)
  const lines = ranked
    .map((f) => {
      const msg = (f.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
      if (!msg) return ''
      const cmd = f.command ? ` [${f.command.replace(/\s+/g, ' ').trim().slice(0, 60)}]` : ''
      const times = f.count > 1 ? `×${f.count}` : ''
      return `- (${f.kind}${times}) ${msg}${cmd}`
    })
    .filter(Boolean)
  if (lines.length === 0) return ''
  return (
    'KNOWN FAILURE MODES — recurring problems from past sessions. Do NOT repeat these; ' +
    'if the current task resembles one, take the safer path and name the risk:\n' +
    lines.join('\n')
  )
}

/** "OPERATOR CALIBRATION" — which KINDS of the operator's forecasts/signals have
 *  empirically held up (min-N gated so we never manufacture confidence). Broadens
 *  calibration beyond forecast ranking into the answer prompt: when the model leans
 *  on a prediction/risk of a given kind, it now knows how much to trust that kind. */
export function renderCalibrationBlock(rates: Map<string, KindRate> | null | undefined): string {
  if (!rates || rates.size === 0) return ''
  const usable: { kind: string; rate: number }[] = []
  for (const [kind, r] of rates.entries()) {
    if (!r.gated && typeof r.rate === 'number') usable.push({ kind, rate: r.rate })
  }
  if (usable.length === 0) return ''
  const strong = usable
    .filter((u) => u.rate >= 0.6)
    .sort((a, b) => b.rate - a.rate)
    .map((u) => `${u.kind} (${Math.round(u.rate * 100)}%)`)
    .slice(0, 6)
  const weak = usable
    .filter((u) => u.rate < 0.4)
    .sort((a, b) => a.rate - b.rate)
    .map((u) => `${u.kind} (${Math.round(u.rate * 100)}%)`)
    .slice(0, 6)
  if (strong.length === 0 && weak.length === 0) return ''
  const parts: string[] = []
  if (strong.length) parts.push(`- reliable (weight up): ${strong.join(', ')}`)
  if (weak.length) parts.push(`- unreliable (caveat / weight down): ${weak.join(', ')}`)
  return (
    'OPERATOR CALIBRATION — how often each KIND of the operator\'s forecasts/signals has ' +
    'actually held up (empirical, min-N gated). When your answer leans on a prediction or ' +
    'risk of one of these kinds, weight it accordingly:\n' +
    parts.join('\n')
  )
}

/** One forecast the operator owes a verdict on (shape of simple-reads-native forecastOwed). */
export interface OwedForecastLite {
  id?: string
  predicted?: string
  eval_by?: string
  days_overdue?: number
}

/** At most this many open loops go into a turn. The point is a passing human question,
 *  not a status report — three is already more than anyone answers in one breath. */
const MAX_OWED_IN_PROMPT = 3

/**
 * Open loops the operator owes an outcome on, rendered as an invitation to ASK rather
 * than a notice to deliver.
 *
 * This used to be a notification: "2 forecasts are past their review date", fired at the
 * OS and filed in the inbox. That was the wrong instrument for the job. A forecast review
 * is not information being pushed OUT — it is a question whose whole value is the answer,
 * and a toast cannot collect one. So it got dismissed, the loop stayed open, and the
 * calibration data that depends on it never arrived.
 *
 * Asking mid-conversation works because the operator is already here and already talking.
 * The instructions below are deliberately restrictive: this competes for the end of a
 * reply with everything else the model might say, and a second brain that opens every turn
 * with "by the way…" is worse than one that never asks at all.
 */
export function renderOwedForecastsBlock(owed: OwedForecastLite[] | null | undefined): string {
  if (!Array.isArray(owed) || owed.length === 0) return ''
  const items = owed
    .filter((o) => typeof o.predicted === 'string' && o.predicted.trim())
    .slice(0, MAX_OWED_IN_PROMPT)
  if (items.length === 0) return ''
  const lines = items.map((o) => {
    const overdue =
      typeof o.days_overdue === 'number' && o.days_overdue > 0
        ? ` (due ${o.days_overdue}d ago)`
        : o.eval_by
          ? ` (due ${o.eval_by})`
          : ''
    return `- ${(o.predicted as string).trim()}${overdue}`
  })
  return (
    'OPEN LOOPS — things the operator said would happen, whose outcome you never learned:\n' +
    lines.join('\n') +
    '\n\nIf a natural opening comes up, ask about ONE of these the way a colleague would — ' +
    '"by the way, how did X end up going?" — at the END of your reply, in one short sentence. ' +
    'Rules that matter more than asking:\n' +
    '- Never interrupt the actual task to ask. The answer to what they came here for comes first.\n' +
    '- ONE per reply, at most. Never list them.\n' +
    '- If you already asked about one of these earlier in this conversation, do not ask again — ' +
    'they saw it and chose not to answer, which is itself an answer.\n' +
    '- If the moment is wrong — they are mid-problem, frustrated, or moving fast — stay quiet. ' +
    'These will keep.\n' +
    '- When they do tell you how it went, record it with the forecast-verdict tool if one is ' +
    'available; that outcome is the entire reason to ask.'
  )
}

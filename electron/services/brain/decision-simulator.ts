// decision-simulator.ts — "simulate this choice": roll DUIN's grounded world model
// forward under each option of a decision and surface divergent futures + risk
// deltas, with a consistency gate that flags ungrounded predictions.
//
// This is the world-model-as-planner pattern (WebDreamer 2411.06559) done the way
// the 2026 frontier converged on: an LLM PROPOSER grounded against the operator's
// REAL state (predicted-risks + world-state from the engine), CHECKED before it's
// presented (GILP 2606.27806 consistency gate), short-horizon and depth-labeled
// (compounding-error caution, R-WoM 2510.11892 / ProAct 2602.05327). User-triggered
// only — never an autonomous foresight loop (2601.03905: agents misuse unprompted
// simulation). See PLANNING/DUIN_DECISION_SIMULATION_SPEC.md.
//
// Pure helpers (tokenize / buildMessages / parseSimResponse / consistencyGate /
// classifyRiskDeltas) are unit-tested; the engine fetch, the model call, and the
// forecast POST are injectable seams.

import { routeModel, chatOnce } from '../providers/registry'
import { predictedRisks } from './predicted-risks-native'
import { liveNodes } from './entity-graph-store'
import { messageOf } from '../guarded'
import { CJK_CLASS, hasCjk } from './cjk-tokens'

export interface SimOption {
  id: string
  label: string
}
export interface DecisionSimRequest {
  decision: string
  context?: string
  options: SimOption[]
}
export type Horizon = 'near' | 'mid' | 'far'
export interface SimConsequence {
  text: string
  horizon: Horizon
  /** What current risk/entity the model says this follows from ('' = speculative). */
  basis: string
  /** False when the basis is speculative or not found in the grounded state. */
  supported: boolean
  note?: string
}
export interface SimRiskDelta {
  risk: string
  direction: 'up' | 'down' | 'new'
  why: string
}
export interface OptionForecast {
  optionId: string
  label: string
  consequences: SimConsequence[]
  riskDeltas: SimRiskDelta[]
  /** # of consequences the consistency gate flagged as unsupported. */
  flagged: number
  /** Ready-to-log pre-act forecast (logged only if the user commits this option). */
  forecast: { predicted: string; track: string }
}
export interface DecisionSimResult {
  decision: string
  grounded: { risks: string[]; entities: string[] }
  options: OptionForecast[]
  modelUsed: boolean
  note?: string
}

const MAX_GROUNDED = 40
const STOP = new Set(
  'the a an and or of to in for on with is are be this that it as at by from your you will would could should'.split(' ')
)

/** Run splitter. The CJK alternative is the tokenizer's full class (kanji + KANA), not
 *  the bare ideograph range — kana ran as punctuation, so Japanese terms were dropped
 *  entirely and could never match a grounded label. */
const TOK_RE = new RegExp(`[a-z0-9]+|[${CJK_CLASS}]+`, 'g')

/** Content tokens — Latin runs need >2 chars; CJK runs are meaningful at ≥2
 *  (e.g. ProjectA is a full word). Stopwords dropped. */
export function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of (s || '').toLowerCase().match(TOK_RE) ?? []) {
    const isCjk = hasCjk(t)
    if ((isCjk ? t.length >= 2 : t.length > 2) && !STOP.has(t)) out.add(t)
  }
  return out
}

// ──────────────────── grounding ────────────────────

/** Recursively collect string values of label-ish keys → a deduped, capped list. */
export function extractLabels(json: unknown): string[] {
  const KEYS = new Set(['label', 'title', 'name', 'risk', 'headline', 'predicted', 'statement', 'goal'])
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (v: unknown): void => {
    if (out.length >= MAX_GROUNDED) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && KEYS.has(k)) {
          const s = val.trim()
          if (s && s.length <= 120 && !seen.has(s)) {
            seen.add(s)
            out.push(s)
          }
        } else {
          walk(val)
        }
      }
    }
  }
  walk(json)
  return out.slice(0, MAX_GROUNDED)
}

/** World-model Stage 2(a): real grounding for the rollout.
 *
 *  This was `const origin = ''` followed by an unconditional empty return — every simulation ran
 *  grounding-BLIND in production while the prompt claimed to be grounded, and the fetch helper below
 *  it was unreachable. The brain is in-process, so the fix is to call the native producers directly
 *  rather than HTTP to ourselves: predicted risks from the forecast engine, entities from the
 *  persistent entity graph (which Stage 1 made readable).
 *
 *  Each half is independently best-effort — one source failing must degrade the rollout to
 *  partially-grounded, never fail it. */
async function defaultGround(vaultDir?: string | null): Promise<{ risks: string[]; entities: string[] }> {
  let dir = vaultDir ?? null
  if (dir === null) {
    try {
      const { readSettings } = await import('../settings-helper')
      dir = (readSettings().localBrainNotesDir as string) || null
    } catch {
      dir = null
    }
  }
  let risks: string[] = []
  try {
    risks = extractLabels(predictedRisks(dir))
  } catch (e) {
    console.debug('[decision-sim] predicted risks unavailable  rollout partially grounded:', messageOf(e))
  }
  let entities: string[] = []
  try {
    entities = liveNodes()
      .map((n) => n.label)
      .filter((l) => l && l.length <= 120)
      .slice(0, MAX_GROUNDED)
  } catch (e) {
    console.debug('[decision-sim] entity graph unavailable  rollout partially grounded:', messageOf(e))
  }
  return { risks, entities }
}

// ──────────────────── prompt + parse ────────────────────

const SIM_SYSTEM =
  'You are DUIN simulating the consequences of ONE decision option, grounded in the ' +
  "operator's CURRENT world. Predict what changes if this option is taken. Rules: " +
  '(1) Ground every consequence in the provided risks/entities — for each, name the ' +
  'specific current risk or entity it follows from in a "basis" field, or set basis ' +
  'to "" if it is speculative. (2) Prefer NEAR-term, confident consequences; mark ' +
  'longer-range ones horizon "mid"/"far". (3) Do NOT invent entities not implied by ' +
  'the provided state. Return ONLY JSON: ' +
  '{"consequences":[{"text":"...","horizon":"near|mid|far","basis":"..."}],' +
  '"riskDeltas":[{"risk":"...","direction":"up|down|new","why":"..."}]}'

export function buildMessages(
  decision: string,
  context: string,
  option: SimOption,
  grounded: { risks: string[]; entities: string[] }
): { role: 'system' | 'user'; content: string }[] {
  const risks = grounded.risks.length ? grounded.risks.map((r) => `- ${r}`).join('\n') : '(none on record)'
  const ents = grounded.entities.length ? grounded.entities.map((e) => `- ${e}`).join('\n') : '(none on record)'
  return [
    { role: 'system', content: SIM_SYSTEM },
    {
      role: 'user',
      content:
        `DECISION: ${decision}\n` +
        (context ? `CONTEXT: ${context}\n` : '') +
        `OPTION BEING SIMULATED: ${option.label}\n\n` +
        `CURRENT RISKS (grounded):\n${risks}\n\nCURRENT ENTITIES/STATE (grounded):\n${ents}\n\n` +
        `Simulate this option. Return the JSON only.`
    }
  ]
}

interface RawSim {
  consequences: { text: string; horizon: Horizon; basis: string }[]
  riskDeltas: { risk: string; direction: 'up' | 'down' | 'new'; why: string }[]
}

/** Tolerant JSON parse of the model's simulation output. */
export function parseSimResponse(text: string): RawSim {
  const empty: RawSim = { consequences: [], riskDeltas: [] }
  if (!text) return empty
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return empty
  let obj: unknown
  try {
    obj = JSON.parse(m[0])
  } catch {
    return empty
  }
  const o = obj as Record<string, unknown>
  const horizons: Horizon[] = ['near', 'mid', 'far']
  const consequences = Array.isArray(o.consequences)
    ? (o.consequences as Record<string, unknown>[])
        .map((c) => ({
          text: typeof c.text === 'string' ? c.text.trim() : '',
          horizon: (horizons as string[]).includes(c.horizon as string) ? (c.horizon as Horizon) : 'mid',
          basis: typeof c.basis === 'string' ? c.basis.trim() : ''
        }))
        .filter((c) => c.text.length >= 3)
        .slice(0, 8)
    : []
  const dirs = ['up', 'down', 'new']
  const riskDeltas = Array.isArray(o.riskDeltas)
    ? (o.riskDeltas as Record<string, unknown>[])
        .map((d) => ({
          risk: typeof d.risk === 'string' ? d.risk.trim() : '',
          direction: (dirs as string[]).includes(d.direction as string)
            ? (d.direction as 'up' | 'down' | 'new')
            : 'new',
          why: typeof d.why === 'string' ? d.why.trim() : ''
        }))
        .filter((d) => d.risk.length >= 2)
        .slice(0, 8)
    : []
  return { consequences, riskDeltas }
}

// ──────────────────── consistency gate ────────────────────

/** The cheap GILP-style gate: a consequence is SUPPORTED only if the model named a
 *  non-empty basis AND that basis shares a content token with the grounded state.
 *  Everything else is flagged ("DUIN imagined this; your notes don't support it"). */
export function consistencyGate(
  raw: RawSim['consequences'],
  grounded: { risks: string[]; entities: string[] }
): SimConsequence[] {
  const groundTokens = new Set<string>()
  for (const s of [...grounded.risks, ...grounded.entities]) for (const t of tokenize(s)) groundTokens.add(t)
  return raw.map((c) => {
    const basisTokens = tokenize(c.basis)
    const hasBasis = c.basis.length > 0
    const grounds = [...basisTokens].some((t) => groundTokens.has(t))
    const supported = hasBasis && grounds && groundTokens.size > 0
    return {
      text: c.text,
      horizon: c.horizon,
      basis: c.basis,
      supported,
      note: supported
        ? undefined
        : !hasBasis
          ? 'speculative — the model gave no grounding'
          : 'not supported by your current world-state'
    }
  })
}

/** A riskDelta is 'new' unless its named risk overlaps a grounded risk. */
export function classifyRiskDeltas(
  raw: RawSim['riskDeltas'],
  groundedRisks: string[]
): SimRiskDelta[] {
  const riskTokenSets = groundedRisks.map((r) => tokenize(r))
  return raw.map((d) => {
    const dt = tokenize(d.risk)
    const known = riskTokenSets.some((set) => [...dt].some((t) => set.has(t)))
    return { risk: d.risk, direction: known ? d.direction : 'new', why: d.why }
  })
}

// ──────────────────── orchestrator ────────────────────

export interface SimDeps {
  ground: () => Promise<{ risks: string[]; entities: string[] }>
  /** Returns the model's raw text, or null when no model is configured. */
  runModel: (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string | null>
}

async function defaultRunModel(
  messages: { role: 'system' | 'user'; content: string }[]
): Promise<string | null> {
  const model = routeModel('reason')
  if (!model) return null
  try {
    const r = await chatOnce(messages, model, undefined, { purpose: 'other', role: 'decision-sim' })
    return r.content
  } catch {
    return null
  }
}

// Widened to the tokenizer's full CJK class (kanji + KANA): a pure-kana option label
// otherwise stripped to '' and every such option collided on the same id.
const SLUG_STRIP_RE = new RegExp(`[^a-z0-9${CJK_CLASS}]+`, 'g')
const slug = (s: string): string =>
  (s || '').toLowerCase().replace(SLUG_STRIP_RE, '-').replace(/^-+|-+$/g, '').slice(0, 48)

/**
 * Simulate every option of a decision. READ-ONLY — never logs a forecast (logging
 * only the option the user actually leans toward is `commitDecisionForecast`).
 */
export async function simulateDecision(
  req: DecisionSimRequest,
  deps?: Partial<SimDeps>
): Promise<DecisionSimResult> {
  const ground = deps?.ground ?? defaultGround
  const runModel = deps?.runModel ?? defaultRunModel
  const decision = (req.decision || '').trim()
  const options = (req.options || []).filter((o) => o && o.label?.trim()).slice(0, 5)

  const grounded = await ground()
  let modelUsed = false
  const out: OptionForecast[] = []

  for (const option of options) {
    const text = await runModel(buildMessages(decision, req.context ?? '', option, grounded))
    if (text !== null) modelUsed = true
    const raw = parseSimResponse(text ?? '')
    const consequences = consistencyGate(raw.consequences, grounded)
    const riskDeltas = classifyRiskDeltas(raw.riskDeltas, grounded.risks)
    const flagged = consequences.filter((c) => !c.supported).length
    const lead = consequences.find((c) => c.supported)?.text ?? consequences[0]?.text ?? '(no prediction)'
    out.push({
      optionId: option.id,
      label: option.label,
      consequences,
      riskDeltas,
      flagged,
      forecast: { predicted: `${decision} → "${option.label}": ${lead}`.slice(0, 280), track: '' }
    })
  }

  return {
    decision,
    grounded,
    options: out,
    modelUsed,
    note: modelUsed
      ? undefined
      : 'No model configured — connect one for a grounded rollout. (Showing your current risks as the baseline.)'
  }
}

// ──────────────────── commit (pre-act forecast logging) ────────────────────

export interface CommitForecastInput {
  decision: string
  optionId: string
  predicted: string
  track?: string
  /** Numeric confidence in [0,1] for the committed option; default 0.5. */
  confidence?: number
  /** Review date YYYY-MM-DD; default = today + 30d. */
  evalBy?: string
  now?: () => Date
}

// The native local brain (:8799) owns the single-writer /state/forecast route,
// so commit targets that native gate directly.
import { LOCAL_BRAIN_ORIGIN } from '../../shared/brain-port'
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)

function plus30(now: () => Date): string {
  const d = now()
  d.setDate(d.getDate() + 30)
  return d.toISOString().slice(0, 10)
}

/**
 * Log the PRE-ACT forecast for the option the operator is committing to — through
 * the engine's single-writer `/state/forecast` (idempotent on a stable id, so a
 * re-commit is a no-op). Only the CHOSEN path is logged, never untaken options.
 * It then flows resolve→verdict→calibration like any forecast.
 */
export async function commitDecisionForecast(
  input: CommitForecastInput,
  poster?: (origin: string, body: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const origin = LOCAL_BRAIN_ORIGIN
  const now = input.now ?? ((): Date => new Date())
  const body = {
    predicted: (input.predicted || '').slice(0, 280),
    confidence: clamp01(input.confidence ?? 0.5),
    eval_by: input.evalBy || plus30(now),
    track: input.track || '',
    id: `decsim:${slug(input.decision)}:${slug(input.optionId)}`
  }
  const post =
    poster ??
    (async (o: string, b: Record<string, unknown>) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const r = await fetch(o.replace(/\/$/, '') + '/state/forecast', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
          signal: controller.signal
        })
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string }
        // Re-commit is storage-idempotent: the single-writer gate 400s a duplicate id
        // ("forecast id already exists"). That is a SUCCESS for our purposes — the forecast
        // is already logged — so surface it as ok:true rather than a spurious UI error.
        if (!r.ok && typeof j.error === 'string' && /already exists/i.test(j.error)) {
          return { ok: true, id: j.id ?? (b.id as string) }
        }
        return { ok: r.ok && j.ok !== false, id: j.id, error: j.error }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? 'post failed' }
      } finally {
        clearTimeout(timer)
      }
    })
  return post(origin, body)
}

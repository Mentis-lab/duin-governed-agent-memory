// generate_strategy / generate_mental_model (native) — draft a strategy (Playing-to-Win cascade)
// or a mental model (principle/lens/framework/playbook) from a line of direction, grounded in the
// vault. Port of generate_strategy (server.py:7256) + generate_mental_model (7352). These WRITE
// NOTHING — pure generate-and-return for the user to review; persistence is the separate
// *-save routes. The model call is injected. NB the Python engine POSTs these to /agui (grounded);
// the faithful path passes a GROUNDED generate here (the handler wires retrieval+context). A bare
// generate still works — it just loses vault grounding, so prefer a grounded one for real use.

const MODEL_TEMPLATES: Record<string, [string, string][]> = {
  strategy: [['aspiration', 'Goals & aspirations'], ['where_to_play', 'Where to play'], ['how_to_win', 'How to win'], ['capabilities', 'Capabilities'], ['values', 'Values / guardrails']],
  principle: [['statement', 'The principle'], ['why', 'Why it holds'], ['applies_when', 'When it applies'], ['examples', 'In practice']],
  lens: [['lens', 'The lens'], ['reveals', 'What it surfaces'], ['prompts', 'Questions it prompts'], ['watch_fors', 'Watch-fors']],
  framework: [['steps', 'The steps'], ['use_when', 'When to use it'], ['io', 'Inputs → outputs'], ['examples', 'In practice']],
  playbook: [['trigger', 'Trigger'], ['plays', 'Plays / steps'], ['watch_fors', 'Watch-fors'], ['examples', 'In practice']]
}
export const MODEL_TYPES = Object.keys(MODEL_TEMPLATES)
export const STRAT_KEYS = ['aspiration', 'where_to_play', 'how_to_win', 'capabilities', 'values']
/** The section keys for a mental-model type (falls back to strategy). Port of _model_keys. */
export function modelKeys(mtype: string): string[] {
  return (MODEL_TEMPLATES[mtype] ?? MODEL_TEMPLATES.strategy).map(([k]) => k)
}
const TYPE_DESC: Record<string, string> = {
  strategy: 'a Playing-to-Win strategy',
  principle: 'an operating principle / tenet',
  lens: 'a thinking lens (a way of looking)',
  framework: 'a structured framework / method',
  playbook: 'a playbook for a recurring situation'
}

export type GenerateFn = (prompt: string) => Promise<string>

/** Parse the model's `{...}` reply into string sections for the given keys. First `{` to last `}`,
 *  JSON.parse; every key coerced to a string (missing → ''). Returns null on no-object/parse-fail
 *  (Python returns an error). */
function parseSections(raw: string, keys: string[]): Record<string, string> | null {
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = String(parsed[k] ?? '')
  return out
}

/** The strategy prompt — verbatim from server.py:7263-7271. */
export function buildStrategyPrompt(level: string, target: string, instruction: string): string {
  const title = target || 'my overall knowledge work'
  const instr = (instruction || '').trim()
  return (
    `Draft a STRATEGY for "${title}" (${level} level) using the Playing-to-Win cascade. ` +
    (instr ? `Direction from me: ${instr} ` : '') +
    'Ground it in what you know about me from the vault (me.md, 03 Projects, goals, prior decisions, tracks). ' +
    'Reply with ONLY a JSON object — no prose, no code fence — with these exact string keys, each a few tight ' +
    'markdown \'-\' bullet lines:\n' +
    '{"aspiration":"goals & aspirations","where_to_play":"focus areas","how_to_win":"choices & decisions",' +
    '"capabilities":"what I must be able to do","values":"principles / guardrails"}'
  )
}

/** The mental-model prompt — verbatim from server.py:7363-7369. */
export function buildModelPrompt(mtype: string, title: string, instruction: string): string {
  const t = MODEL_TYPES.includes(mtype) ? mtype : 'strategy'
  const tmpl = MODEL_TEMPLATES[t]
  const instr = (instruction || '').trim()
  const keyspec = tmpl.map(([k, lbl]) => `"${k}":"${lbl}"`).join(', ')
  return (
    `Draft ${TYPE_DESC[t]} titled "${(title || '').trim() || '(untitled)'}". ` +
    (instr ? `Direction from me: ${instr} ` : '') +
    'Ground it in what you know about me from the vault (me.md, projects, prior decisions, cards, judgment). ' +
    'Reply with ONLY a JSON object — no prose, no code fence — these exact string keys, each a few tight ' +
    `markdown '-' bullet lines:\n{${keyspec}}`
  )
}

export interface GenerateResult {
  ok: boolean
  error?: string
  type?: string
  sections?: Record<string, string>
}

/** Generate a strategy's 5-section cascade (no writes). Port of generate_strategy. */
export async function runGenerateStrategy(payload: Record<string, unknown>, deps: { generate: GenerateFn }): Promise<GenerateResult> {
  const level = String(payload.level ?? 'project')
  const target = String(payload.target ?? '')
  const instruction = String(payload.instruction ?? '')
  try {
    const sections = parseSections(await deps.generate(buildStrategyPrompt(level, target, instruction)), STRAT_KEYS)
    return sections ? { ok: true, sections } : { ok: false, error: 'could not parse a strategy from the model output' }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'generation failed' }
  }
}

/** Generate a mental model of a given type (no writes). Port of generate_mental_model. */
export async function runGenerateModel(payload: Record<string, unknown>, deps: { generate: GenerateFn }): Promise<GenerateResult> {
  const mtype = MODEL_TYPES.includes(String(payload.type)) ? String(payload.type) : 'strategy'
  const keys = MODEL_TEMPLATES[mtype].map(([k]) => k)
  const title = String(payload.title ?? payload.target ?? '')
  const instruction = String(payload.instruction ?? '')
  try {
    const sections = parseSections(await deps.generate(buildModelPrompt(mtype, title, instruction)), keys)
    return sections ? { ok: true, type: mtype, sections } : { ok: false, error: 'could not parse a model from the output' }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'generation failed' }
  }
}

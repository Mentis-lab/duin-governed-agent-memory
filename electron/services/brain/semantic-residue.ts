// semantic-residue — the MODEL pass that catches what the deterministic staleness layer can't:
// a belief/claim that concerns a matter a resolved decision/stream has SETTLED, but shares no
// verbatim tokens with it (the paraphrase case). Per the design (DUIN_LEARNING_METABOLISM.md §3,
// DUIN_GRAPH_METABOLISM.md §3): reserve the model for the RESIDUE, last + small, as a NOISY oracle
// — batched, conservative, verdicts tagged `model` (lower trust than deterministic), SHADOW only.
//
// PURE prompt/parse (testable without a model) + an injected model dep. Embeddings are deliberately
// NOT used to detect staleness (MemStrata: they can't separate stale from fresh); they'd only be a
// cost pre-filter at scale, which the tiny current stores don't need.

import { chatOnce, routeModel } from '../providers/registry'

export interface ResidueCandidate {
  id: string
  text: string
}
export interface ResidueVerdict {
  id: string
  topic: string
  reason: string
}
export interface ResidueDeps {
  model(): string | null
  chat(messages: { role: 'system' | 'user'; content: string }[], model: string): Promise<string>
}

export const defaultResidueDeps: ResidueDeps = {
  model: () => routeModel('extraction'),
  chat: async (messages, m) => {
    const r = await chatOnce(messages, m, undefined, { purpose: 'other', role: 'semantic-residue' })
    return r.content
  }
}

const CAND_CAP = 40
const TOPIC_CAP = 30

/** PURE: the batched, conservative prompt. Empty messages if there's nothing to judge. */
export function buildResiduePrompt(
  candidates: ResidueCandidate[],
  topics: string[]
): { role: 'system' | 'user'; content: string }[] {
  if (!candidates.length || !topics.length) return []
  const sys =
    'You audit an operator\'s CONFIRMED beliefs for STALENESS. The listed matters have RESOLVED ' +
    '(been settled or have passed). Flag a belief ONLY IF it concerns a question that one of those ' +
    'resolved matters has now settled — i.e. the belief is about something no longer open. Be ' +
    'CONSERVATIVE: if you are unsure, do NOT flag it. Never flag a timeless preference or an ' +
    'evergreen fact. Return ONLY a JSON array of {"id","topic","reason"} for the flagged beliefs, ' +
    'or [] if none.'
  const resolved = topics.slice(0, TOPIC_CAP).map((t) => `- ${t}`).join('\n')
  const beliefs = candidates.slice(0, CAND_CAP).map((c) => `[${c.id}] ${c.text}`).join('\n')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `RESOLVED MATTERS:\n${resolved}\n\nBELIEFS:\n${beliefs}` }
  ]
}

/** PURE: tolerant parse of the model's JSON array; drops rows that don't match a candidate id. */
export function parseResidueVerdicts(content: string, validIds: Set<string>): ResidueVerdict[] {
  const start = content.indexOf('[')
  const end = content.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr: unknown
  try {
    arr = JSON.parse(content.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: ResidueVerdict[] = []
  for (const row of arr) {
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>
      const id = typeof r.id === 'string' ? r.id : ''
      if (id && validIds.has(id)) {
        out.push({
          id,
          topic: typeof r.topic === 'string' ? r.topic : '',
          reason: typeof r.reason === 'string' ? r.reason : 'model judged this settled by a resolved matter'
        })
      }
    }
  }
  return out
}

/** Run the model residue pass. Returns [] when no model / no candidates / no topics, or on error. */
export async function runSemanticResidue(
  candidates: ResidueCandidate[],
  topics: string[],
  deps: ResidueDeps = defaultResidueDeps
): Promise<ResidueVerdict[]> {
  const m = deps.model()
  if (!m) return []
  const messages = buildResiduePrompt(candidates, topics)
  if (!messages.length) return []
  try {
    const content = await deps.chat(messages, m)
    return parseResidueVerdicts(content, new Set(candidates.map((c) => c.id)))
  } catch {
    return []
  }
}

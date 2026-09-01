// named-skill — WS4.1 (BUILD / Voyager): distill a success trace into a NAMED, composable skill.
// success-miner captures raw (query, answer) successes; skill-library retrieves them as raw few-shot
// exemplars. This is the next rung: a success-verified trace is distilled (by the model, in the
// route) into a named procedure + description, stored + retrievable by description. PURE — no I/O,
// no model, no clock (distillation + `now` are injected), so it is fully unit-testable. The Voyager
// write-gate lives at the caller: only an endorsement-verified trace is ever distilled here.

export interface NamedSkill {
  id: string
  name: string
  description: string
  procedure: string
  sourceTraceIds: string[]
  relatedSkillIds: string[]
  createdAt: number
}

/** Deterministic id from the skill name + seed — no Date.now / Math.random, reproducible + testable. */
function skillId(name: string, now: number, idSeed?: string): string {
  const base = idSeed ?? `${name}-${now}`
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `skill-${slug || String(now)}`
}

/** Mint a named skill from a success-verified trace + the INJECTED distillation (the model call is
 *  the caller's job). PURE. */
export function distillToSkill(
  trace: { id: string; query: string; answer: string },
  distilled: { name: string; description: string; procedure: string },
  now: number,
  idSeed?: string
): NamedSkill {
  const name = (distilled.name ?? '').trim() || 'unnamed skill'
  return {
    id: skillId(name, now, idSeed),
    name,
    description: (distilled.description ?? '').trim(),
    procedure: (distilled.procedure ?? '').trim(),
    sourceTraceIds: trace.id ? [trace.id] : [],
    relatedSkillIds: [],
    createdAt: now
  }
}

export interface NamedSkillPolicy {
  topK: number
  floor: number
}
export const DEFAULT_NAMED_SKILL_POLICY: NamedSkillPolicy = { topK: 3, floor: 0.2 }

/** Rank named skills for a request by an INJECTED scorer over each skill's description (falling back
 *  to its name). Apply the floor + topK. PURE (scorer injected — pass skill-library's overlap or an
 *  embedding cosine at the call site). */
export function selectSkills(
  query: string,
  skills: NamedSkill[],
  score: (q: string, text: string) => number,
  policy: NamedSkillPolicy = DEFAULT_NAMED_SKILL_POLICY
): NamedSkill[] {
  return skills
    .map((s) => ({ s, sc: score(query, s.description || s.name) }))
    .filter((x) => x.sc >= policy.floor)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, policy.topK)
    .map((x) => x.s)
}

/** Render selected named skills as a compact "PROVEN PROCEDURES" grounding block — the READ-BACK
 *  half of the Voyager loop (distilled skills injected into the prompt). Mirrors skill-library's
 *  renderExemplarsBlock. PURE. */
export function renderNamedSkills(skills: NamedSkill[]): string {
  if (!skills.length) return ''
  const lines = skills.map((s) => {
    const head = `- ${s.name}${s.description ? `: ${s.description}` : ''}`
    return s.procedure ? `${head}\n  ${s.procedure}` : head
  })
  return `PROVEN PROCEDURES (skills distilled from your past successes — reuse when they fit this request):\n${lines.join('\n')}`
}

// active-skills.ts — PURE rendering of the operator's explicitly-enabled Skills.
//
// Kept in its own module (not inside agui-grounding) because agui-grounding transitively imports
// server.ts, which imports electron's `app` — so anything living there is untestable without an
// electron runtime. The boundary this fix is about deserves a test that can actually run.

import type { ResolvedSkill } from '../../shared/chat-send-contract'

/**
 * Total characters the ACTIVE SKILLS block may occupy. The block is injected at FLOOR tier (never
 * evicted by the context compiler), which is correct — the operator chose these — but a floor block
 * with no ceiling can starve retrieval CONTEXT and the operator/recall blocks. ~12k chars is ≈3k
 * tokens, ~12% of DEFAULT_CONTEXT_BUDGET_TOKENS (24k).
 */
export const ACTIVE_SKILLS_TOTAL_CHAR_BUDGET = 12_000
/** No single skill may consume more than half the block's budget. */
export const ACTIVE_SKILLS_PER_SKILL_CHAR_BUDGET = 6_000

export interface RenderActiveSkillsOptions {
  totalCharBudget?: number
  perSkillCharBudget?: number
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  // Cut on a line boundary where possible so a skill never ends mid-instruction.
  const cut = text.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  const body = lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut
  return { text: `${body}\n…(skill truncated — over the per-skill budget)`, truncated: true }
}

/**
 * Render the user's EXPLICITLY-ENABLED skills (Customize → Skills) as a grounding block.
 *
 * Distinct from the procedural-memory `skillBlock` (past successes ranked by relevance) and the
 * distilled `namedSkillBlock` (Voyager skills): those are things the system CHOSE to recall. This
 * is what the operator deliberately switched on, so it is injected unconditionally and at floor
 * tier — never ranked, never dropped under budget pressure.
 *
 * Until 2026-07-20 these never reached the default chat path at all: the ids died at the
 * `if (!rawBypass) { … return }` early return in ipc/chat.ts, so the toggle changed nothing.
 *
 * BUDGET DISCIPLINE: over-budget content is truncated or omitted, but NEVER SILENTLY. An omitted
 * skill is named in the block, so the model (and anyone reading a transcript) can see that the
 * operator enabled something that did not fully fit. Silent dropping is the exact failure mode this
 * whole fix exists to eliminate — reintroducing it here under the banner of "budget" would be worse
 * than the original defect, because it would be intermittent.
 */
export function renderActiveSkills(
  skills: ResolvedSkill[] | undefined,
  opts: RenderActiveSkillsOptions = {}
): string {
  if (!skills || !skills.length) return ''
  const totalBudget = opts.totalCharBudget ?? ACTIVE_SKILLS_TOTAL_CHAR_BUDGET
  const perSkillBudget = opts.perSkillCharBudget ?? ACTIVE_SKILLS_PER_SKILL_CHAR_BUDGET

  const usable = skills.filter((s) => s && typeof s.content === 'string' && s.content.trim())
  if (!usable.length) return ''

  const rendered: string[] = []
  const omitted: string[] = []
  let used = 0

  for (const s of usable) {
    const { text: body } = truncate(s.content.trim(), perSkillBudget)
    const attrs = [`name="${s.name}"`]
    if (s.description) attrs.push(`description="${s.description}"`)
    // 'suggested-tools', NOT 'allowed-tools': the gate does not enforce this list (the coherence
    // audit flagged the old wording as implying an enforcement that does not exist). Advisory
    // text that admits it is advisory.
    if (s.allowedTools?.length) attrs.push(`suggested-tools="${s.allowedTools.join(',')}"`)
    const block = `<skill ${attrs.join(' ')}>\n${body}\n</skill>`
    // Always render at least one skill, even if a single huge skill exceeds the total budget —
    // honouring nothing would be a silent no-op, which is the failure mode we are eliminating.
    if (rendered.length && used + block.length > totalBudget) {
      omitted.push(s.name)
      continue
    }
    rendered.push(block)
    used += block.length
  }

  if (!rendered.length) return ''
  const header =
    'ACTIVE SKILLS — the operator explicitly enabled these procedures for this turn. Follow them ' +
    "where they apply; they outrank your general habits but not the operator's direct instruction."
  const footer = omitted.length
    ? `\n\n(NOTE: the operator also enabled ${omitted.length} further skill(s) — ` +
      `${omitted.join(', ')} — omitted here because the ACTIVE SKILLS budget was reached. ` +
      `Say so if the user's request seems to depend on one of them.)`
    : ''
  return `${header}\n\n${rendered.join('\n\n')}${footer}`
}

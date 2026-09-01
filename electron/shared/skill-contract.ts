// skill-contract.ts — THE single declaration of what a Skill's fields DO.
//
// WHY THIS FILE EXISTS:
// chat-send-contract.ts stopped composer fields from being silently dropped in transport. This is
// the same guarantee one level up, for the SKILL SCHEMA itself — because the transport contract
// cannot see a field that is parsed, persisted, round-tripped through IPC, rendered in the New
// Skill wizard, and then read by nobody.
//
// That is not hypothetical. As of the 2026-07-20/21 audit, TWO skill fields were exactly that:
//   • `autoInvoke`  — parsed from frontmatter (skill-loader.ts:162-167, supporting three spellings),
//                     merged on update (ipc/skills.ts:135-137), surfaced over IPC (:191)… and never
//                     consulted by anything that decides whether a skill is applied.
//   • `model`       — parsed, stored, surfaced (ipc/skills.ts:190)… and never used to route a turn.
// A user filling in either field in the wizard is configuring nothing. Nobody noticed because
// "the field exists and round-trips" looks identical in review to "the field works".
//
// THE GUARANTEE: SKILL_FIELD_DISPOSITION is typed `Record<SkillField, SkillFieldDisposition>`, so
// ADDING A FIELD TO THE SKILL SCHEMA WITHOUT SAYING WHAT CONSUMES IT IS A COMPILE ERROR. A field
// may legitimately be advisory or unwired — but that must be a decision someone recorded, with a
// named consumer or a named reason, not an omission that ships as a dead control.
//
// See PLANNING/DUIN_UI_ENGINE_COHERENCE_2026-07-20.md.

/** Every field a Skill can carry. Extend this and the compiler will demand a disposition. */
export interface SkillFields {
  /** Stable id derived from the file/directory path. */
  id: string
  /** Display name; rendered into the ACTIVE SKILLS block. */
  name: string
  /** One-line summary; rendered as an attribute and shown in the UI list. */
  description?: string
  /** The procedure body injected into the prompt. */
  content: string
  /** Tool allowlist. ADVISORY today — see the disposition. */
  allowedTools?: string[]
  /** Per-skill model override. */
  model?: string
  /** Whether the model may invoke the skill without the operator enabling it. */
  autoInvoke?: boolean
}

export type SkillField = keyof SkillFields

export type SkillFieldDisposition =
  /** Read by a named consumer that changes model-visible behaviour. */
  | { kind: 'wired'; consumer: string; effect: string }
  /**
   * Reaches the model as text but is NOT enforced by any gate or router. Legitimate — but the UI
   * must not imply enforcement, and `uiLabel` records the wording that keeps it honest.
   */
  | { kind: 'advisory'; consumer: string; uiLabel: string; notEnforcedBy: string }
  /** Parsed/stored but nothing consumes it. `reason` is required; this is a known dead control. */
  | { kind: 'unwired'; reason: string; wouldNeed: string }

/**
 * EXHAUSTIVE. The Record type is the enforcement — a new SkillFields key with no entry here fails
 * `npm run typecheck`.
 */
export const SKILL_FIELD_DISPOSITION: Record<SkillField, SkillFieldDisposition> = {
  id: {
    kind: 'wired',
    consumer: 'ipc/chat.ts resolveActiveSkills',
    effect: 'selects which skill bodies are resolved and sent on the /agui body'
  },
  name: {
    kind: 'wired',
    consumer: 'local-brain/active-skills.ts renderActiveSkills',
    effect: 'rendered as the <skill name="…"> attribute the model reads'
  },
  description: {
    kind: 'wired',
    consumer: 'local-brain/active-skills.ts renderActiveSkills',
    effect: 'rendered as the description attribute; also the UI list subtitle'
  },
  content: {
    kind: 'wired',
    consumer: 'local-brain/active-skills.ts renderActiveSkills',
    effect: 'the procedure body itself, injected at floor tier into the system prompt'
  },
  allowedTools: {
    kind: 'advisory',
    consumer: 'local-brain/active-skills.ts renderActiveSkills',
    uiLabel: 'suggested-tools',
    notEnforcedBy:
      'agui-gate.resolveAguiGate / agui-subagent tool filter — neither consults a skill tool list, ' +
      'so this constrains nothing. Rendered as "suggested-tools" rather than "allowed-tools" so the ' +
      'wording does not imply a gate that does not exist. Enforcing it would mean intersecting it ' +
      'into the dispatch-time allow predicate, as subagentToolAllowed already does for subagents.'
  },
  model: {
    kind: 'unwired',
    reason:
      'Parsed (skill-loader) and surfaced (ipc/skills.ts:190) but no router reads it. The turn model ' +
      'comes from the composer selection alone. Left unwired DELIBERATELY: with several skills ' +
      'enabled at once there is no defined precedence, so honouring it would be a guess about intent.',
    wouldNeed:
      'a precedence rule for multiple enabled skills (first-wins / most-recently-enabled / explicit ' +
      'priority), then threading the winner into the engineModel choice in ipc/chat.ts.'
  },
  autoInvoke: {
    kind: 'unwired',
    reason:
      'Parsed from three frontmatter spellings (skill-loader.ts:162-167) and preserved across ' +
      'updates, but nothing decides anything with it. Every skill today is applied only when the ' +
      'operator toggles it on. Left unwired DELIBERATELY: auto-applying a skill changes the system ' +
      'prompt without the operator asking, which is a governance decision, not a wiring detail.',
    wouldNeed:
      'a relevance test (the named-skill ranker in brain/named-skill.ts is the obvious candidate) ' +
      'plus a visible indication in the composer that a skill was auto-applied, so an ' +
      'auto-invoked skill is never invisible to the operator.'
  }
}

/** Fields that reach the model in some form (wired or advisory). Derived — cannot drift. */
export const SKILL_FIELDS_REACHING_MODEL = (Object.keys(SKILL_FIELD_DISPOSITION) as SkillField[]).filter(
  (k) => SKILL_FIELD_DISPOSITION[k].kind !== 'unwired'
)

/**
 * Known dead controls. NON-EMPTY IS EXPECTED — these are documented product decisions, not bugs.
 * The value of the list is that it is a list: a field cannot join it by accident, and anything the
 * UI collects that appears here needs wording that does not promise an effect.
 */
export const UNWIRED_SKILL_FIELDS = (Object.keys(SKILL_FIELD_DISPOSITION) as SkillField[]).filter(
  (k) => SKILL_FIELD_DISPOSITION[k].kind === 'unwired'
)

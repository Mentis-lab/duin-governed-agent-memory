// Brain identity generator — turns a first-run interview into the two vault-root
// foundation files the grounding loader reads into EVERY chat turn:
//   ME.md    ← who the OWNER is (operator identity + current context)
//   BRAIN.md ← who DUIN is FOR this owner (its operating contract)
//
// See electron/services/brain/brain-root.ts `loadBrain` / `buildBrainGroundingBlock`:
// it reads `<notesDir>/BRAIN.md` + `ME.md` first and prepends them as "WHO YOU ARE
// + WHO THE OWNER IS". Before this, onboarding only seeded graph nodes (brain-seed.ts)
// — so a from-nothing user's grounding block was EMPTY (the brain didn't know them).
// This closes that cold-start gap: keyless + deterministic (no LLM), so it works before
// a model is connected. A model-drafted infer→confirm (richer ME.md from the notes) can
// layer on top later; this is the reliable floor.

import type { InterviewAnswers } from './brain-seed'

/** Interview inputs for identity. Identity fields (who you are + how to work with you)
 *  plus the existing current-context answers (what's on your plate). All optional —
 *  the generator degrades gracefully and only writes ME.md when there's real signal. */
export interface IdentityInput extends Partial<InterviewAnswers> {
  /** Preferred name / what DUIN should call you. */
  name?: string
  /** One-line role — what you do. */
  role?: string
  /** Domain(s) / expertise. */
  expertise?: string
  /** How you like to be worked with (tone, what to flag, language). */
  workingStyle?: string
  /** Vault nature (from the vault-nature classifier). Gates how notes inform identity:
   *  'study-reference' => subjects are MATERIAL, never asserted as who the owner is. */
  vaultKind?: 'self-work' | 'study-reference' | 'mixed' | 'unknown'
  /** Subject/domain labels safe to DESCRIBE as material. NEVER placed in Role/Who-I-am. */
  vaultTopics?: string[]
}

export interface IdentityFiles {
  /** Body for `<notesDir>/ME.md` — the operator identity, or '' when no signal. */
  meMd: string
  /** Body for `<notesDir>/BRAIN.md` — DUIN's operating contract. Always non-empty. */
  brainMd: string
}

function clean(s: string | undefined): string {
  return (s ?? '').trim()
}

/** Split a free-text answer into discrete lines (newlines / commas / semicolons). */
function bullets(text: string | undefined, max = 8): string[] {
  return clean(text)
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
}

/** True when the input carries enough to write a meaningful ME.md (identity or context). */
export function hasIdentitySignal(input: IdentityInput): boolean {
  return Boolean(
    clean(input.name) ||
      clean(input.role) ||
      clean(input.expertise) ||
      clean(input.workingStyle) ||
      clean(input.working) ||
      clean(input.deciding) ||
      clean(input.worried)
  )
}

function bulletBlock(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n')
}

/** Build ME.md — the operator identity + current context, from interview answers. */
function buildMe(input: IdentityInput, now: string): string {
  const name = clean(input.name)
  const role = clean(input.role)
  const expertise = clean(input.expertise)
  const style = clean(input.workingStyle)
  const working = bullets(input.working)
  const deciding = clean(input.deciding)
  const worried = bullets(input.worried)

  const heading = name ? `# ${name}` : '# The Operator'
  const parts: string[] = [
    '---',
    'type: identity',
    `generated: ${now}`,
    'generated-by: duin-onboarding',
    '---',
    '',
    heading,
    ''
  ]

  if (role) parts.push(role, '')

  const who: string[] = []
  if (role) who.push(`Role: ${role}`)
  if (expertise) who.push(`Works on: ${expertise}`)
  if (who.length) {
    parts.push('## Who I am', bulletBlock(who), '')
  }

  if (style) {
    parts.push('## How to work with me', style, '')
  }

  const context: string[] = []
  if (working.length) context.push(`**Working on:**\n${bulletBlock(working)}`)
  if (deciding) context.push(`**Deciding:** ${deciding}`)
  if (worried.length) context.push(`**Watching (might slip):**\n${bulletBlock(worried)}`)
  if (context.length) {
    parts.push("## What's on my plate now", context.join('\n\n'), '')
  }

  // Vault topics are DESCRIBED as material here — never as the owner's role/identity.
  // For a study vault this is the only note-derived content; identity stays interview-led.
  const topics = (input.vaultTopics ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 12)
  if (topics.length) {
    const label = input.vaultKind === 'study-reference' ? 'What my vault covers (study / reference material)' : 'What my vault covers'
    parts.push(`## ${label}`, bulletBlock(topics), '')
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** Build BRAIN.md — DUIN's operating contract for this owner. Always produced
 *  (grounding needs at least this), personalized by name/style when available. */
function buildBrain(input: IdentityInput): string {
  const name = clean(input.name)
  const style = clean(input.workingStyle)
  const owner = name ? `${name}'s` : 'your'
  const title = name ? `# BRAIN.md — ${name}'s DUIN` : '# BRAIN.md — Your DUIN'
  const study = input.vaultKind === 'study-reference'

  // The control, made behavioral: a study vault gets a learn/recall contract that
  // explicitly forbids treating the subject matter as the owner's own identity/work.
  const contract: string[] = study
    ? [
        '- This is a STUDY / REFERENCE vault: the notes are material the owner is learning, NOT facts about the owner.',
        '- Help the owner LEARN and RECALL: explain, quiz, connect concepts, surface gaps and what they haven\'t mastered.',
        '- Ground every answer in the vault and cite the note. NEVER assert the subject matter as the owner\'s own identity or work.',
        '- Flag uncertainty instead of guessing. Everything stays local and private.'
      ]
    : [
        '- Ground every answer in the vault + the operator identity (ME.md); prefer what you can cite.',
        '- Think ahead: surface what matters, owed decisions, and what might slip — don\'t wait to be asked.',
        '- Say what you actually found; flag uncertainty instead of guessing.',
        '- Everything stays local and private to this machine.'
      ]
  if (style) contract.push(`- Owner's working style: ${style}`)

  const intro = study
    ? `You are ${owner} study companion — you help the owner learn and recall the material in ${owner} notes, and track what they've mastered vs. still need.`
    : `You are ${owner} second brain — a grounded agent that reasons over ${owner} notes, thinks ahead, and learns the owner over time.`

  return ([title, '', intro, '', '## Operating contract', contract.join('\n'), ''].join('\n').trim() + '\n')
}

/**
 * Generate the vault-root foundation files from interview answers.
 * - `brainMd` is always non-empty (DUIN's contract works even with no identity signal).
 * - `meMd` is '' when there's no identity signal, so the caller can skip writing it.
 * `opts.now` is injected for deterministic output (tests) — pass a YYYY-MM-DD date.
 */
export function buildIdentityFiles(input: IdentityInput, opts?: { now?: string }): IdentityFiles {
  const now = clean(opts?.now) || new Date().toISOString().slice(0, 10)
  // Write ME.md when there's identity signal OR vault topics to describe (a study vault
  // with no interview still gets a "what my vault covers" ME.md — material, not identity).
  const wantMe = hasIdentitySignal(input) || (input.vaultTopics?.some((t) => t.trim()) ?? false)
  return {
    meMd: wantMe ? buildMe(input, now) : '',
    brainMd: buildBrain(input)
  }
}

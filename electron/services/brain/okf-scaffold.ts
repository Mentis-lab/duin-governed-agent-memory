// okf-scaffold — the first-run OKF substrate seeder (DUIN_MEMORY_OKF_DESIGN §4,
// Phase B). Given a fresh (or existing) vault dir it materializes a REAL typed
// concept skeleton so a brand-new user's first-run graph renders the typed
// concept skeleton — foundation concepts + typed pillar `_about` concepts —
// instead of a blank canvas ("I don't have anything in your brain yet").
//
// What it writes:
//   • Foundation concepts at the vault ROOT — ME.md / BRAIN.md (via write-identity,
//     no-clobber) + SOUL.md + GOALS.md — each a typed concept (`type: identity` /
//     `operating-instructions` / `soul` / `goals`).
//   • Typed pillar `_about` concepts into `<vault>/.brain/memory/_about-<pillar>.md`
//     — one per DUIN pillar, explaining what that pillar captures.
//   • The interview answers (optional) materialized as typed `.brain/memory`
//     concepts: each work item → `type: project`, the decision → `type: decision`,
//     each worry → `type: risk`. This is the redirect for the dead interview seed —
//     the answers now flow into the REAL substrate + graph, not a vestigial store.
//   • `_concept-index.md` (via concept-index.ts) — the machine-owned OKF concept map.
//
// Convention: one concept per markdown file under `.brain/memory/`, FLAT OKF
// frontmatter with the single required `type:` field (+ description/created).
// concept-index.ts reads that flat `type:` (or nested metadata.type) — see it for
// the index shape. Pure filesystem + electron-free, so it unit-tests on a temp dir.
//
// IDEMPOTENT + NO-CLOBBER: every write is skipped when the target already exists
// (unless `overwrite`), so a re-run never churns a user's hand-edited concept and
// re-pointing an existing vault is safe.
//
// SAFETY (the `overwrite: true` branch): that no-clobber contract used to hold for
// ME.md/BRAIN.md and NOT for the files this module writes itself. `writeIdentityFiles`
// below is gated on the very same `overwrite` flag and preserves before it replaces
// (snapshotToTrash → refuse the write if the snapshot fails → report the recovery path
// in `replaced`) — see write-identity.ts, whose header is the post-mortem for exactly
// this defect class. `putRoot`/`putConcept`, fifteen lines further down, read the same
// flag and did none of it: a bare writeFileSync dropped the 275-byte `defaultGoals`
// stub (`## Tracks\n*(—)*`) over an operator's hand-maintained GOALS.md — the file this
// module itself calls the one "the whole loop cascades from here" — with no snapshot, no
// tombstone, no diff, and reported it as a plain success in `wrote`. Nothing regenerates
// that content. Both writers now route through the same preserve-then-write-else-skip
// sequence, so the guard cannot drift apart from write-identity's again.
//
// SAFETY (the caller's side): `writeIdentityFiles` signals a REFUSED overwrite by
// returning ok:false ("the existing identity could not be preserved") — its deliberate
// safe-side signal that the live bytes could not be made recoverable. Scaffolding used to
// read only `idres.wrote`/`idres.skipped` and carry on writing, so the one halt signal the
// guard raises was discarded by the only caller that could act on it. We now abort. And
// `idres.replaced` is surfaced through this module's own result (and the IPC payload), so
// a correctly snapshotted file is actually recoverable in practice — a `.trash` copy no
// caller is ever told about is not recovery.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ensureBrainRoot, brainRootPath, BRAIN_MEMORY_DIR } from './brain-root'
import { writeIdentityFiles } from './write-identity'
import { generateConceptIndex } from './concept-index'
import { snapshotToTrash } from '../local-brain/vault-trash'
import { CJK_CLASS } from './cjk-tokens'

/** Interview answers (mirror of src/lib/brain-seed InterviewAnswers). All optional
 *  so a blank onboarding still yields the foundation + pillar skeleton. */
export interface OkfInterviewAnswers {
  working?: string
  deciding?: string
  worried?: string
}

export interface OkfScaffoldInput {
  /** The vault dir — the substrate root (`.brain/` is created under it). */
  vaultDir: string
  /** Optional interview answers → typed project/decision/risk concepts. */
  answers?: OkfInterviewAnswers
  /** Optional ME.md body (else a typed default). */
  meMd?: string
  /** Optional BRAIN.md body (else a typed default). */
  brainMd?: string
  /** Stamp for generated files (deterministic/testable). Default: today. */
  today?: string
  /** Overwrite existing concepts. Default false (no-clobber). */
  overwrite?: boolean
}

export interface OkfScaffoldResult {
  ok: boolean
  /** Concept files (foundation + pillar + interview) actually written this call. */
  conceptsWritten: number
  /** Absolute path of the generated `_concept-index.md`, or null. */
  indexPath: string | null
  /** Total concepts the index enumerated (existing + new). */
  conceptsIndexed: number
  /** Filenames written this call (relative-ish labels). */
  wrote: string[]
  /** Filenames skipped because they already existed (no-clobber), or because the prior
   *  content could not be preserved before an `overwrite` (an untraceable replacement is
   *  refused rather than performed). */
  skipped: string[]
  /** For each file whose prior content was REPLACED, where that prior content was preserved
   *  (a `.trash` path relative to `vaultDir`). Includes the identity files write-identity
   *  replaced. Without this the snapshot exists but nobody is ever told the recovery path. */
  replaced?: Record<string, string>
  error?: string
}

/** Split a free-text answer into discrete items (newlines, commas, semicolons). */
function items(text: string | undefined, max = 6): string[] {
  return (text ?? '')
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
}

/** Widened to the tokenizer's full CJK class (kanji + KANA): a pure-kana concept name
 *  otherwise cleaned to '' and every such concept landed on the same 'concept' filename. */
const SLUG_STRIP_RE = new RegExp(`[^a-z0-9${CJK_CLASS}]+`, 'g')

/** Filesystem-safe slug for a concept filename. */
function slug(name: string, max = 60): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(SLUG_STRIP_RE, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleaned) return 'concept'
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).replace(/-+$/, '')
}

/** Double-quote a YAML scalar so embedded colons/`#`/quotes can't break the
 *  frontmatter (interview text like "Active work: Ship v1" carries colons). */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Serialize a FLAT-`type:` OKF concept markdown (the convention concept-index reads). */
function serializeConcept(fields: {
  type: string
  title: string
  description: string
  created: string
  body: string
}): string {
  const title = fields.title.replace(/\n/g, ' ').slice(0, 120)
  const description = fields.description.replace(/\n/g, ' ').slice(0, 200)
  return (
    `---\n` +
    `type: ${yamlStr(fields.type)}\n` +
    `title: ${yamlStr(title)}\n` +
    `description: ${yamlStr(description)}\n` +
    `created: ${fields.created}\n` +
    `generated: true\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `${fields.body.trim()}\n`
  )
}

// The DUIN pillars, each with its typed `_about` concept. `type` is the concept's
// OKF type so the concept-index groups them; the body explains what the pillar
// captures (so the first-run graph carries a legible, typed skeleton).
const PILLARS: { key: string; type: string; title: string; desc: string; body: string }[] = [
  { key: 'knowledge', type: 'knowledge', title: 'About — Knowledge', desc: 'Atomic, permanent insights you would reuse.', body: 'One claim per note: Claim · Evidence · Mechanism · Application. Cite a source. This is where durable, reusable knowledge accretes.' },
  { key: 'decisions', type: 'decision', title: 'About — Decisions', desc: 'Calls you have made or are weighing, with their reasoning.', body: 'Each decision records the choice, the reasoning, and what would change your mind. Open decisions surface as gates in the graph.' },
  { key: 'people', type: 'person', title: 'About — People', desc: 'The people and organizations you work with.', body: 'One note per person/org: role, context, and what you owe each other. Entities link into the graph as you engage.' },
  { key: 'planning', type: 'planning', title: 'About — Planning', desc: 'Goals cascaded to 12-week, weekly, and daily horizons.', body: 'The alignment spine: goals → 12-week → weekly → daily. Daily notes and reviews live here.' },
  { key: 'active', type: 'active', title: 'About — Active Work', desc: 'Live workstream logs, in flight right now.', body: 'What you are actively doing. Active streams feed Tasks and roll up to your goals.' },
  { key: 'tasks', type: 'task', title: 'About — Tasks', desc: 'Concrete next actions, tracked to done.', body: 'Actionable items: `- [ ] task #tag (date)`. Kept small and honest — no fabricated done-stamps.' },
  { key: 'instincts', type: 'instinct', title: 'About — Instincts', desc: 'Reflexes and heuristics you have earned.', body: 'Hard-won reflexes. A correction cluster that recurs becomes a proposed rule.' },
  { key: 'inbox', type: 'inbox', title: 'About — Inbox', desc: 'Raw, unfiled captures awaiting routing.', body: 'The landing zone for raw input before it is distilled into a pillar.' }
]

/** Default typed ME.md / BRAIN.md bodies (used when the caller provides none) so a
 *  truly blank onboarding still gets a typed foundation. */
function defaultMe(today: string): string {
  return (
    `---\ntype: identity\ndescription: "Who this operator is — first read each session"\nload-policy: always-on\nlast-updated: ${today}\n---\n\n` +
    `# Me\n\n## Quick Bio\n*(Tell DUIN who you are — declared in onboarding.)*\n\n## How to Work With Me\n*(Communication style, decision-making, tone, hard lines.)*\n\n## Confidential Lanes\n*(Workstreams that must stay isolated. DUIN asks this first; it gates everything.)*\n`
  )
}
function defaultBrain(today: string): string {
  return (
    `---\ntype: operating-instructions\ndescription: "The brain's operating contract — every agent and model loads this first"\nload-policy: always-on\nlast-updated: ${today}\n---\n\n` +
    `# BRAIN — Operating Contract\n\n@ME.md\n\n## Role & Tone\nStrategic partner. Conclusion-first, high-density, no fluff. Propose — never act silently.\n\n## Hard Rules\n- Propose, don't act on the user's own files. \`(C) \` marks AI-generated. No fabricated done-stamps.\n`
  )
}
/** Default SOUL.md — DUIN's character, as distinct from BRAIN.md's rules.
 *
 *  The split is load-bearing, not decorative: BRAIN.md is imperative and gets
 *  followed literally, so it only covers situations someone anticipated. SOUL.md
 *  is declarative — it is what DUIN falls back on when no rule applies, which is
 *  most of the time. Written as a real starting character rather than a blank
 *  template, because an empty identity file trains an agent to have no voice at
 *  all; the operator edits it toward themselves from there. */
function defaultSoul(today: string): string {
  return (
    `---\ntype: soul\ndescription: "Who DUIN is — character and voice, loaded before the rules that constrain it"\nload-policy: always-on\nlast-updated: ${today}\n---\n\n` +
    `# SOUL — Who I Am\n\n` +
    `I am DUIN. I am one operator's second brain, not a general assistant, and the difference is the point: I get better at *this* person's judgment, not at everyone's.\n\n` +
    `## Character\n\n` +
    `- **I would rather be useful than agreeable.** If I think you are wrong, I say so plainly and early, with my reasoning. Agreement I did not mean is a small lie that costs you a real decision.\n` +
    `- **I say what I actually know.** I distinguish what I read from what I inferred from what I am guessing, every time. Confident vagueness is the failure mode I most want to avoid.\n` +
    `- **I lead with the conclusion.** You are busy. The answer comes first; the reasoning is available underneath for when you want it.\n` +
    `- **I hold the thread.** I remember what we decided and why, and I notice when today contradicts last month. Continuity is most of what makes me worth having.\n` +
    `- **I propose; you decide.** I do not quietly act on your files, your relationships, or your commitments. Reversible work I get on with; consequential work I put in front of you first.\n\n` +
    `## Voice\n\n` +
    `Direct, specific, unhurried. Plain words over jargon, complete sentences over fragments. No filler enthusiasm, no apology loops — when I get something wrong I say what broke, fix it, and move on.\n\n` +
    `## What I Will Not Do\n\n` +
    `- Fabricate a source, a number, or a completed action.\n` +
    `- Flatter you into a worse decision.\n` +
    `- Carry information across a confidential lane you have drawn.\n\n` +
    `---\n*Edit this freely — it is the first thing I read about myself. Rules and hard constraints belong in BRAIN.md; this file is character.*\n`
  )
}
function defaultGoals(today: string): string {
  return (
    `---\ntype: goals\ndescription: "Strategic tracks + current cycle — top of the closed loop"\nlast-updated: ${today}\n---\n\n` +
    `# Goals\n\n> The whole loop cascades from here. Confirm/edit as your objectives firm up.\n\n## Current Cycle\n- Window: ${today} -> +12 weeks\n\n## Tracks\n*(—)*\n`
  )
}

/**
 * Backfill SOUL.md into an ALREADY-onboarded vault.
 *
 * `scaffoldOkf` only ever runs on the folder-pick / onboarding path, so every
 * vault that was adopted before SOUL.md existed would never receive one — the
 * file would ship to new users only and be permanently absent for existing
 * ones, which is the "built but default-off" failure mode. This runs at boot.
 *
 * STRICTLY create-if-missing: it writes only when the file does not exist, so
 * it can never clobber an operator's edited SOUL.md and needs no snapshot path.
 * Also no-ops on a vault with no BRAIN.md — that is an unadopted or non-DUIN
 * directory, and seeding character files into it would be litter.
 */
export function ensureFoundationSoul(vaultDir: string | null | undefined, today?: string): { created: boolean; error?: string } {
  const dir = typeof vaultDir === 'string' ? vaultDir.trim() : ''
  if (!dir || !existsSync(dir)) return { created: false }
  if (!existsSync(join(dir, 'BRAIN.md'))) return { created: false }
  const full = join(dir, 'SOUL.md')
  if (existsSync(full)) return { created: false }
  try {
    writeFileSync(full, defaultSoul((today ?? '').trim() || new Date().toISOString().slice(0, 10)), 'utf-8')
    return { created: true }
  } catch (err) {
    return { created: false, error: (err as Error)?.message ?? 'write failed' }
  }
}

/**
 * Seed the OKF substrate for `vaultDir`. Idempotent + no-clobber. Returns the
 * count of concept files written this call + the generated index path.
 */
export function scaffoldOkf(input: OkfScaffoldInput): OkfScaffoldResult {
  const vaultDir = typeof input.vaultDir === 'string' ? input.vaultDir.trim() : ''
  const today = (input.today ?? '').trim() || new Date().toISOString().slice(0, 10)
  const overwrite = input.overwrite === true
  const wrote: string[] = []
  const skipped: string[] = []
  const replaced: Record<string, string> = {}
  const unpreserved: string[] = []

  if (!vaultDir) return { ok: false, conceptsWritten: 0, indexPath: null, conceptsIndexed: 0, wrote, skipped, error: 'vaultDir is required' }
  if (!existsSync(vaultDir)) return { ok: false, conceptsWritten: 0, indexPath: null, conceptsIndexed: 0, wrote, skipped, error: `vaultDir not found: ${vaultDir}` }

  /** Preserve the live bytes of `full` before they are replaced. Returns false when the
   *  snapshot failed — the caller's safe side is then to SKIP the destructive write
   *  (vault-trash: proceeding blind is the one outcome that cannot be undone). */
  const preserve = (full: string, label: string, body: string): boolean => {
    let prior: string | null = null
    try {
      prior = readFileSync(full, 'utf-8')
    } catch {
      // Unreadable prior content is exactly the case worth preserving — snapshot anyway.
    }
    if (prior === body) return true // byte-identical rewrite destroys nothing
    const snap = snapshotToTrash(vaultDir, full, 'okf-scaffold', `okf scaffold replaced ${label}`)
    if (!snap.ok) {
      unpreserved.push(`${label}: ${snap.error}`)
      skipped.push(label)
      return false
    }
    if (snap.trashRel) replaced[label] = snap.trashRel
    return true
  }

  try {
    // 1. Foundation concepts at vault root (ME / BRAIN via write-identity, no-clobber;
    //    this also scaffolds the .brain/ root). GOALS written directly (write-identity
    //    handles only ME/BRAIN). Empty body → write-identity skips it, so fall back to
    //    a typed default so the skeleton is never missing its foundation.
    const idres = writeIdentityFiles({
      notesDir: vaultDir,
      meMd: (input.meMd ?? '').trim() || defaultMe(today),
      brainMd: (input.brainMd ?? '').trim() || defaultBrain(today),
      overwrite
    })
    wrote.push(...idres.wrote)
    skipped.push(...idres.skipped)
    Object.assign(replaced, idres.replaced ?? {})
    // A refused identity overwrite means an existing file could NOT be made recoverable.
    // That is the guard's halt signal, not a detail: if this vault's bytes can't reach
    // .trash we must not go on to replace GOALS.md and the concepts either.
    if (!idres.ok) {
      return { ok: false, conceptsWritten: 0, indexPath: null, conceptsIndexed: 0, wrote, skipped, ...(Object.keys(replaced).length ? { replaced } : {}), error: idres.error ?? 'identity foundation could not be written' }
    }

    const putRoot = (name: string, body: string): void => {
      const full = join(vaultDir, name)
      if (existsSync(full)) {
        if (!overwrite) {
          skipped.push(name)
          return
        }
        // Overwrite was authorized — but authorization is not preservation.
        if (!preserve(full, name, body)) return
      }
      writeFileSync(full, body, 'utf-8')
      wrote.push(name)
    }
    putRoot('SOUL.md', defaultSoul(today))
    putRoot('GOALS.md', defaultGoals(today))

    // Ensure the .brain/ root (+ memory/) exists — idempotent.
    ensureBrainRoot(vaultDir)
    const root = brainRootPath(vaultDir)
    const memoryDir = root ? join(root, BRAIN_MEMORY_DIR) : join(vaultDir, '.brain', 'memory')
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })

    let conceptsWritten = 0
    const putConcept = (fileslug: string, md: string): void => {
      const full = join(memoryDir, `${fileslug}.md`)
      const label = `.brain/memory/${fileslug}.md`
      if (existsSync(full)) {
        if (!overwrite) {
          skipped.push(label)
          return
        }
        if (!preserve(full, label, md)) return
      }
      writeFileSync(full, md, 'utf-8')
      wrote.push(label)
      conceptsWritten++
    }

    // 2. Typed pillar `_about` concepts.
    for (const p of PILLARS) {
      putConcept(
        `_about-${p.key}`,
        serializeConcept({ type: p.type, title: p.title, description: p.desc, created: today, body: p.body })
      )
    }

    // 3. Interview answers → typed concepts (work→project, decision→decision,
    //    worry→risk). This is the redirect for the dead interview seed.
    const a = input.answers ?? {}
    items(a.working).forEach((label) => {
      putConcept(
        `work-${slug(label)}`,
        serializeConcept({ type: 'project', title: label, description: `Active work: ${label}`, created: today, body: `An active workstream you named during onboarding.\n\n*(DUIN enriches this as you engage.)*` })
      )
    })
    const decision = (a.deciding ?? '').trim()
    if (decision) {
      putConcept(
        `decision-${slug(decision)}`,
        serializeConcept({ type: 'decision', title: decision, description: `A decision you are weighing: ${decision}`, created: today, body: `A call you flagged during onboarding. Record the options, reasoning, and what would change your mind.` })
      )
    }
    items(a.worried).forEach((label) => {
      putConcept(
        `risk-${slug(label)}`,
        serializeConcept({ type: 'risk', title: label, description: `A risk you flagged: ${label}`, created: today, body: `Something you worried might slip. DUIN watches it and surfaces it as it nears.` })
      )
    })

    // 4. Regenerate the machine-owned concept index over the bundle.
    const index = generateConceptIndex(memoryDir, 'memory', today)

    return {
      ok: unpreserved.length === 0,
      conceptsWritten,
      indexPath: index?.indexPath ?? null,
      conceptsIndexed: index?.concepts ?? 0,
      wrote,
      skipped,
      ...(Object.keys(replaced).length ? { replaced } : {}),
      // A refused overwrite is a real failure to report, not a silent skip: the caller asked
      // for these to supersede and they did not, because the existing content could not be
      // made recoverable.
      ...(unpreserved.length ? { error: `existing content could not be preserved: ${unpreserved.join('; ')}` } : {})
    }
  } catch (err) {
    return { ok: false, conceptsWritten: 0, indexPath: null, conceptsIndexed: 0, wrote, skipped, ...(Object.keys(replaced).length ? { replaced } : {}), error: (err as Error)?.message ?? 'scaffold failed' }
  }
}

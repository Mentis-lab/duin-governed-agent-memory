// The `.brain/` harness root — DUIN's persistent, per-vault identity + memory +
// behavior root.
//
// It lives at `<localBrainNotesDir>/.brain/` so it travels WITH the user's
// notes vault (sync it, version it, move it — the brain moves too). Unlike the
// in-process engines (which derive everything from the indexed notes each
// boot), the `.brain/` root is durable, hand-editable identity + memory the
// user (or an imported agent system) owns:
//
//   .brain/
//     identity.md            ← who the owner is
//     memory/                ← what DUIN has learned about them (md files)
//       MEMORY.md            ← optional index over the memory dir
//       *.md
//     skills/                ← imported skill bundles
//     agents/                ← imported sub-agent definitions
//     hooks/                 ← imported hook scripts + a manifest
//     config.json            ← root config, incl. linked-source pointers
//     state/                 ← derived caches (e.g. brain-construction.json)
//
// This module is electron-free + PURE-ish (filesystem only, no app singletons)
// so it unit-tests without main-process mocks. The loader concatenates
// identity + memory into a single grounding block fed into every chat turn
// (see local-brain/server.ts buildGroundedMessages) — that is the whole point:
// every answer is grounded in WHO the user is, not just their notes.

import { mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { isDirSafe, readSafe } from '../fs-tree'
import { IDENTITY_FOUNDATION_ORDER } from './foundation-files'

/** Directory + file names that make up the `.brain/` contract. */
export const BRAIN_DIRNAME = '.brain'
export const BRAIN_IDENTITY_FILE = 'identity.md'
export const BRAIN_MEMORY_DIR = 'memory'
export const BRAIN_MEMORY_INDEX = 'MEMORY.md'
export const BRAIN_SKILLS_DIR = 'skills'
export const BRAIN_AGENTS_DIR = 'agents'
export const BRAIN_HOOKS_DIR = 'hooks'
export const BRAIN_STATE_DIR = 'state'
export const BRAIN_CONFIG_FILE = 'config.json'

/** Character cap on the MEMORY block ONLY; identity is intentionally UNCAPPED.
 *
 *  This docblock used to say "the concatenated identity+memory grounding block",
 *  which was a guarantee the code never made: `loadBrain` budgets `all` (the
 *  memory bodies) and returns `identity` — SOUL.md + BRAIN.md + ME.md, or the
 *  legacy `.brain/identity.md` — at whatever length it was authored, on every
 *  path. `agui-grounding` then places the whole block in the compiler's 'floor'
 *  tier, which is exempt from budget compression, so nothing downstream bounds
 *  it either. A stated-but-unimplemented bound is worse than an honest absence
 *  of one, because the next reader budgets against it.
 *
 *  Uncapped identity is the DELIBERATE product decision, not an oversight: the
 *  foundation files are hand-authored by the operator and are the answer to
 *  "who are you / who am I", so silently truncating them would cut the one block
 *  the system promises is authoritative — and the operator, who writes them, is
 *  the party who controls their size. Memory is different: it ACCRUES without
 *  anyone deciding to grow it, which is why it is the half that gets a budget.
 *
 *  So: generous enough for a page of memories, bounded so a pathological memory
 *  dir can't blow the system prompt. Biggest MEMORY files trim first. The scope
 *  of this constant is pinned by brain-root-cap-scope.test.ts — if identity ever
 *  does get a budget, that test fails and this docblock must move with it. */
export const BRAIN_GROUNDING_CHAR_CAP = 6000

/** A linked (not copied) source an imported agent system points at. In 'link'
 *  mode the importer writes these instead of snapshotting files, and the loader
 *  reads identity/memory from them LIVE so edits in the original source dir
 *  flow through without a re-import. */
export interface LinkedSource {
  /** Adapter id that produced this link (e.g. 'codex'). */
  adapter: string
  /** Absolute path to the linked source dir. */
  dir: string
}

/** Shape of `.brain/config.json`. Open by design — adapters may stamp extra
 *  keys — but `linkedSources` is the one the loader honors. */
export interface BrainConfig {
  linkedSources?: LinkedSource[]
  [key: string]: unknown
}

/** Resolve the `.brain/` root for a notes dir, or null when no notes dir. */
export function brainRootPath(notesDir: string | null | undefined): string | null {
  const dir = typeof notesDir === 'string' ? notesDir.trim() : ''
  if (!dir) return null
  return join(dir, BRAIN_DIRNAME)
}

/**
 * Create the `.brain/` directory + empty scaffolding under `notesDir` if
 * absent. No-op (returns null) when `notesDir` is empty. Idempotent: existing
 * dirs/files are left untouched. Returns the resolved `.brain/` root path.
 */
export function ensureBrainRoot(notesDir: string | null | undefined): string | null {
  const root = brainRootPath(notesDir)
  if (!root) return null
  try {
    mkdirSync(root, { recursive: true })
    for (const sub of [
      BRAIN_MEMORY_DIR,
      BRAIN_SKILLS_DIR,
      BRAIN_AGENTS_DIR,
      BRAIN_HOOKS_DIR,
      BRAIN_STATE_DIR
    ]) {
      mkdirSync(join(root, sub), { recursive: true })
    }
  } catch (err) {
    console.warn('[brain-root] ensureBrainRoot failed:', (err as Error)?.message)
    return null
  }
  return root
}

/** Recursively collect `*.md` files under a dir as {path, size}, skipping the
 *  MEMORY.md index (handled separately) and unreadable entries. */
function collectMarkdown(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = []
  if (!isDirSafe(dir)) return out
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(d, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile() && name.toLowerCase().endsWith('.md')) {
        out.push({ path: full, size: st.size })
      }
    }
  }
  walk(dir)
  return out
}

/** Result of loading a `.brain/` root for grounding. */
export interface LoadedBrain {
  /** Concatenated identity.md content (own + linked sources). '' if none. */
  identity: string
  /** Memory file bodies (MEMORY.md index first, then md files), capped. */
  memory: string[]
  /** Absolute `.brain/` root path. */
  root: string
  /** Absolute paths of the files whose content is IN `identity`, in order.
   *  Exists so a second consumer can tell it is about to ship the same file
   *  twice — see readAgentsMd / chat.ts, where BRAIN.md reached the prompt once
   *  here and again verbatim as <agents_md>. Empty when identity is ''. */
  identityFiles: string[]
}

/** Read config.json from a `.brain/` root, tolerant of corruption/absence. */
function readConfig(root: string): BrainConfig {
  const raw = readSafe(join(root, BRAIN_CONFIG_FILE))
  if (!raw.trim()) return {}
  try {
    const obj = JSON.parse(raw) as BrainConfig
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/**
 * Gather identity + memory from a single source dir laid out like a `.brain/`
 * root (or a linked source dir, which also has identity.md + memory/ after
 * import-time mapping). Internal helper for loadBrain.
 *
 * `identityNames` lets a linked source provide its native identity filenames
 * (e.g. AGENTS.md) in priority order; the first that exists wins.
 */
function gatherFrom(
  dir: string,
  identityNames: string[]
): {
  identity: string
  identityPath: string | null
  memory: { path: string; size: number; body: string }[]
} {
  let identity = ''
  let identityPath: string | null = null
  for (const name of identityNames) {
    const p = join(dir, name)
    const body = readSafe(p)
    if (body.trim()) {
      identity = body.trim()
      identityPath = p
      break
    }
  }
  const memoryDir = join(dir, BRAIN_MEMORY_DIR)
  const memory: { path: string; size: number; body: string }[] = []
  // MEMORY.md index first (the curated overview), then the individual files.
  const indexBody = readSafe(join(memoryDir, BRAIN_MEMORY_INDEX))
  if (indexBody.trim()) {
    memory.push({ path: join(memoryDir, BRAIN_MEMORY_INDEX), size: indexBody.length, body: indexBody.trim() })
  }
  for (const f of collectMarkdown(memoryDir)) {
    if (f.path.toLowerCase().endsWith(BRAIN_MEMORY_INDEX.toLowerCase())) continue
    const body = readSafe(f.path)
    if (!body.trim()) continue
    // Seam concepts (`type: learned`, one per promoted fact) ground via SEMANTIC RETRIEVAL,
    // not this always-on body-dump — otherwise dozens of them crowd the char budget and evict
    // the curated MEMORY.md index (biggest-first trim). Skip them here; retrieval surfaces them.
    if (/^---[\s\S]*?\btype:\s*learned\b[\s\S]*?\n---/.test(body)) continue
    // T2 seam projections (entity files) are typed by REAL kind (person/org/project), not
    // `learned` — exclude them by their generator key instead, or dozens of entity files eat
    // this cap too. Scaffold pillars carry `generated: true` but NOT this key: they still ground.
    if (/^---[\s\S]*?\bgenerated-by:\s*duin-seam\b[\s\S]*?\n---/.test(body)) continue
    memory.push({ path: f.path, size: f.size, body: body.trim() })
  }
  return { identity, identityPath, memory }
}

/**
 * Load the `.brain/` root for grounding: concatenate `identity.md` + all
 * `memory/**\/*.md` (own root first, then any LINKED sources read LIVE). The
 * memory list is capped at BRAIN_GROUNDING_CHAR_CAP total chars, trimming the
 * BIGGEST files first so a single huge memory can't crowd out the rest (the
 * index + smaller, denser memories survive). `identity` is NOT capped — see the
 * BRAIN_GROUNDING_CHAR_CAP docblock for why that asymmetry is deliberate.
 *
 * Returns null when there's no `.brain/` root or it's effectively empty (no
 * identity AND no memory) — callers then behave exactly as before.
 */
export function loadBrain(notesDir: string | null | undefined): LoadedBrain | null {
  const dir = typeof notesDir === 'string' && notesDir ? notesDir : null
  if (!dir) return null

  // ── ROOT FOUNDATION FILES (canonical identity, post-migration) ──
  // SOUL.md (who DUIN *is* — character and voice) + BRAIN.md (the operating
  // contract — what it must and must not do) + ME.md (the operator) are the
  // hand-maintained source of truth and SUPERSEDE the often-empty
  // .brain/identity.md. Read them directly + first so identity questions
  // ("what/who are you") ground on the foundation BEFORE any semantically-
  // retrieved note. MEMORY.md (root) joins the memory block.
  //
  // SOUL leads deliberately. BRAIN.md is imperative and gets followed literally;
  // SOUL.md is declarative and generalizes to situations no rule anticipated —
  // so character is established before the rules that constrain it. Absent
  // SOUL.md (every vault predating it) this loop is byte-identical to before.
  const foundationParts: string[] = []
  const identityFiles: string[] = []
  for (const name of IDENTITY_FOUNDATION_ORDER) {
    const p = join(dir, name)
    const body = readSafe(p)
    if (body.trim()) {
      foundationParts.push(`### ${name}\n${body.trim()}`)
      identityFiles.push(p)
      if (name === 'ME.md' || name === 'me.md') break // one operator file is enough
    }
  }
  let identity = foundationParts.join('\n\n')
  const all: { path: string; size: number; body: string }[] = []
  const rootMemory = readSafe(join(dir, 'MEMORY.md'))
  if (rootMemory.trim()) {
    all.push({ path: join(dir, 'MEMORY.md'), size: rootMemory.length, body: rootMemory.trim() })
  }

  // ── .brain/ harness root (legacy/optional: identity.md + memory/) ──
  // Only fills gaps the root foundation didn't cover, so an existing .brain/
  // still works while the root files take precedence.
  const root = brainRootPath(dir)
  if (root && isDirSafe(root)) {
    const own = gatherFrom(root, [BRAIN_IDENTITY_FILE])
    if (!identity && own.identity) {
      identity = own.identity
      if (own.identityPath) identityFiles.push(own.identityPath)
    }
    all.push(...own.memory)

    // Linked sources (link-mode imports) — read identity/memory LIVE so the user
    // editing their original source files flows through with no re-import.
    const config = readConfig(root)
    for (const link of config.linkedSources ?? []) {
      if (!link || typeof link.dir !== 'string' || !isDirSafe(link.dir)) continue
      const linked = gatherFrom(link.dir, [BRAIN_IDENTITY_FILE, 'AGENTS.md'])
      if (!identity && linked.identity) {
        identity = linked.identity
        if (linked.identityPath) identityFiles.push(linked.identityPath)
      }
      all.push(...linked.memory)
    }
  }

  if (!identity && all.length === 0) return null

  // Cap memory by total chars, biggest-first trim. Sort descending by size,
  // drop from the top until under cap, then restore document order is NOT
  // required for a system block — but keep the index (smallest-priority) by
  // sorting ascending so smaller/denser files are kept preferentially.
  let memory = all.map((m) => m.body)
  const totalChars = memory.reduce((n, s) => n + s.length, 0)
  if (totalChars > BRAIN_GROUNDING_CHAR_CAP) {
    // Keep smaller files first (denser signal), drop the biggest until under cap.
    const sorted = [...all].sort((a, b) => a.body.length - b.body.length)
    const kept: string[] = []
    let budget = BRAIN_GROUNDING_CHAR_CAP
    for (const m of sorted) {
      if (m.body.length <= budget) {
        kept.push(m.body)
        budget -= m.body.length
      }
    }
    memory = kept
  }

  return { identity, memory, root: root ?? join(dir, BRAIN_DIRNAME), identityFiles }
}

/**
 * Build the concise "ABOUT THE OWNER" grounding block from a loaded brain,
 * prepended to the chat system prompt BEFORE the notes CONTEXT. Returns '' when
 * the brain is null/empty so the caller can skip the block entirely.
 */
export function buildBrainGroundingBlock(loaded: LoadedBrain | null): string {
  if (!loaded) return ''
  const parts: string[] = []
  if (loaded.identity) parts.push(loaded.identity)
  if (loaded.memory.length > 0) parts.push(loaded.memory.join('\n\n'))
  const body = parts.join('\n\n').trim()
  if (!body) return ''
  return (
    'WHO YOU ARE + WHO THE OWNER IS (from the vault\'s foundation files — SOUL.md is ' +
    'your character and voice, BRAIN.md is your operating contract, ME.md is the ' +
    'operator, plus what you\'ve learned). ' +
    'This is AUTHORITATIVE durable context for every answer — and it is where you should ' +
    'ground questions about yourself, your configuration, or the owner, NOT a retrieved note:\n' +
    body +
    // P6 discoverability pointer (ONE muted line): the descriptive decision-style mirror is a
    // fetchable route, not injected here (no histogram nagging). Cold start is byte-identical —
    // this only appends inside the non-empty branch.
    '\n\n(If the owner asks how they *actually* decide — their real decision patterns, or where ' +
    'their stated preferences differ from their record — the descriptive style fingerprint is ' +
    'available at /state/style-fingerprint on the local brain. A mirror, not a grader; it stays ' +
    'silent until there is enough logged data.)'
  )
}

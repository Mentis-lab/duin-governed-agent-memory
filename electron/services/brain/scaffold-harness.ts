// scaffold-harness.ts — port of scaffold2.mjs into DUIN as a real feature.
//
// Walks a notes folder, auto-files every note by inferred KIND into a
// newcomer-friendly OKF folder layout, adds OKF frontmatter, runs two LLM
// passes (tracks+bio · entities) to RICHLY seed the harness, and writes the
// foundation files (me/BRAIN/GOALS/vault-map/index/MEMORY) + starter Rules +
// a DIAGNOSIS.md.
//
// DEFENSIVE: never throws out — every failure path returns { ok:false, error }.
// The LLM passes use the app's provider layer (chatOnce + routeModel) so the
// scaffold uses WHATEVER model the user already configured (BYO key or local
// Ollama); with no model both passes degrade gracefully to heuristics.

import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'fs'
import { join, relative, basename, extname, resolve, dirname } from 'path'
import { chatOnce, routeModel } from '../providers/registry'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { messageOf } from '../guarded'
import { FOUNDATION_FILES } from './foundation-files'

/** What actually happened to one foundation file at the output root.
 *  - `written`  — no operator content was at risk (absent target, our own prior output, or identical bytes).
 *  - `altered`  — operator content WAS replaced, and is preserved in 00 Inbox + the alteration ledger.
 *  - `skipped`  — nothing was written, because the prior content could not be preserved or recorded.
 *  Only `written`/`altered` mean the file at the root is now OURS. `skipped` means the operator's
 *  own bytes are still sitting there, untouched and unpreserved. */
export type FoundationOutcome = 'written' | 'altered' | 'skipped'

export interface ScaffoldResult {
  ok: boolean
  counts: Record<string, number>
  tracks: string[]
  diagnosisPath: string
  /** Per-foundation-file outcome, keyed by root-relative name ('ME.md', 'BRAIN.md', …).
   *  `ok: true` says the PASS completed; it says nothing about any individual file — a write can
   *  be refused (unpreservable prior) or fail (swallowed) and the pass still reports ok. A caller
   *  deciding whether it may overwrite one of these files must consult THIS map, never `ok`. */
  foundation: Record<string, FoundationOutcome>
  error?: string
}

// Cross-cutting pillars live under DUIN/ — peers to the arena spaces (which
// are top-level folders named after the user's OWN domains, discovered at runtime).
const F = {
  inbox: 'DUIN/00 Inbox',
  knowledge: 'DUIN/Knowledge',
  instincts: 'DUIN/Instincts',
  people: 'DUIN/People',
  orgs: 'DUIN/People/Orgs',
  projects: 'DUIN/Knowledge', // legacy key; arena notes go to their arena, not here
  decisions: 'DUIN/Decisions',
  planning: 'DUIN/Planning',
  tasks: 'DUIN/Tasks',
  active: 'DUIN/Active',
  rules: 'DUIN/Rules',
  templates: 'DUIN/Templates',
  meta: 'DUIN/Meta',
  identity: 'DUIN/Identity'
} as const

// Folder/tag names that are NEVER an arena (generic pillars / structure), so arena
// discovery doesn't mistake a pillar folder for a topic space.
const GENERIC_ARENA_NAMES = new Set(
  [
    'knowledge', 'notes', 'cards', 'inbox', 'tasks', 'planning', 'decisions',
    'people', 'rules', 'templates', 'instincts', 'active', 'archive', '_archive',
    'attachments', 'daily', 'weekly', 'meta', 'identity', 'scholar', 'private',
    '_inbox', 'templates', '00 raw', '01 wiki', '02 cards', '03 projects',
    '04 notes', '05 decisions', '06 tasks', '07 templates', '08 agents',
    '09 rules', '10 action', 'concept', 'knowledge-base', 'test', 'misc', 'untitled'
  ].map((s) => s.toLowerCase())
)

interface PlacedNote {
  abs: string // absolute path of the ORIGINAL note on disk (for in-place move)
  rel: string
  name: string
  fm: Record<string, string>
  body: string
  c: { dest: string; kind: string }
  title: string
}

/** Extract the first balanced {...} JSON object from arbitrary model text. */
function firstJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{')
  if (s < 0) return null
  let d = 0
  for (let i = s; i < text.length; i++) {
    if (text[i] === '{') d++
    else if (text[i] === '}') {
      d--
      if (d === 0) {
        try {
          return JSON.parse(text.slice(s, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** One LLM pass via the app's provider layer. Returns '' on no-model / any error. */
async function ask(prompt: string): Promise<string> {
  try {
    const model = routeModel('extraction')
    if (!model) return ''
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]
    const res = await chatOnce(messages, model, undefined, {
      purpose: 'other',
      role: 'scaffold-harness'
    })
    return res?.content ?? ''
  } catch (e) {
    console.warn('[scaffold] LLM ask failed:', (e as Error)?.message)
    return ''
  }
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const n of entries) {
    if (n.startsWith('.') || n === 'node_modules') continue
    const p = join(dir, n)
    try {
      if (statSync(p).isDirectory()) walk(p, acc)
      else acc.push(p)
    } catch {
      // unreadable entry — skip
    }
  }
  return acc
}

function parseFm(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (mm) fm[mm[1].toLowerCase()] = mm[2].replace(/^["']|["']$/g, '').trim()
  }
  return { fm, body: m[2] }
}

function firstHeading(body: string): string {
  const m = /^#\s+(.+)$/m.exec(body) || /^([^\n#].{3,80})$/m.exec(body)
  return m ? m[1].trim() : ''
}

/** A note's candidate ARENA (the user's own topic/domain), from its top folder
 * segment or its project/track/domain frontmatter — or null if none. Generic
 * pillar names are never arenas. */
function arenaCandidateOf(rel: string, fm: Record<string, string>): string | null {
  const segs = rel.split(/[\\/]/).filter(Boolean)
  // top folder segment (skip a leading numbered/generic pillar like "01 Wiki")
  for (const seg of segs.slice(0, -1)) {
    const s = seg.trim()
    if (!s) continue
    if (GENERIC_ARENA_NAMES.has(s.toLowerCase())) continue
    if (/^\d{2}\s/.test(s)) continue // "01 Wiki" style pillar prefix
    return s
  }
  // frontmatter project/track/domain
  for (const key of ['project', 'track', 'domain']) {
    const raw = (fm[key] || '').replace(/\[\[|\]\]|".*?"|'.*?'/g, '').split('|')[0].trim()
    if (raw && !GENERIC_ARENA_NAMES.has(raw.toLowerCase()) && raw.length <= 40) return raw
  }
  return null
}

/** Discover the user's real arenas: candidates that recur >= threshold across
 * their notes (so a one-off folder isn't promoted to a space). */
function discoverArenas(
  notes: Array<{ rel: string; fm: Record<string, string> }>,
  threshold = 3
): Set<string> {
  const tally: Record<string, number> = {}
  for (const n of notes) {
    const a = arenaCandidateOf(n.rel, n.fm)
    if (a) tally[a] = (tally[a] || 0) + 1
  }
  return new Set(Object.entries(tally).filter(([, c]) => c >= threshold).map(([a]) => a))
}

function classify(
  rel: string,
  name: string,
  fm: Record<string, string>
): { dest: string; kind: string } {
  const base = basename(name, extname(name)).toLowerCase()
  const folder = rel.split(/[\\/]/).map((s) => s.toLowerCase())
  const fpath = folder.join('/')
  const type = (fm.type || fm.kind || '').toLowerCase()
  if (name.startsWith('_') || /readme|index/.test(base)) return { dest: F.knowledge, kind: 'index' }
  if (/^i\d{6}/.test(base) || folder.includes('instincts'))
    return { dest: F.instincts, kind: 'instinct' }
  if (type.includes('decision') || /decision|adr/.test(base))
    return { dest: F.decisions, kind: 'decision' }
  if (type.includes('person') || folder.includes('people') || folder.includes('crm') || folder.includes('private'))
    return { dest: F.people, kind: 'person' }
  if (/^\d{4}-\d{2}-\d{2}/.test(base) || /weekly|daily|12-week|session logs/.test(fpath))
    return { dest: F.planning, kind: 'time' }
  if (type.includes('task') || folder.includes('tasks')) return { dest: F.tasks, kind: 'task' }
  if (type === 'rule' || folder.includes('rules')) return { dest: F.rules, kind: 'rule' }
  if (folder.includes('templates') || folder.includes('scholar')) return { dest: F.templates, kind: 'template' }
  if (folder.includes('meta') || /harness|_system/.test(fpath)) return { dest: F.meta, kind: 'meta' }
  if (base === 'me' || base === 'personality' || /about me/.test(fpath)) return { dest: F.identity, kind: 'identity' }
  if (folder.includes('action')) return { dest: F.active, kind: 'active' }
  return { dest: F.knowledge, kind: 'card' }
}

function ensure(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

// The never-move set the in-place mover consults (any root .md it does not
// recognize gets filed into a pillar folder) now comes from ./foundation-files,
// shared with the two graph builders. SOUL.md was missing from this list once
// and the failure was silent: loadBrain reads the vault ROOT only, so a
// relocated character file still exists and simply stops loading.

/** Pick a collision-safe destination path: if `base.ext` already exists at
 * `dir` AND is a different file than `selfAbs`, append -2/-3/… until free.
 * Never overwrites a DIFFERENT note; returns the same path when the only
 * existing file IS this note (idempotent re-write). */
/** A previously auto-extracted entity note is ours to refresh freely: `entityNote` stamps every one it
 *  writes with `generated: true`. Anything without that stamp is treated as operator content. */
const GENERATED_ENTITY = (prior: string): boolean => /^---[\s\S]*?\bgenerated:\s*true/m.test(prior)

/** Identifies a DIAGNOSIS.md that WE generated. The file carries no frontmatter, so without a marker
 *  there is no way to tell our regenerated report from an operator file of the same name. */
const DIAG_MARKER = '<!-- duin:scaffold-diagnosis -->'

/** ALTERATION LEDGER — the vault is meant to self-evolve, so scaffold IS allowed to rewrite a note the
 *  operator wrote by hand. What it must never do is rewrite one SILENTLY. The store layer already holds
 *  this line ("never hard-delete, so the bi-temporal audit can still walk why a rule fell"); vault notes
 *  had no equivalent, so an LLM-named entity note could replace hundreds of hand-written lines with a
 *  stub, leaving no record of what changed, when, or where the original went.
 *
 *  Every alteration therefore lands in three places: the prior content preserved as a real file, a
 *  machine-readable row here, and a stamp in the new note's own frontmatter. Append-only JSONL, written
 *  under the vault's own state dir so it travels with the vault. Best-effort: a ledger failure must not
 *  become a second failure mode — but it DOES cancel the write (see writeTraceable). */
function recordAlteration(
  outDir: string,
  row: { path: string; priorBytes: number; priorCopy: string | null; by: string; at: string; reason: string }
): boolean {
  try {
    const dir = join(outDir, '.duin', '_state')
    ensure(dir)
    appendFileSync(join(dir, 'scaffold-alterations.jsonl'), JSON.stringify(row) + '\n')
    return true
  } catch (e) {
    console.warn('[scaffold] alteration ledger unwritable:', messageOf(e))
    return false
  }
}

/** Write a scaffold-generated note, PRESERVING and RECORDING whatever it replaces.
 *
 *  - Target absent, or holding previously-generated content ⇒ ordinary write, nothing to trace.
 *  - Target holding operator-authored content ⇒ copy the original into the inbox under a
 *    collision-safe name, append a ledger row, stamp the new body's frontmatter with when/how/where,
 *    and only then overwrite.
 *  - If the original cannot be preserved OR the alteration cannot be recorded ⇒ SKIP the write. An
 *    untraceable edit is exactly the failure being fixed, so it is better to leave the note alone.
 *    (This is the same refusal `w()` already makes when preservation fails.) */
function writeTraceable(
  outDir: string,
  target: string,
  body: string,
  meta: { by: string; reason: string },
  /** "Is the existing content ours to replace freely?" Defaults to byte-identity — a re-run writing the
   *  same bytes is a no-op, and ANYTHING else is treated as operator content worth preserving. That
   *  default is deliberately the most conservative available answer: misjudging here is what silently
   *  destroys a hand-written note, so callers must opt IN to a looser test. */
  isOurs: (prior: string) => boolean = (prior) => prior.trim() === body.trim()
): 'written' | 'altered' | 'skipped' {
  let prior = ''
  if (existsSync(target)) {
    try {
      prior = readFileSync(target, 'utf8')
    } catch (e) {
      console.warn('[scaffold] unreadable target  not overwriting:', target, messageOf(e))
      return 'skipped' // cannot preserve what cannot be read
    }
  }
  if (!prior || isOurs(prior)) {
    writeFileSync(target, body)
    return 'written'
  }
  const at = new Date().toISOString()
  let priorCopy: string | null
  try {
    const inbox = join(outDir, F.inbox)
    ensure(inbox)
    const safe = collisionSafePath(inbox, `${basename(target, extname(target))}-prior${extname(target)}`, resolve(target))
    if (resolve(safe) === resolve(target)) return 'skipped'
    writeFileSync(safe, prior)
    priorCopy = relative(outDir, safe).replace(/\\/g, '/')
  } catch (e) {
    console.warn('[scaffold] could not preserve prior content  leaving note untouched:', target, messageOf(e))
    return 'skipped'
  }
  const rel = relative(outDir, target).replace(/\\/g, '/')
  if (!recordAlteration(outDir, { path: rel, priorBytes: prior.length, priorCopy, by: meta.by, at, reason: meta.reason })) {
    return 'skipped' // no trace ⇒ no edit
  }
  // Stamp the note itself, so the alteration is visible where the reader actually is — not only in a
  // ledger they would have to know to open.
  const stamp = `altered-by: ${meta.by}\naltered-at: ${at}\naltered-reason: ${meta.reason}\nprior-copy: ${priorCopy}\n`
  const stamped = /^---\n/.test(body) ? body.replace(/^---\n/, `---\n${stamp}`) : `---\n${stamp}---\n\n${body}`
  writeFileSync(target, stamped)
  return 'altered'
}

function collisionSafePath(dir: string, name: string, selfAbs: string): string {
  const ext = extname(name)
  const stem = basename(name, ext)
  let candidate = join(dir, name)
  let i = 2
  while (existsSync(candidate)) {
    // Same physical file (re-run on an already-placed note) → reuse the path.
    try {
      if (statSync(candidate).isFile()) {
        // Compare by absolute path: if it's literally this note, fine to reuse.
        if (candidate === selfAbs) return candidate
      }
    } catch (e) { console.debug('[scaffold-harness] unreadable  treat as occupied, bump the suffix:', messageOf(e)) }
    candidate = join(dir, `${stem}-${i}${ext}`)
    i++
  }
  return candidate
}

/**
 * Scaffold a full OKF harness from a notes folder.
 *
 * IN-PLACE by default: when `outDir` is omitted (or equals `srcDir`), the brain
 * folder and the scaffolded harness are the SAME folder — foundation files,
 * Rules, and pillar folders are written into the source, and each existing note
 * is MOVED into its pillar folder. The move is read → write-to-pillar → verify →
 * only-then-delete, so a note is never lost: the original is deleted ONLY after
 * the new file is confirmed on disk.
 *
 * @param srcDir source notes directory (walked recursively)
 * @param outDir output harness directory. Omit (or pass === srcDir) to build
 *               in place. A DIFFERENT path keeps the legacy copy-out behavior.
 */
export async function scaffoldHarness(srcDir: string, outDir?: string): Promise<ScaffoldResult> {
  const today = new Date().toISOString().slice(0, 10)
  const empty: ScaffoldResult = { ok: false, counts: {}, tracks: [], diagnosisPath: '', foundation: {} }
  try {
    if (!srcDir) {
      return { ...empty, error: 'srcDir is required' }
    }
    // In-place is the default: no outDir → build the brain folder in place.
    const out = outDir && outDir.trim() ? outDir.trim() : srcDir
    if (!existsSync(srcDir)) {
      return { ...empty, error: `source folder does not exist: ${srcDir}` }
    }
    // Normalize the in-place check: same path string → in-place mode. (We keep
    // the comparison on the raw paths the caller passed; the IPC layer already
    // trims. A trailing-slash mismatch degrades safely to copy-out, which never
    // deletes originals.)
    const inPlace = resolve(out) === resolve(srcDir)
    // From here on, `outDir` refers to the resolved output. Reassign so the rest
    // of the function (which writes to `outDir`) targets the right folder.
    outDir = out

    // ── 1. Walk + classify ──────────────────────────────────────────────────
    const files = walk(srcDir).filter((f) => /\.(md|markdown|base|txt)$/i.test(f))
    const stats = {
      total: files.length,
      byKind: {} as Record<string, number>,
      tags: {} as Record<string, number>,
      withFm: 0
    }
    const placed: PlacedNote[] = []
    for (const f of files) {
      let text = ''
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const rel = relative(srcDir, f)
      const name = basename(f)
      const { fm, body } = parseFm(text)
      if (Object.keys(fm).length) stats.withFm++
      for (const t of (fm.tags || '').split(/[,\s[\]#]+/).filter(Boolean))
        stats.tags[t] = (stats.tags[t] || 0) + 1
      placed.push({
        abs: f,
        rel,
        name,
        fm,
        body,
        c: { dest: F.knowledge, kind: 'card' }, // provisional; set after arena discovery
        title: fm.title || firstHeading(body) || basename(name, extname(name))
      })
    }

    // ── arena-first assignment ──────────────────────────────────────────────
    // Discover the user's OWN arenas (recurring topic/domain folders or frontmatter),
    // then file each note into its arena (top level) or a cross-cutting DUIN pillar.
    // The note's real `type:` (decision/person/…) is preserved in frontmatter so the
    // Decisions/People surfaces still work as cross-arena views.
    const arenaSet = discoverArenas(placed)
    for (const p of placed) {
      const cand = arenaCandidateOf(p.rel, p.fm)
      p.c = cand && arenaSet.has(cand) ? { dest: cand, kind: 'arena' } : classify(p.rel, p.name, p.fm)
      stats.byKind[p.c.kind] = (stats.byKind[p.c.kind] || 0) + 1
    }
    const arenaList = Array.from(arenaSet)

    const topTags = Object.entries(stats.tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
    const cardHeadlines = placed
      .filter((p) => p.c.kind === 'card' || p.c.kind === 'instinct')
      .slice(0, 60)
      .map((p) => `- ${p.title}`)
      .join('\n')

    // ── 2. LLM pass 1 — strategic tracks + bio (heuristic fallback) ─────────
    const trackRaw = await ask(
      `You are scaffolding a personal second-brain harness for an operator from their notes. Below are their most-frequent TAGS (counts) and sample note titles. Infer their real STRATEGIC TRACKS (the few domains they actually work in — NOT meta/category tags like concept/knowledge-base/test/meta), plus a short bio.\n` +
        `Output ONLY JSON: {"bio":"2-3 sentences, second person","focus":"one line of active themes","tracks":[{"name":"short track name","objective":"one line: what they're trying to win"}]}\n` +
        `3-6 tracks; concrete objectives; keep the operator's own domain language (incl. non-English verbatim).\n\n=== TOP TAGS ===\n${topTags
          .map(([t, n]) => `${t}: ${n}`)
          .join('\n')}\n\n=== SAMPLE TITLES ===\n${cardHeadlines}`
    )
    const enrich = (firstJson(trackRaw) || {}) as {
      bio?: string
      focus?: string
      tracks?: Array<{ name?: string; objective?: string }>
    }

    // ── 3. LLM pass 2 — named entities from prose (heuristic fallback) ──────
    const entitySample = placed
      .filter((p) => p.c.kind === 'card')
      .slice(0, 50)
      .map((p) => `# ${p.title}\n${p.body.slice(0, 280)}`)
      .join('\n\n')
    const entityRaw = entitySample
      ? await ask(
          `From the notes below, extract NAMED ENTITIES the operator works with. Output ONLY JSON: {"people":["name — role"],"orgs":["org — one-line"],"projects":["project — one-line"]}. Dedupe; only real proper nouns; <=15 each; names verbatim (incl. CN/JP).\n\n${entitySample.slice(
            0,
            9000
          )}`
        )
      : ''
    const entities = (firstJson(entityRaw) || {}) as {
      people?: string[]
      orgs?: string[]
      projects?: string[]
    }

    // ── 4. Build the folder skeleton + write filed notes ────────────────────
    ensure(outDir)
    for (const k of Object.keys(F)) ensure(join(outDir, (F as Record<string, string>)[k]))

    const okf = (p: PlacedNote): string => {
      // Preserve the note's REAL type (decision/person/…) so cross-arena views work;
      // only fall back to the inferred kind when the note declared none.
      const realType = p.fm.type || p.fm.kind || (p.c.kind === 'arena' ? 'note' : p.c.kind)
      const fm: Record<string, string> = {
        type: realType,
        title: String(p.title).slice(0, 80).replace(/\n/g, ' '),
        timestamp: p.fm.created || p.fm.date || today
      }
      if (p.c.kind === 'arena') fm.arena = p.c.dest
      if (p.fm.tags) fm.tags = p.fm.tags
      return `---\n${Object.entries(fm)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n---\n`
    }
    // `outDir` is non-null from here (defaulted to srcDir above); capture a
    // non-optional binding so closures don't re-widen it to string|undefined.
    const OUT = outDir
    // Resolved absolute paths of the structural pillar dirs — used by the
    // in-place mover to detect "already filed" notes (idempotent skip).
    const structuralDirAbs = Array.from(
      new Set([
        ...Object.values(F).map((p) => resolve(OUT, p)),
        ...arenaList.map((a) => resolve(OUT, a))
      ])
    )
    // Is an absolute note path already sitting directly inside a pillar dir we
    // own? (idempotent: a re-run must not churn already-placed notes.)
    const isAlreadyFiled = (abs: string): boolean => {
      const parent = resolve(dirname(abs))
      return structuralDirAbs.includes(parent)
    }

    let moved = 0
    let skippedAlreadyFiled = 0
    for (const p of placed) {
      const destDir = join(OUT, p.c.dest)
      ensure(destDir)
      const content = okf(p) + '\n' + p.body.replace(/^\s+/, '')
      if (!inPlace) {
        // Legacy copy-out: write a copy into the new folder; leave the source
        // untouched. Basename collisions across pillars are rare and preserve
        // the original behavior (last write wins within a pillar).
        try {
          writeFileSync(join(destDir, p.name), content)
        } catch (e) {
          console.warn('[scaffold] write note failed:', p.name, (e as Error)?.message)
        }
        continue
      }

      // ── IN-PLACE MOVE — read→write→verify→delete, never lose a file ──
      // (a) Idempotent: a note already directly under a pillar dir is left
      //     exactly where it is (no churn on re-run). Never touch foundation
      //     files / structural dirs (they aren't in `placed` — only walked
      //     notes are — but guard anyway by basename for safety).
      if (FOUNDATION_FILES.has(p.name)) continue
      if (isAlreadyFiled(p.abs)) {
        skippedAlreadyFiled++
        continue
      }
      // (b) Collision-safe destination — never overwrite a DIFFERENT note.
      const destPath = collisionSafePath(destDir, p.name, resolve(p.abs))
      try {
        // Write the filed copy first.
        writeFileSync(destPath, content)
        // (c) CRITICAL: confirm the new file is on disk BEFORE deleting the
        //     original. existsSync gate — if the write silently failed, we keep
        //     the source intact (a duplicate is recoverable; a loss is not).
        if (!existsSync(destPath)) {
          console.warn('[scaffold] in-place write unverified, keeping original:', p.name)
          continue
        }
        // (d) Don't delete if the destination IS the source (would be a self-
        //     delete of the file we just kept) — e.g. a degenerate path equality.
        if (resolve(destPath) === resolve(p.abs)) {
          moved++
          continue
        }
        // Only now remove the original.
        try {
          unlinkSync(p.abs)
        } catch (e) {
          // Source delete failed → harmless duplicate (filed copy + original).
          // Prefer a duplicate over a loss; log and move on.
          console.warn('[scaffold] in-place: filed copy written but original not removed:', p.name, (e as Error)?.message)
        }
        moved++
      } catch (e) {
        // Write failed → original is untouched (never deleted). No loss.
        console.warn('[scaffold] in-place move (write) failed, original intact:', p.name, (e as Error)?.message)
      }
    }

    // ── 5. Write extracted entity notes ─────────────────────────────────────
    const entityNote = (kind: string, line: string): { name: string; body: string } => {
      const nameOnly = String(line).split(/[—\-:]/)[0].trim()
      const safe = nameOnly.replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'entity'
      return {
        name: `${safe}.md`,
        body: `---\ntype: ${kind}\ntitle: ${nameOnly}\ntimestamp: ${today}\ngenerated: true\n---\n\n# ${nameOnly}\n\n${line}\n\n*(Auto-extracted from your notes; DUIN enriches as you engage.)*\n`
      }
    }
    let nP = 0,
      nO = 0,
      nPr = 0
    // These filenames come from LLM entity extraction, and F.projects === F.knowledge is where every
    // unclassified note lands — so a model-chosen name collides with real operator notes routinely. The
    // note may be replaced (the vault is meant to evolve), but never without a preserved original, a
    // ledger row, and a frontmatter stamp saying what happened.
    for (const x of entities.people || []) {
      try {
        const n = entityNote('person', x)
        ensure(join(outDir, F.people))
        if (writeTraceable(outDir, join(outDir, F.people, n.name), n.body, { by: 'scaffold:entity-person', reason: 'LLM-extracted person note' }, GENERATED_ENTITY) !== 'skipped') nP++
      } catch (e) { console.debug('[scaffold-harness] skip bad entity:', messageOf(e)) }
    }
    for (const x of entities.orgs || []) {
      try {
        const n = entityNote('org', x)
        ensure(join(outDir, F.orgs))
        if (writeTraceable(outDir, join(outDir, F.orgs, n.name), n.body, { by: 'scaffold:entity-org', reason: 'LLM-extracted org note' }, GENERATED_ENTITY) !== 'skipped') nO++
      } catch (e) { console.debug('[scaffold-harness] skip:', messageOf(e)) }
    }
    for (const x of entities.projects || []) {
      try {
        const n = entityNote('project', x)
        ensure(join(outDir, F.projects))
        if (writeTraceable(outDir, join(outDir, F.projects, n.name), n.body, { by: 'scaffold:entity-project', reason: 'LLM-extracted project note' }, GENERATED_ENTITY) !== 'skipped') nPr++
      } catch (e) { console.debug('[scaffold-harness] skip:', messageOf(e)) }
    }

    // ── 6. Resolve tracks/bio/focus (LLM result OR heuristic fallback) ──────
    const tracks =
      Array.isArray(enrich.tracks) && enrich.tracks.length
        ? enrich.tracks.map((t) => ({
            name: String(t?.name ?? 'track'),
            objective: String(t?.objective ?? '(confirm the objective)')
          }))
        : arenaList.length
          ? // the discovered arenas ARE the user's real tracks — prefer them
            arenaList
              .slice(0, 8)
              .map((a) => ({ name: a, objective: '(confirm the objective for this arena)' }))
          : topTags
              .filter(([t]) => !/concept|knowledge|test|meta|harness|知识库|概念|测试/.test(t))
              .slice(0, 5)
              .map(([t, n]) => ({ name: t, objective: `(${n} notes — confirm the objective)` }))
    const bio = enrich.bio || '*(Tell DUIN who you are — declared in onboarding.)*'
    const focus = enrich.focus || tracks.map((t) => t.name).join(' · ')

    // ── 7. Foundation files ─────────────────────────────────────────────────
    // SAFETY (in-place only): a foundation file lands at the output root. If the
    // user ALREADY had a file there with the same name (e.g. their own
    // `index.md` / `MEMORY.md`) that the move loop deliberately left in place
    // (FOUNDATION_FILES skip), preserve its content by relocating it — collision
    // -safe — into 00 Inbox/ BEFORE we overwrite. Never silently clobber a user
    // file. On the SECOND run the file at root is OUR generated one (it carries
    // the generated frontmatter line), so we DON'T back it up again — we just
    // overwrite our own. We discriminate by a marker the generated files carry.
    const GEN_MARKER = 'load-policy: always-on' // present in BRAIN/me; index/MEMORY checked below
    const looksGenerated = (text: string, rel: string): boolean => {
      // Our generated foundation files all start with a `---` frontmatter block
      // we author. Treat a leading frontmatter whose `type:` matches the file's
      // expected type as "ours". Cheap + good enough to avoid clobbering a
      // hand-written user file of the same name on the first run.
      const expectByName: Record<string, string> = {
        'BRAIN.md': 'operating-instructions',
        'ME.md': 'identity',
        'GOALS.md': 'strategic-goals',
        'VAULT-MAP.md': 'vault-navigation',
        'INDEX.md': 'index',
        'MEMORY.md': 'memory',
        'DIAGNOSIS.md': '\u0000' // sentinel: no frontmatter to match — identified by DIAG_MARKER instead
      }
      const want = expectByName[rel]
      // DIAGNOSIS.md used to be hardcoded `'' -> return true`, i.e. "always ours to overwrite". It has
      // no frontmatter, so there was nothing to match on — but the consequence was that a hand-written
      // DIAGNOSIS.md was the one foundation name with NO preservation path at all. It is now identified
      // by a marker we author, so our own regenerated report overwrites freely while an operator file of
      // the same name is preserved and recorded like any other.
      if (want === '\u0000') return text.includes(DIAG_MARKER)
      if (want == null) return false
      const { fm } = parseFm(text)
      return fm.type === want || text.includes(GEN_MARKER)
    }
    // The preserve-into-00-Inbox + ledger block below used to be gated on `inPlace &&`, and that
    // gate was the whole bug: COPY-OUT can target the operator's LIVE vault (transfer-scaffold
    // calls `scaffoldHarness(rawSrcDir, vaultDir)`), so every stub foundation file — GOALS/ME/
    // BRAIN/VAULT-MAP/INDEX/MEMORY/DIAGNOSIS — was bare-written over the operator's hand-written
    // root notes with no preservation copy, no ledger row and no stamp. Mode is irrelevant to the
    // question that actually matters: does the TARGET hold operator content? `writeTraceable`
    // (defined 400 lines above, already used by the starter RULES and entity notes) answers exactly
    // that and does preserve → ledger → stamp → write, skipping the write if any step fails.
    //
    // `foundation` records the PER-FILE outcome. `ok: true` alone never meant "ME.md was written
    // and the prior one preserved" — a swallowed write failure or a refused write both still
    // returned ok — so callers that need destruction rights (transfer-scaffold deciding whether the
    // interview identity may supersede a stub) have to read a real per-file signal, not the pass flag.
    const foundation: Record<string, FoundationOutcome> = {}
    const w = (rel: string, content: string): void => {
      try {
        foundation[rel] = writeTraceable(
          OUT,
          join(OUT, rel),
          content,
          { by: 'scaffold:foundation', reason: `starter foundation file ${rel}` },
          // A foundation file WE generated is ours to refresh freely; byte-identity (an unchanged
          // re-run) counts too. Anything else is operator content → preserve + record + stamp.
          (prior) => prior.trim() === content.trim() || looksGenerated(prior, rel)
        )
      } catch (e) {
        // A throw here means nothing was written. Record that, so a caller cannot mistake the
        // failure for a completed write (which is precisely how the identity clobber happened).
        foundation[rel] = 'skipped'
        console.warn('[scaffold] write foundation file failed:', rel, messageOf(e))
      }
    }

    w(
      'GOALS.md',
      `---\ntype: strategic-goals\ndescription: "Strategic tracks + current cycle — top of the closed loop"\nlast-updated: ${today}\n---\n\n# Goals\n\n> Tracks synthesized from your notes by DUIN. Confirm/edit — the whole loop cascades from here.\n\n## Current Cycle\n- Window: ${today} -> +12 weeks\n\n## Tracks\n${tracks
        .map((t) => `\n### ${t.name}\n- Objective: ${t.objective}\n- Milestones: *(—)*`)
        .join('\n')}\n`
    )
    w(
      'ME.md',
      `---\ntype: identity\ndescription: "Who this operator is — first read each session"\nload-policy: always-on\nlast-updated: ${today}\n---\n\n# Me\n\n## Quick Bio\n${bio}\n\n## Current Focus\n${focus}. Full objectives -> [[GOALS]].\n\n## How to Work With Me\n*(Declared in onboarding: communication style, decision-making, tone, hard lines.)*\n\n## Confidential Lanes\n*(Workstreams that must stay isolated. DUIN asks this first; it gates everything.)*\n`
    )
    w(
      'BRAIN.md',
      `---\ntype: operating-instructions\ndescription: "The brain's operating contract — every agent and model loads this first and routes through it"\nload-policy: always-on\nlast-updated: ${today}\n---\n\n# BRAIN — Operating Contract\n\n> The contract every agent and model loads first and routes through — DUIN's brain-owned equivalent of BRAIN.md / AGENTS.md, but model-agnostic. DUIN routes every turn through the brain, so the contract carries no single model's convention name. **The brain IS the harness.**\n\n@ME.md\n@MEMORY.md\n\n## Role & Tone\nStrategic partner. Conclusion-first, high-density, no fluff. Propose — never act silently.\n\n## The Closed Loop\n\\\`\\\`\\\`\nGoals -> Planning (12-week->weekly->daily) -> Active (workstreams) -> Tasks -> Knowledge (insights) -> next cycle\n\\\`\\\`\\\`\nThe Rules layer makes the loop closeable — without it this is just a notes folder.\n\n## Autonomy posture\nA = act+log (reversible/regenerable). B = propose->confirm (any content write). C = never auto (outward sends, confidential crossings, done-claims without proof).\n\n## Hard Rules\n- Propose, don't act on the user's own files. \`(C) \` marks AI-generated. No fabricated done-stamps.\n- One claim per Knowledge note; cite a source. Confidential lanes are sacred.\n`
    )
    w(
      'VAULT-MAP.md',
      `---\ntype: vault-navigation\nlast-updated: ${today}\n---\n\n# Vault Map\n\nStart with [[BRAIN]] — the operating contract every agent and model loads first.\n\n| Pillar | Folder | Captures |\n|---|---|---|\n| Knowing | Knowledge/ | atomic permanent insights |\n| Aligning | Planning/ | goals -> 12-week -> weekly -> daily |\n| Doing | Active/ | live workstream logs -> Tasks/ |\n\nGoverned by Rules/. Inputs -> 00 Inbox/. People/orgs -> People/. Calls -> Decisions/. Reflexes -> Instincts/.\n`
    )
    w(
      'INDEX.md',
      `---\ntype: index\ntitle: ${basename(outDir)}\ntimestamp: ${today}\n---\n\n# ${basename(
        outDir
      )}\n\nOKF bundle. Start: [[BRAIN]] · [[ME]] · [[GOALS]] · [[VAULT-MAP]]. Auto-scaffolded from ${stats.total} notes.\n`
    )
    w(
      'MEMORY.md',
      `---\ntype: memory\nload-policy: conditional\nlast-updated: ${today}\n---\n\n# Memory\n\n## Hard Rules\n(Inherits BRAIN § Hard Rules; append on incident.)\n\n## Routing\ninsight->Knowledge · reflex->Instincts · person/org->People · decision->Decisions · task->Tasks\n`
    )

    // ── 8. Starter Rules (incl. day-one loops.md) ───────────────────────────
    const RULES: Record<string, string> = {
      'file-types.md':
        '---\ntype: rule\n---\n\n# File Types\n- Frontmatter: `type` + `timestamp` (ISO). `(C) ` = AI-generated. Wikilinks build the graph.\n',
      'knowledge.md':
        '---\ntype: rule\n---\n\n# Knowledge\n- Litmus: would you reuse it? One claim per note: Claim · Evidence · Mechanism · Application. Cite a source.\n',
      'tasks.md':
        '---\ntype: rule\n---\n\n# Tasks\n- `- [ ] task #tag (date)`. <=3 new/write. No fabricated done-stamps. Do not close unasked.\n',
      'loops.md':
        '---\ntype: rule\n---\n\n# Loops (day-one starter set)\n- **Boot**: every session loads BRAIN.md + ME.md + MEMORY.md + GOALS.md (identity first).\n- **Capture -> Decide -> Prove -> Learn**: raw -> 00 Inbox/; calls -> Decisions/; lessons -> Knowledge/Instincts/.\n- **Correction -> Learn**: when you correct DUIN it records the correction; a cluster recurring 3x becomes a hard rule (propose-only).\n- **Daily cadence**: a daily note in Planning/; a daily digest; weekly review promotes insights + re-ranks Goals.\n- **One Stop-gate**: derive your single highest-cost invariant and gate that outcome before "done".\n'
    }
    // A user note classified kind:'rule' is moved to DUIN/Rules/ by an earlier step, so these starter
    // filenames (file-types/knowledge/tasks/loops.md) can land on top of operator-authored content.
    // Replacing it is allowed; replacing it without a trace is not.
    for (const [n, c] of Object.entries(RULES)) {
      try {
        writeTraceable(outDir, join(outDir, F.rules, n), c, { by: 'scaffold:starter-rule', reason: `starter RULES/${n}` })
      } catch (e) {
        console.warn('[scaffold] write rule failed:', n, (e as Error)?.message)
      }
    }

    // ── 9. Diagnosis ────────────────────────────────────────────────────────
    const llmEnriched = trackRaw.length > 0 || entityRaw.length > 0
    const diag =
      `# ${basename(srcDir)} -> Harness — Scaffold Diagnosis (${today})\n\n` +
      `## Mode\n- ${inPlace ? `IN-PLACE — your brain folder IS the harness (${OUT}). Notes were MOVED into pillar folders (read→write→verify→delete; ${moved} moved, ${skippedAlreadyFiled} already-filed left in place).` : `Copy-out — scaffolded into a separate folder (${OUT}); originals left untouched.`}\n\n` +
      `## Input\n- Notes: ${stats.total} · with frontmatter: ${stats.withFm}\n\n` +
      `## Arenas (your topic spaces — discovered from your folders + frontmatter)\n${
        arenaList.length
          ? arenaList.map((a) => `- ${a}`).join('\n')
          : '- (none above threshold — everything filed to DUIN pillars)'
      }\n\n` +
      `## Auto-filed by kind\n${Object.entries(stats.byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `- ${k}: ${n}`)
        .join('\n')}\n\n` +
      `## LLM enrichment (${llmEnriched ? routeModel('extraction') ?? 'model' : 'NONE — fell back to heuristics'})\n` +
      `- Tracks: ${tracks.length} -> ${tracks.map((t) => t.name).join(' · ')}\n` +
      `- Bio: ${enrich.bio ? 'synthesized' : 'FELL BACK to stub (no model / model down?)'}\n` +
      `- Entities from prose: people=${nP}, orgs=${nO}, projects=${nPr}\n\n` +
      `## Remaining gaps to a fully-grounded harness\n` +
      `1. DECLARED identity (How-to-Work / Confidential Lanes) needs the INTERVIEW — not inferable.\n` +
      `2. Inferred engines (risks/insights/decision-loop) grow locally once in DUIN.\n` +
      `3. Typed edges (owns/blocks/attends) — DUIN construct.ts builds at runtime.\n` +
      `\n${DIAG_MARKER}\n`
    const diagnosisPath = join(outDir, 'DIAGNOSIS.md')
    w('DIAGNOSIS.md', diag)

    const counts: Record<string, number> = {
      notes: stats.total,
      withFrontmatter: stats.withFm,
      people: nP,
      orgs: nO,
      projects: nPr,
      ...(inPlace ? { moved, alreadyFiled: skippedAlreadyFiled } : {}),
      ...stats.byKind
    }

    return {
      ok: true,
      counts,
      tracks: tracks.map((t) => t.name),
      diagnosisPath,
      foundation
    }
  } catch (err) {
    return { ...empty, error: (err as Error)?.message ?? 'scaffold failed' }
  }
}

import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getSkillsDir, getSkill } from './skill-loader'

// create_skill — author a brand-new skill straight from the chat agent. A skill is
// just a Markdown unit (`<id>/SKILL.md`) with `name`/`description` frontmatter in
// DUIN's skills dir; the loader's chokidar watcher then live-loads it into the
// Skills panel with no restart. This is the write-path sibling of skill-import.ts
// (which copies EXISTING units from a folder): here the agent supplies the body and
// we synthesize a valid unit. Never overwrites an existing skill.

export type CreateSkillResult = { ok: true; id: string; path: string } | { ok: false; error: string }

const MAX_BODY_BYTES = 100_000

/** Turn a human skill name into a safe, collision-free file id: lowercase kebab,
 *  ascii-folded, path-char-free, capped at 64 chars. Returns '' when nothing usable
 *  survives (caller rejects). */
export function slugifySkillId(name: unknown): string {
  const raw = String(name ?? '')
  const folded = raw
    .normalize('NFKD')
    // drop combining marks left by NFKD (é → e)
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // cap then re-trim any '-' the slice exposed at the boundary
  return folded.slice(0, 64).replace(/^-+|-+$/g, '')
}

/** True if `body` opens with a YAML frontmatter block (`---` on the first line). */
function startsWithFrontmatter(body: string): boolean {
  return /^\uFEFF?\s*---\s*(\r?\n|$)/.test(body)
}

/** Render a description as a single safe YAML scalar. Collapse newlines, and quote
 *  (via JSON.stringify — valid YAML double-quote syntax) when the value is empty or
 *  could be mis-parsed (leading space/dash/quote, or a YAML indicator char). */
function yamlScalar(value: string): string {
  const oneLine = value.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (oneLine === '') return '""'
  const needsQuote = /^[\s"'\-&*!|>%@`#?,[\]{}]|[:#]\s|:$/.test(oneLine) || /[\n\t]/.test(oneLine)
  return needsQuote ? JSON.stringify(oneLine) : oneLine
}

/** Ids already present in the skills dir (directory `<id>/` + flat `<id>.md`). */
function idsOnDisk(dir: string): Set<string> {
  const ids = new Set<string>()
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) ids.add(entry.toLowerCase())
      else if (st.isFile() && /\.md$/i.test(entry)) ids.add(entry.replace(/\.md$/i, '').toLowerCase())
    }
  } catch {
    /* dir may not exist yet — getSkillsDir() creates it, best-effort */
  }
  return ids
}

/**
 * Create a new skill unit `<id>/SKILL.md` in DUIN's skills dir from a name + an
 * instruction body. Additive and non-destructive: refuses if the id already exists
 * (on disk or in the loaded set). The chokidar watcher live-loads it into the UI.
 */
export function createSkill(nameArg: unknown, descriptionArg: unknown, bodyArg: unknown): CreateSkillResult {
  const name = String(nameArg ?? '').trim()
  if (!name) return { ok: false, error: 'skill name is required' }

  const body = typeof bodyArg === 'string' ? bodyArg : String(bodyArg ?? '')
  if (!body.trim()) return { ok: false, error: 'skill body (the instructions) is required' }
  if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES)
    return { ok: false, error: `skill body is too large (max ${MAX_BODY_BYTES} bytes)` }
  if (startsWithFrontmatter(body))
    return {
      ok: false,
      error: 'provide the skill instructions only — the frontmatter (name/description) is generated for you'
    }

  const id = slugifySkillId(name)
  if (!id) return { ok: false, error: `"${name}" has no letters or digits usable for a skill id` }

  const dir = getSkillsDir()

  // Dedup: on-disk (dir or flat .md, case-insensitive) OR already loaded.
  if (idsOnDisk(dir).has(id) || getSkill(id)) {
    return {
      ok: false,
      error: `a skill "${id}" already exists — pick a different name, or edit it in the Skills panel`
    }
  }

  const description = String(descriptionArg ?? '').trim()
  const frontmatter = `---\nname: ${id}\ndescription: ${yamlScalar(description || name)}\n---\n\n`
  const content = frontmatter + body.trim() + '\n'

  const skillDir = join(dir, id)
  const filePath = join(skillDir, 'SKILL.md')
  let createdDir = false
  try {
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true })
      createdDir = true
    }
    // Last-line defense against a race/leftover: never clobber an existing SKILL.md.
    if (existsSync(filePath)) {
      return { ok: false, error: `a skill file already exists at ${filePath} — not overwriting` }
    }
    writeFileSync(filePath, content, 'utf-8')
    return { ok: true, id, path: filePath }
  } catch (err) {
    // Best-effort cleanup of the empty dir we just made, so a failed create leaves no husk.
    if (createdDir) {
      try {
        rmdirSync(skillDir)
      } catch {
        /* leave it; a stray empty dir is harmless and the loader ignores dirs without SKILL.md */
      }
    }
    return { ok: false, error: `could not write the skill: ${(err as Error).message}` }
  }
}

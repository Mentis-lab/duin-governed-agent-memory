import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from 'fs'
import { join, basename, dirname, resolve, sep } from 'path'
import matter from 'gray-matter'
import { getSkillsDir } from './skill-loader'

// Generic, agent-agnostic skill import. Skills accumulated by ANY other agent
// tool (Claude Code, a vault `.claude/skills`, another harness) are just Markdown
// files with `name`/`description` frontmatter — flat `<id>.md` or directory-mode
// `<id>/SKILL.md` (case-insensitive) with supporting sibling files. This copies
// such units from an arbitrary source folder into DUIN's skills dir; the loader's
// chokidar watcher then picks them up live. Never overwrites an existing skill.

export interface SkillImportResult {
  imported: string[]
  skipped: { path: string; reason: string }[]
}

function hasNameFrontmatter(filePath: string): boolean {
  try {
    const parsed = matter(readFileSync(filePath, 'utf-8'))
    return typeof parsed.data.name === 'string' && parsed.data.name.trim().length > 0
  } catch {
    return false
  }
}

function isSkillMd(name: string): boolean {
  return name.toLowerCase() === 'skill.md'
}

function isMd(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

/** Strip the .md extension case-insensitively (basename(f,'.md') only strips lowercase). */
function idFromFlatFile(filePath: string): string {
  return basename(filePath).replace(/\.md$/i, '')
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walkFiles(full))
    else if (st.isFile()) out.push(full)
  }
  return out
}

function copyDirRecursive(
  src: string,
  dest: string,
  skipped: { path: string; reason: string }[]
): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dest, entry)
    let st
    try {
      st = statSync(s)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      copyDirRecursive(s, d, skipped)
    } else if (st.isFile()) {
      try {
        copyFileSync(s, d)
      } catch (err) {
        skipped.push({ path: s, reason: `copy failed: ${(err as Error).message}` })
      }
    }
  }
}

/** Ids already present in the DUIN skills dir (flat `<id>.md` + directory `<id>/`). */
/** Case-fold a skill id for the exists check.
 *
 *  The check compared ids EXACTLY while the filesystem underneath does not. On NTFS and
 *  APFS — the two most common desktop filesystems — `MySkill` and `myskill` are the same
 *  directory, so importing a skill whose id differed only by case from one you had
 *  hand-authored (a routine cross-platform export/re-zip) sailed past "already exists,
 *  skip" and the copy overwrote your curated skill's files.
 *
 *  Folded unconditionally, including on a case-SENSITIVE filesystem where the two really
 *  could coexist. That direction costs a false "already exists" skip, which the user sees
 *  and can rename around. The other direction silently destroys authored work. */
function foldId(id: string): string {
  return id.toLowerCase()
}

function existingSkillIds(destRoot: string): Set<string> {
  const ids = new Set<string>()
  try {
    for (const entry of readdirSync(destRoot)) {
      const full = join(destRoot, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) ids.add(foldId(entry))
      else if (st.isFile() && isMd(entry)) ids.add(foldId(idFromFlatFile(full)))
    }
  } catch {
    /* dir may not exist yet — getSkillsDir() creates it, so this is best-effort */
  }
  return ids
}

export function importSkillsFromDir(srcDir: string): SkillImportResult {
  const imported: string[] = []
  const skipped: { path: string; reason: string }[] = []
  const destRoot = getSkillsDir()

  if (resolve(srcDir) === resolve(destRoot)) {
    return { imported, skipped: [{ path: srcDir, reason: 'source is the DUIN skills dir' }] }
  }
  if (!existsSync(srcDir)) {
    return { imported, skipped: [{ path: srcDir, reason: 'source folder does not exist' }] }
  }

  const allFiles = walkFiles(srcDir)
  const existingIds = existingSkillIds(destRoot)

  // Pass 1 — directory-mode units (a SKILL.md/skill.md; root = its parent dir).
  // Claim every file under a unit root so its sibling `.md`s aren't re-imported flat.
  const claimedRoots: string[] = []
  for (const f of allFiles) {
    if (!isSkillMd(basename(f))) continue
    const root = dirname(f)
    const id = basename(root)
    claimedRoots.push(resolve(root))
    if (!hasNameFrontmatter(f)) {
      skipped.push({ path: f, reason: 'no name frontmatter' })
      continue
    }
    if (existingIds.has(foldId(id))) {
      skipped.push({ path: root, reason: 'already exists' })
      continue
    }
    try {
      copyDirRecursive(root, join(destRoot, id), skipped)
      imported.push(id)
      existingIds.add(foldId(id))
    } catch (err) {
      skipped.push({ path: root, reason: `copy failed: ${(err as Error).message}` })
    }
  }

  const underClaimed = (f: string): boolean => {
    const rf = resolve(f)
    return claimedRoots.some((root) => rf === root || rf.startsWith(root + sep))
  }

  // Pass 2 — flat `<id>.md` files not inside any claimed directory unit.
  for (const f of allFiles) {
    if (!isMd(basename(f)) || isSkillMd(basename(f)) || underClaimed(f)) continue
    if (!hasNameFrontmatter(f)) {
      skipped.push({ path: f, reason: 'no name frontmatter' })
      continue
    }
    const id = idFromFlatFile(f)
    if (existingIds.has(foldId(id))) {
      skipped.push({ path: f, reason: 'already exists' })
      continue
    }
    try {
      copyFileSync(f, join(destRoot, `${id}.md`))
      imported.push(id)
      existingIds.add(foldId(id))
    } catch (err) {
      skipped.push({ path: f, reason: `copy failed: ${(err as Error).message}` })
    }
  }

  return { imported, skipped }
}

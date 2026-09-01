// projects-native — TS port of server.py:list_projects. Dashboard projects: legacy
// `03 Projects/` lists sub-hubs; an arena-first vault (no 03 Projects) lists top-level
// arena spaces (ProjectA, PartnerCo-DUIN, …) minus DUIN + framework dirs. Pure reads.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { isArenaCandidate } from './arena-folders'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

/** First H1, else first non-frontmatter line, truncated to 90. Port of project_desc. */
export function projectDesc(text: string): string {
  const h1 = /^#\s+(.+)$/m.exec(text)
  if (h1) return h1[1].trim().slice(0, 90)
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s && !s.startsWith('---')) return s.slice(0, 90)
  }
  return ''
}

function countMdRecursive(dir: string): number {
  let n = 0
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countMdRecursive(join(dir, e.name))
    else if (e.name.endsWith('.md')) n++
  }
  return n
}

interface Project {
  name: string
  desc: string
  tracks: number
}

export function listProjects(vaultDir: string | null): Project[] {
  if (!vaultDir) return []
  const base = vaultDir
  const legacy = join(base, '03 Projects')
  const rows: Project[] = []
  if (isDir(legacy)) {
    for (const name of readdirSync(legacy).sort()) {
      const pdir = join(legacy, name)
      if (!isDir(pdir) || name.startsWith('_') || name.startsWith('.')) continue
      let desc = ''
      const cm = join(pdir, 'BRAIN.md')
      if (isFile(cm)) desc = projectDesc(readText(cm))
      let tracks: number
      try {
        tracks = readdirSync(pdir).filter((f) => f.endsWith('.md') && f !== 'BRAIN.md').length
      } catch {
        tracks = 0
      }
      rows.push({ name, desc, tracks })
    }
    return rows
  }
  // arena-first: top-level arena spaces are the projects. Use the SAME arena rule
  // as the Spaces lens (isArenaCandidate — drops generic/numbered/doc-container
  // folders) so the two surfaces agree, and require the folder to actually hold
  // notes. Fixes "any folder = project" (04 Notes / Documents / Outputs / DUIN-Docs).
  for (const name of readdirSync(base).sort()) {
    const pdir = join(base, name)
    if (!isDir(pdir) || !isArenaCandidate(name)) continue
    const tracks = countMdRecursive(pdir)
    if (tracks === 0) continue
    let desc = ''
    for (const hub of ['BRAIN.md', 'README.md', '_index.md', 'INDEX.md']) {
      const hp = join(pdir, hub)
      if (isFile(hp)) {
        desc = projectDesc(readText(hp))
        break
      }
    }
    rows.push({ name, desc, tracks })
  }
  return rows
}

export function listProjectsWrapped(vaultDir: string | null): { projects: Project[] } {
  return { projects: listProjects(vaultDir) }
}

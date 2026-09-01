// Native port of Python `project_detail(name)` (server.py, /state/project) — a
// project's real shape: its tracks (the .md notes in its folder) + everything those
// notes connect to, grouped by kind (projects/people/orgs/decisions/references) via
// _categorize_links over every [[wikilink]]. Pure read.
//
// Reuses resolveWikilink (doc-native, already flipped) + arenaDirs (throughput). The
// small classifiers (fmOf/cleanName/personSignal/orgSignal) are replicated locally
// rather than imported from entities-native — keeps this on an isolated branch with
// zero edits to files the read-lane owns (parity confirms they match).
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, sep } from 'path'
import { resolveWikilink } from './doc-native'
import { arenaDirs } from './throughput'

const WIKILINK = /\[\[([^\]|#]+)/g

/** Python text-mode read: \r\n → \n (CRLF gotcha — frontmatter/regex anchors need LF). */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}

function fmOf(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}

/** Port of _clean_name: drop a trailing parenthetical + strip [] brackets both ends. */
function cleanName(s: string): string {
  return s
    .replace(/\s*[（(][^)）]*[)）]\s*$/, '')
    .trim()
    .replace(/^[[\]]+|[[\]]+$/g, '')
    .trim()
}

function personSignal(head: string, path: string): boolean {
  const fm = fmOf(head)
  return fm.includes('人物档案') || /^type:\s*person\b/m.test(fm) || path.includes('/人物/')
}
function orgSignal(head: string): boolean {
  const fm = fmOf(head)
  return fm.includes('ORG档案') || fm.includes('公司档案') || fm.includes('组织档案') || /^type:\s*org\b/m.test(fm)
}

interface LinkItem {
  name: string
  path: string
}
export interface CategorizedLinks {
  projects: LinkItem[]
  people: LinkItem[]
  organizations: LinkItem[]
  decisions: LinkItem[]
  references: LinkItem[]
}

/** Port of _categorize_links: resolve every [[wikilink]] in `text`, group by target kind. */
export function categorizeLinks(vaultDir: string, text: string): CategorizedLinks {
  const groups: CategorizedLinks = { projects: [], people: [], organizations: [], decisions: [], references: [] }
  const seen = new Set<string>()
  for (const m of text.matchAll(WIKILINK)) {
    const name = m[1].split('|')[0].split('#')[0].trim()
    let bn = name.split('/').pop()!.trim()
    if (bn.toLowerCase().endsWith('.md')) bn = bn.slice(0, -3)
    if (!bn || seen.has(bn.toLowerCase())) continue
    seen.add(bn.toLowerCase())
    const path = resolveWikilink(vaultDir, bn)
    if (!path) continue
    const head = readText(join(vaultDir, path.replace(/\//g, sep))).slice(0, 1500)
    const item: LinkItem = { name: cleanName(bn), path }
    const low = path.toLowerCase()
    if (low.includes('03 projects/')) groups.projects.push(item)
    else if (orgSignal(head)) groups.organizations.push(item)
    else if (path.includes('/人物/') || personSignal(head, path)) groups.people.push(item)
    else if (low.includes('05 decisions/') || low.includes('duin/decisions/') || low.includes('/decisions/'))
      groups.decisions.push(item)
    else groups.references.push(item)
  }
  return groups
}

/** Port of project_desc: first H1, else first non-frontmatter line, truncated to 90. */
export function projectDesc(text: string): string {
  const h1 = /^#\s+(.+)$/m.exec(text)
  if (h1) return h1[1].trim().slice(0, 90)
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s && !s.startsWith('---')) return s.slice(0, 90)
  }
  return ''
}

export interface ProjectDetail {
  name: string
  desc: string
  overview: string
  tracks: { name: string; path: string }[]
  connections: CategorizedLinks | Record<string, never>
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Faithful port of server.py:project_detail(). Pure fs. */
export function projectDetail(vaultDir: string | null, name: string): ProjectDetail {
  if (!vaultDir || !name) return { name, desc: '', overview: '', tracks: [], connections: {} }
  let pdir = join(vaultDir, '03 Projects', name)
  let relRoot = `03 Projects/${name}`
  if (!isDir(pdir)) {
    const arena = join(vaultDir, name)
    if (isDir(arena) && arenaDirs(vaultDir).includes(name)) {
      pdir = arena
      relRoot = name
    } else {
      return { name, desc: '', overview: '', tracks: [], connections: {} }
    }
  }
  const tracks: { name: string; path: string }[] = []
  let alltext = ''
  let desc = ''
  let overview = ''
  let files: string[]
  try {
    files = readdirSync(pdir).sort()
  } catch {
    files = []
  }
  for (const fn of files) {
    if (!fn.endsWith('.md')) continue
    const t = readText(join(pdir, fn))
    alltext += '\n' + t
    if (fn === 'BRAIN.md') {
      overview = `${relRoot}/BRAIN.md`
      desc = projectDesc(t)
    } else {
      tracks.push({ name: fn.slice(0, -3), path: `${relRoot}/${fn}` })
    }
  }
  return { name, desc, overview, tracks, connections: categorizeLinks(vaultDir, alltext) }
}

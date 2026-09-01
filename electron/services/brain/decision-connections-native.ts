// decision-connections-native — TS port of server.py:decision_connections + _categorize_links.
// Resolves every [[wikilink]] in a decision doc and groups targets by kind (project/person/org/
// decision/reference) so the decision joins the graph. Reuses readDoc + resolveWikilink
// (doc-native); the small entity/pillar signal helpers are replicated locally to stay isolated.
import { readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { readDoc, resolveWikilink } from './doc-native'

const PILLARS = ['DUIN/Decisions', '05 Decisions']
const DISCOVER_SKIP = new Set([
  '.duin', '.obsidian', '.git', '.smart-env', '.brain', '.trash', '.codex',
  'node_modules', '__pycache__', '.venv', 'dist', 'dist2', 'build', 'out',
  '_agui_outputs', '_agui_uploads', 'even-g2-companion', '99 Attachments'
])
const WIKILINK = /\[\[([^\]|#]+)/g

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
const readHead = (p: string, n: number): string => {
  try {
    return readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n').slice(0, n)
  } catch {
    return ''
  }
}
const cleanName = (s: string): string =>
  s.replace(/\s*[（(][^)）]*[)）]\s*$/, '').trim().replace(/^\[+|\]+$/g, '').trim()
const fmOf = (head: string): string => {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
const orgSignal = (head: string): boolean => {
  const fm = fmOf(head)
  return fm.includes('ORG档案') || fm.includes('公司档案') || fm.includes('组织档案') || /^type:\s*org\b/m.test(fm)
}
const personSignal = (head: string, path: string): boolean => {
  const fm = fmOf(head)
  return fm.includes('人物档案') || /^type:\s*person\b/m.test(fm) || path.includes('/人物/')
}

interface LinkItem {
  name: string
  path: string
}
type Groups = { projects: LinkItem[]; people: LinkItem[]; organizations: LinkItem[]; decisions: LinkItem[]; references: LinkItem[] }

function categorizeLinks(vaultDir: string, text: string): Groups {
  const groups: Groups = { projects: [], people: [], organizations: [], decisions: [], references: [] }
  const seen = new Set<string>()
  for (const m of text.matchAll(WIKILINK)) {
    const name = m[1].split('|')[0].split('#')[0].trim()
    let bn = name.split('/').pop()!.trim()
    if (bn.toLowerCase().endsWith('.md')) bn = bn.slice(0, -3)
    if (!bn || seen.has(bn.toLowerCase())) continue
    seen.add(bn.toLowerCase())
    const path = resolveWikilink(vaultDir, bn)
    if (!path) continue
    const head = readHead(join(vaultDir, path), 1500)
    const item: LinkItem = { name: cleanName(bn), path }
    const low = path.toLowerCase()
    if (low.includes('03 projects/')) groups.projects.push(item)
    else if (orgSignal(head)) groups.organizations.push(item)
    else if (path.includes('/人物/') || personSignal(head, path)) groups.people.push(item)
    else if (low.includes('05 decisions/') || low.includes('duin/decisions/') || low.includes('/decisions/')) groups.decisions.push(item)
    else groups.references.push(item)
  }
  return groups
}

function firstDecisionPillar(base: string): string {
  return PILLARS.map((c) => join(base, c)).find(isDir) ?? join(base, PILLARS[0])
}
/** Fallback: find a decision file by basename anywhere in the tree (topic-space layout). */
function findByBasename(base: string, rel: string, target: string): string | null {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true })
  } catch {
    return null
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!DISCOVER_SKIP.has(e.name) && !e.name.startsWith('.')) subdirs.push(e.name)
    } else if (e.name === target) {
      return join(base, rel ? `${rel}/${e.name}` : e.name)
    }
  }
  for (const sd of subdirs) {
    const hit = findByBasename(base, rel ? `${rel}/${sd}` : sd, target)
    if (hit) return hit
  }
  return null
}

export function decisionConnections(vaultDir: string | null, decisionId: string): Groups {
  const empty: Groups = { projects: [], people: [], organizations: [], decisions: [], references: [] }
  if (!vaultDir) return empty
  const pillarPath = join(firstDecisionPillar(vaultDir), decisionId)
  const rel = pillarPath.slice(vaultDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  let text = readDoc(vaultDir, rel)
  if (!text) {
    // topic-space layout: resolve by basename anywhere
    if (decisionId) {
      const target = decisionId.endsWith('.md') ? decisionId : `${decisionId}.md`
      const p = findByBasename(vaultDir, '', target)
      if (p && isFile(p)) {
        try {
          text = readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n')
        } catch {
          text = ''
        }
      }
    }
  }
  return categorizeLinks(vaultDir, text || '')
}

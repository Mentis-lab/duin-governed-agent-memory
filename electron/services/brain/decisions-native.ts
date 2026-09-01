// decisions-native — TS port of server.py:list_decisions + parse_decision. Dashboard
// decisions: legacy pillar fast-path (05 Decisions / DUIN/Decisions), else discover by
// `type: decision` frontmatter anywhere. Skips Obsidian template files. Pure reads.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const PILLARS = ['DUIN/Decisions', '05 Decisions']
const DISCOVER_SKIP = new Set([
  '.duin', '.obsidian', '.git', '.smart-env', '.brain', '.trash', '.codex',
  'node_modules', '__pycache__', '.venv', 'dist', 'dist2', 'build', 'out',
  '_agui_outputs', '_agui_uploads', 'even-g2-companion', '99 Attachments'
])
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
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
function decisionsPillar(base: string): string {
  return PILLARS.map((c) => join(base, c)).find(isDir) ?? join(base, PILLARS[0])
}

export interface DecisionRow {
  id: string
  title: string
  date: string
  status: string
  oneWay: boolean
  reversibility: string
  owner: string
  reviewOn: string
  links: number
  layer: string
  domain: string
}

/** Parse a decision .md → dashboard row. Pure port of parse_decision. */
export function parseDecision(text: string, filename: string): DecisionRow {
  const fm: Record<string, string> = {}
  let body = text
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)/.exec(text)
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i >= 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    body = m[2]
  }
  const h1 = /^#\s+(.+)$/m.exec(body)
  const title = h1 ? h1[1].trim() : filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename
  const rev = (fm.reversibility || '').toLowerCase()
  return {
    id: filename,
    title,
    date: fm.date ?? '',
    status: fm.status || 'decided',
    oneWay: ['one-way', 'irreversible', 'one way'].includes(rev),
    reversibility: fm.reversibility || '—',
    owner: fm.owner ?? '',
    reviewOn: fm.review_on || '',
    links: (body.match(/\[\[[^\]]+\]\]/g) ?? []).length,
    layer: (fm.layer || '').trim().toLowerCase(),
    domain: (fm.domain || fm.category || '').trim().toLowerCase()
  }
}

const frontmatterIs = (path: string, value: string): boolean => {
  const head = (() => {
    try {
      return readFileSync(path, 'utf-8').replace(/\r\n?/g, '\n').slice(0, 1000)
    } catch {
      return ''
    }
  })()
  if (!head.startsWith('---')) return false
  const end = head.indexOf('\n---', 3)
  const fm = end !== -1 ? head.slice(0, end) : head
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`^\\s*(?:type|kind)\\s*:\\s*${esc}\\b`, 'mi').test(fm)) return true
  if (new RegExp(`^\\s*tags\\s*:.*\\b${esc}\\b`, 'mi').test(fm)) return true
  return false
}

/** Yield [abspath, filename] for every .md, skipping framework/junk + dotdirs. */
function iterMd(base: string, rel: string, out: [string, string][]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true })
  } catch {
    return
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!DISCOVER_SKIP.has(e.name) && !e.name.startsWith('.')) subdirs.push(e.name)
    } else if (e.name.endsWith('.md')) {
      out.push([join(base, rel ? `${rel}/${e.name}` : e.name), e.name])
    }
  }
  for (const sd of subdirs) iterMd(base, rel ? `${rel}/${sd}` : sd, out)
}

export function listDecisions(vaultDir: string | null): { decisions: DecisionRow[] } {
  if (!vaultDir) return { decisions: [] }
  const base = vaultDir
  const legacy = decisionsPillar(base)
  const candidates: [string, string][] = []
  let legacyHas = false
  if (isDir(legacy)) {
    try {
      legacyHas = readdirSync(legacy).some((fn) => fn.endsWith('.md') && !fn.startsWith('_') && !fn.startsWith('(C)'))
    } catch {
      legacyHas = false
    }
  }
  if (legacyHas) {
    for (const fn of readdirSync(legacy).sort()) {
      if (!fn.endsWith('.md') || fn.startsWith('_') || fn.startsWith('(C)')) continue
      candidates.push([join(legacy, fn), fn])
    }
  } else {
    const all: [string, string][] = []
    iterMd(base, '', all)
    for (const [path, fn] of all) {
      if (fn.startsWith('_') || fn.startsWith('(C)')) continue
      if (frontmatterIs(path, 'decision')) candidates.push([path, fn])
    }
  }
  const rows: DecisionRow[] = []
  for (const [path, fn] of candidates) {
    const text = readText(path)
    if (!text) continue
    if (text.includes('<%') || text.includes('{{title}}') || text.includes('{{date}}')) continue
    rows.push(parseDecision(text, fn))
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { decisions: rows }
}

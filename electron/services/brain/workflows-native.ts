// workflows-native — TS port of server.py:list_workflows. The capability layer: skills
// (.duin/skills/*/SKILL.md), agents (.duin/agents/*.md), and methods (notes with
// type: method, whose [[wikilinks]] are classified into what they wire together). Pure
// reads (dir listings + vault walk + regex), no side effects.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { isVaultWalkDir } from './vault-dirs'

// Skills/agents are read from EXPLICIT `.duin/skills` + `.duin/agents` paths below;
// the method-walk (walkMd) uses isVaultWalkDir, which prunes `.duin` — so app-state
// never leaks in as a phantom method, while the intentional capability reads stand.
const BRAIN = '.duin'

function fmOf(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
/** Port of _fm_kv: key: value from frontmatter, stripping surrounding quotes; skips list keys. */
function fmKv(head: string): Record<string, string> {
  const d: Record<string, string> = {}
  for (const line of fmOf(head).split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) {
      const k = line.slice(0, i).trim()
      if (k && !k.startsWith('-')) {
        d[k] = line
          .slice(i + 1)
          .trim()
          .replace(/^"+|"+$/g, '')
          .replace(/^'+|'+$/g, '')
      }
    }
  }
  return d
}
const readHead = (p: string, n: number): string => {
  try {
    return readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n').slice(0, n)
  } catch {
    return ''
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

interface Cap {
  name: string
  desc: string
  kind: string
  path: string
  category?: string
  wires?: { name: string; kind: string }[]
  stages?: number
  taskKind?: string
  deliverable?: string
}

/** Extract a frontmatter list field. Handles inline `key: [a, b]`, a bare comma
 *  list `key: a, b`, a YAML block list (`key:` then `- a` lines), and a single
 *  scalar. Quotes stripped, empties dropped. */
export function fmList(head: string, key: string): string[] {
  const lines = fmOf(head).split('\n')
  const dq = (s: string): string => s.trim().replace(/^["']+|["']+$/g, '').trim()
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx <= 0 || lines[i].slice(0, idx).trim() !== key) continue
    const rest = lines[i].slice(idx + 1).trim()
    if (rest.startsWith('[')) {
      return rest.replace(/^\[|\]$/g, '').split(',').map(dq).filter(Boolean)
    }
    if (rest.includes(',')) return rest.split(',').map(dq).filter(Boolean)
    const items: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const bl = lines[j].trim()
      if (bl.startsWith('- ')) items.push(dq(bl.slice(2)))
      else if (bl === '') continue
      else break
    }
    if (items.length) return items.filter(Boolean)
    return rest ? [dq(rest)].filter(Boolean) : []
  }
  return []
}

function walkMd(base: string, rel: string, out: [string, string][]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true })
  } catch {
    return
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (isVaultWalkDir(e.name)) subdirs.push(e.name)
    } else if (e.name.endsWith('.md')) {
      out.push([join(base, rel ? `${rel}/${e.name}` : e.name), rel ? `${rel}/${e.name}` : e.name])
    }
  }
  for (const sd of subdirs) walkMd(base, rel ? `${rel}/${sd}` : sd, out)
}

/** `installedSkills` — ids/names of the app's own installed skills (see
 *  skill-loader.installedSkillNames). The `skills` Cap array below stays a
 *  faithful listing of what is in the VAULT, but wikilink CLASSIFICATION must
 *  also consider the app's set: `.duin/skills` is never written by DUIN, so
 *  classifying against it alone left every wikilink wire unresolved on any
 *  install whose operator had not hand-built that directory. */
export function listWorkflows(
  vaultDir: string | null,
  installedSkills?: Iterable<string>
): { methods: Cap[]; skills: Cap[]; agents: Cap[] } {
  if (!vaultDir) return { methods: [], skills: [], agents: [] }
  const base = vaultDir

  const skills: Cap[] = []
  const sd = join(base, BRAIN, 'skills')
  if (isDir(sd)) {
    for (const name of readdirSync(sd).sort()) {
      if (name.startsWith('.') || name.startsWith('_')) continue
      const sf = join(sd, name, 'SKILL.md')
      if (isDir(join(sd, name)) && statSync(sf, { throwIfNoEntry: false })?.isFile()) {
        const fm = fmKv(readHead(sf, 1400))
        skills.push({
          name: fm.name ?? name,
          desc: (fm.description ?? '').slice(0, 160),
          kind: 'skill',
          category: (fm.category ?? '').trim() || 'general',
          path: `${BRAIN}/skills/${name}/SKILL.md`
        })
      }
    }
  }

  const agents: Cap[] = []
  const ad = join(base, BRAIN, 'agents')
  if (isDir(ad)) {
    for (const fn of readdirSync(ad).sort()) {
      if (fn.endsWith('.md')) {
        const fm = fmKv(readHead(join(ad, fn), 1400))
        agents.push({ name: fm.name ?? fn.slice(0, -3), desc: (fm.description ?? '').slice(0, 160), kind: 'agent', path: `${BRAIN}/agents/${fn}` })
      }
    }
  }

  const skillNames = new Set<string>([...skills.map((s) => s.name), ...skills.map((s) => s.path.split('/').slice(-2, -1)[0])])
  for (const s of installedSkills ?? []) if (s) skillNames.add(s)
  const agentNames = new Set<string>([...agents.map((a) => a.name), ...agents.map((a) => a.path.split('/').pop()!.slice(0, -3))])
  const classifyLink = (target: string): string => {
    const t = target.split('|')[0].trim()
    const leaf = t.split('/').pop()!.replace('.md', '')
    if (t.includes('/skills/') || skillNames.has(leaf)) return 'skill'
    if (agentNames.has(leaf)) return 'agent'
    if (t.startsWith('09 Rules') || t.startsWith('DUIN/Rules') || t.includes('/Rules/') || t.includes('/_judgment')) return 'rule'
    if (leaf.startsWith('v-')) return 'value'
    if (leaf.startsWith('f-')) return 'framework'
    if (leaf.startsWith('s-')) return 'strategy'
    if (leaf.startsWith('m-')) return 'method'
    return 'note'
  }

  const methods: Cap[] = []
  const files: [string, string][] = []
  walkMd(base, '', files)
  for (const [abs, rel] of files) {
    if (abs.toLowerCase().includes('template')) continue
    const h = readHead(abs, 1400)
    if (!/^type:\s*method\b/m.test(fmOf(h))) continue
    const fm = fmKv(h)
    let body: string
    try {
      body = readFileSync(abs, 'utf-8').replace(/\r\n?/g, '\n')
    } catch {
      body = h
    }
    const seen = new Map<string, { name: string; kind: string }>()
    // calls-skills frontmatter is the canonical composition declaration — the
    // skills a method wires are usually ONLY here (and in `**calls:**` step prose),
    // not as [[wikilinks]]. Add them first so they always render as skill chips.
    for (const s of fmList(h, 'calls-skills')) {
      if (s && !seen.has(s)) seen.set(s, { name: s, kind: 'skill' })
    }
    for (const mm of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const leaf = mm[1].split('|')[0].trim().split('/').pop()!.replace('.md', '')
      if (leaf && !seen.has(leaf)) seen.set(leaf, { name: leaf, kind: classifyLink(mm[1]) })
    }
    const stages = (body.match(/^#{2,3}\s/gm) ?? []).length
    methods.push({
      name: fm.name ?? fm.title ?? rel.split('/').pop()!.slice(0, -3),
      desc: (fm.description ?? '').slice(0, 160),
      kind: 'method',
      path: rel,
      wires: [...seen.values()],
      stages,
      ...(fm['task-kind'] ? { taskKind: fm['task-kind'] } : {}),
      ...(fm['deliverable'] ? { deliverable: fm['deliverable'] } : {})
    })
  }

  return { methods, skills, agents }
}

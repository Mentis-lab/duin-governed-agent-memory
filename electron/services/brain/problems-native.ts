// problems-native — TS port of server.py:list_problems. The open-loop register:
// live PROBLEMS (🧩) / open RISKS (⚠️) / owed DECISIONS (🧭) parsed from
// `05 Decisions/_Owed-Decisions.md`, plus graduated standalone type:risk|problem files.
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const PILLARS = ['DUIN/Decisions', '05 Decisions']
const PROBLEM_SECTIONS: Record<string, string[]> = {
  problem: ['problems', '🧩'],
  risk: ['risks', '⚠️'],
  owed: ['owed decisions', '🧭']
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
/** First existing decisions-pillar dir (else the first candidate). */
function decisionsPillar(base: string): string {
  return PILLARS.map((c) => join(base, c)).find(isDir) ?? join(base, PILLARS[0])
}
const rel = (base: string, p: string): string => relative(base, p).replace(/\\/g, '/')
function fmOf(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
function fmKv(fm: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const ln of fm.split('\n')) {
    const i = ln.indexOf(':')
    if (i > 0 && !ln.trimStart().startsWith('#')) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
  }
  return kv
}

interface ProblemNode {
  id: string
  kind: string
  title: string
  meta: string
  state: string
  source: string
  detail: string
  links: string[]
  graduated: boolean
  path: string
}

export function listProblems(vaultDir: string | null): { nodes: ProblemNode[]; counts: Record<string, number>; register: string } {
  const empty = { nodes: [], counts: { problem: 0, risk: 0, owed: 0 }, register: '' }
  if (!vaultDir) return empty
  const base = vaultDir
  const pillar = decisionsPillar(base)
  const reg = join(pillar, '_Owed-Decisions.md')
  const regRel = rel(base, reg)
  const nodes: ProblemNode[] = []

  if (existsSync(reg)) {
    const text = readFileSync(reg, 'utf-8')
    for (const sec of text.split(/^##\s+/m).slice(1)) {
      const head = (sec.split('\n')[0] || '').toLowerCase()
      const kind = Object.entries(PROBLEM_SECTIONS).find(([, keys]) => keys.some((x) => head.includes(x)))?.[0]
      if (!kind) continue
      for (const blk of sec.split(/\n(?=- \*\*)/)) {
        const m = /^- \*\*([PRD]\d+)\s*[·.]\s*(.+?)\*\*\s*[—-]+\s*(.*)/.exec(blk)
        if (!m) continue
        const [, nid, title, meta] = m
        const detail = blk
          .split('\n')
          .slice(1)
          .filter((ln) => ln.trim())
          .map((ln) => ln.trim().replace(/^[-\s]+/, ''))
          .join('\n')
        const tokens = [...meta.matchAll(/`([^`]+)`/g)].map((x) => x[1])
        const links = [...blk.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1].split('|')[0].trim())
        nodes.push({ id: nid, kind, title: title.trim(), meta: meta.trim(), state: tokens[0] ?? '', source: tokens[1] ?? '', detail, links, graduated: false, path: regRel })
      }
    }
  }

  // graduated standalone risk/problem files
  if (isDir(pillar)) {
    const ddRel = rel(base, pillar)
    for (const fn of readdirSync(pillar).sort()) {
      if (!fn.endsWith('.md') || fn.startsWith('_')) continue
      let h: string
      try {
        h = readFileSync(join(pillar, fn), 'utf-8').slice(0, 1200)
      } catch {
        continue
      }
      const t = /^type:\s*(risk|problem)\b/m.exec(fmOf(h))
      if (t) {
        const fm = fmKv(fmOf(h))
        nodes.push({
          id: fm.id ?? fn.slice(0, -3),
          kind: t[1],
          title: fm.title ?? fn.slice(0, -3),
          meta: fm.status ?? '',
          state: fm.state ?? fm.status ?? '',
          source: fm.source ?? '',
          detail: fm.description ?? '',
          links: [],
          graduated: true,
          path: `${ddRel}/${fn}`
        })
      }
    }
  }

  const counts = { problem: 0, risk: 0, owed: 0 }
  for (const n of nodes) if (n.kind in counts) counts[n.kind as keyof typeof counts]++
  return { nodes, counts, register: regRel }
}

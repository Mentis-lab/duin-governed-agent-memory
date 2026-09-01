// Native port of resources/brain/server.py :: list_okrs() (server.py 5311-5350)
// plus its leaf helpers _okr_state (5305) and _slug (4674).
//
// Deep per-project OKRs read from '… OKR Tracker' markdown files (the layer below
// GOALS.md's strategic tracks): each `## O<n> <name>` objective becomes a `goal`
// node under its project; each `### KR<n> —【title】` becomes a `kr` node carrying
// status / state / progress / owner / due parsed from the KR's table cells.
//
// This is a prereq leaf for the brain-graph merge (build_brain_graph adds these
// nodes directly). Kept pure + unit-testable — no SQLite, no route wiring.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { arenaDirs } from './throughput'

export interface OkrGoal {
  kind: 'goal'
  id: string
  title: string
  project: string
  parent: string
  desc: string
}
export interface OkrKr {
  kind: 'kr'
  id: string
  title: string
  project: string
  parent: string
  status: string
  state: string
  progress: string
  owner: string
  due: string
}
export type OkrNode = OkrGoal | OkrKr

/** Port of server.py::_slug — substitute non-alnum runs → '-', strip edge '-',
 *  lowercase, cap 48, default 'output'. Order matches Python exactly. */
function slugPy(s: string): string {
  const r = String(s)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48)
  return r || 'output'
}

/** Port of server.py::_okr_state — first emoji present wins, in this order. */
function okrState(status: string): string {
  const s = status || ''
  if (s.includes('🔴')) return 'blocked'
  if (s.includes('✅')) return 'done'
  if (s.includes('🟡')) return 'risk'
  if (s.includes('🟢')) return 'on'
  return 'todo'
}

// Basename match for Python glob's case-insensitive `*OKR*Tracker*.md` (fnmatch on
// Windows normalizes case). "OKR" then "Tracker" then ".md", anything between.
const OKR_FILE = /okr.*tracker.*\.md$/i

/** Recursive pre-order collect mirroring Python recursive glob of the pattern
 *  `<root>` + slash + double-star + slash + `*OKR*Tracker*.md`:
 *  at each directory yield its matching files first (readdir /
 *  scandir order, unsorted to match NTFS/scandir), then descend into subdirs in the
 *  same order. Hidden entries (name starts with '.') are skipped, exactly as glob's
 *  default (include_hidden=False) does for both `*` and `**`. */
function globOkrTrackers(root: string): string[] {
  const out: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) subdirs.push(e.name)
    else if (OKR_FILE.test(e.name)) out.push(join(root, e.name))
  }
  for (const sd of subdirs) out.push(...globOkrTrackers(join(root, sd)))
  return out
}

interface RxHit {
  index: number
  end: number
  groups: string[]
}
/** Run a global regex over `text`, returning each match's start/end offsets and
 *  capture groups. Mirrors Python re.finditer + match.start()/.end(). */
function finditer(re: RegExp, text: string): RxHit[] {
  const hits: RxHit[] = []
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = g.exec(text)) !== null) {
    hits.push({ index: m.index, end: m.index + m[0].length, groups: m.slice(1) as string[] })
    if (m.index === g.lastIndex) g.lastIndex++ // guard against zero-width loops
  }
  return hits
}

/** Native list_okrs. `vaultDir` is HARNESS_DIR. */
export function listOkrs(vaultDir: string | null): OkrNode[] {
  const out: OkrNode[] = []
  if (!vaultDir) return out

  // Python: glob 03 Projects first, then per-arena (arena order = sorted).
  const paths: string[] = [...globOkrTrackers(join(vaultDir, '03 Projects'))]
  for (const a of arenaDirs(vaultDir)) paths.push(...globOkrTrackers(join(vaultDir, a)))

  const OBJ = /^##\s+O(\d+)\s+(.+?)\s*$/gm
  const KR = /^###\s+KR(\d+)\s*[—-]+\s*【(.+?)】(.*)$/gm
  const PROJECT = /^project:\s*(.+)$/m
  const OBJSTMT = /\*\*Objective[：:]\*\*\s*(.+)/

  for (const fp of paths) {
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch {
      continue
    }
    const pm = PROJECT.exec(text.slice(0, 800))
    const project = pm ? pm[1].trim() : ''

    const objHeads = finditer(OBJ, text)
    for (let i = 0; i < objHeads.length; i++) {
      const om = objHeads[i]
      const onum = om.groups[0]
      const oname = om.groups[1].trim()
      const oblock = text.slice(om.end, i + 1 < objHeads.length ? objHeads[i + 1].index : text.length)
      const ostmt = OBJSTMT.exec(oblock)
      const oid = `okr:${slugPy(project)}-o${onum}`
      out.push({
        kind: 'goal',
        id: oid,
        title: `O${onum} ${oname}`,
        project,
        parent: '',
        desc: (ostmt ? ostmt[1].trim() : '').slice(0, 240)
      })

      const krHeads = finditer(KR, oblock)
      for (let j = 0; j < krHeads.length; j++) {
        const km = krHeads[j]
        const knum = km.groups[0]
        const ktitle = km.groups[1].trim()
        const ktail = km.groups[2].trim()
        const kblock = oblock.slice(km.end, j + 1 < krHeads.length ? krHeads[j + 1].index : oblock.length)
        const cell = (label: string): string => {
          const m = new RegExp('\\*\\*' + label + '\\*\\*\\s*\\|\\s*(.+?)\\s*\\|').exec(kblock)
          return m ? m[1].trim() : ''
        }
        const status = cell('状态')
        out.push({
          kind: 'kr',
          id: `${oid}-kr${knum}`,
          title: `KR${knum} ${ktitle}${ktail ? ' ' + ktail : ''}`,
          project,
          parent: oid,
          status,
          state: okrState(status),
          progress: cell('进度'),
          owner: cell('Owner'),
          due: cell('截止')
        })
      }
    }
  }
  return out
}

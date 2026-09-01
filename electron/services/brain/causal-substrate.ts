// Causal-graph substrate — TS port of server.py:causal_graph() (brain unification,
// the central big rock). causal_graph is an ASSEMBLER over three structured loaders
// (futures/streams, drivers, anchors); this file ports the STREAM half + the shared
// loaders/date-helpers. The anchors half + the full-route assembler follow.
//
// Faithful to the Python: typed nodes (stream/driver/decision/outcome/risk/step) +
// directed edges carrying lag_days + polarity, derived from future-nodes.jsonl.
// Pure given (loaded data, today) → unit-tested against a live Python golden.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { arenaDirs, taskFiles } from './throughput'
import { TASK_ID_FIELD, LEGACY_TASK_ID_FIELD } from './task-fields'
import type { CausalGraph, CausalKind } from './types'
import { messageOf } from '../guarded'

export interface FutureStream {
  id?: string
  title?: string
  objective?: string
  parent_label?: string
  anchor_id?: string
  track?: string
  target?: string
  decision?: string
  decide_by?: string
  status?: string
  cleared?: unknown
  blocked?: unknown
  steps?: { event?: string; when?: string; done?: boolean }[]
}
export interface Driver {
  driver?: string
  explains?: string[]
}
export interface CGNode {
  id: string
  kind: string
  label: string
  [k: string]: unknown
}
export interface CGEdge {
  source: string
  target: string
  type: string
  lag_days: number | null
  polarity: string
  [k: string]: unknown
}

// ──────────────────── loaders (structured .duin/_state files) ────────────────────

function stateDir(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state')
}

export function loadFutures(vaultDir: string | null): FutureStream[] {
  if (!vaultDir) return []
  const read = (file: string): FutureStream[] => {
    try {
      return readFileSync(join(stateDir(vaultDir), file), 'utf-8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FutureStream)
    } catch {
      return []
    }
  }
  // authored streams + channel-derived streams (the channel→foresight bridge; TS is the
  // sole writer of channel-futures.jsonl, so no two-writer race on future-nodes.jsonl).
  return [...read('future-nodes.jsonl'), ...read('channel-futures.jsonl')]
}

export function loadDrivers(vaultDir: string | null): Driver[] {
  if (!vaultDir) return []
  try {
    // paths.P.drivers_cache → .duin/_state/causal-drivers.json
    const j = JSON.parse(readFileSync(join(stateDir(vaultDir), 'causal-drivers.json'), 'utf-8')) as {
      drivers?: Driver[]
    }
    return j.drivers ?? []
  } catch {
    return []
  }
}

// ──────────────────── date helpers (faithful ports) ────────────────────

/** Parse 'YYYY-MM-DD' or 'YYYY-MM' (→ 1st) to a UTC Date; else null. Mirrors
 *  the inner _p() of server.py:_days_between. */
function parseDay(s: unknown): Date | null {
  const str = String(s ?? '')
  for (const [n, mode] of [[10, 'd'], [7, 'm']] as const) {
    const slice = str.slice(0, n)
    const iso = mode === 'm' ? `${slice}-01` : slice
    if ((mode === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(slice)) || (mode === 'm' && /^\d{4}-\d{2}$/.test(slice))) {
      const d = new Date(iso + 'T00:00:00Z')
      if (!isNaN(d.getTime())) return d
    }
  }
  return null
}

/** Days between two date strings (a→b), or null if either unparseable. */
export function daysBetween(a: string, b: string): number | null {
  const da = parseDay(a)
  const db = parseDay(b)
  if (!da || !db) return null
  return Math.floor((db.getTime() - da.getTime()) / 86400000)
}

/** Tolerant deadline: 'YYYY-MM-DD' → that date; 'YYYY-MM' → LAST day of month;
 *  else null. Port of server.py:_parse_deadline. */
export function parseDeadline(s: unknown): Date | null {
  if (!s || typeof s !== 'string') return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + 'T00:00:00Z')
    return isNaN(d.getTime()) ? null : d
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number)
    return new Date(Date.UTC(y, m, 0)) // day 0 of next month = last day of this month
  }
  return null
}

// ──────────────────── stream-half assembler ────────────────────

/** Build the STREAM portion of the causal graph — faithful to the
 *  `for s in _load_futures()` loop of server.py:causal_graph. `today` injectable. */
export function buildStreamGraph(
  futures: FutureStream[],
  drivers: Driver[],
  today: Date = new Date()
): { nodes: CGNode[]; edges: CGEdge[] } {
  const nodes = new Map<string, CGNode>()
  const edges: CGEdge[] = []
  const N = (id: string, kind: string, label: string, kw: Record<string, unknown> = {}): string => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label: (label || '').slice(0, 80), ...kw })
    return id
  }
  const E = (
    source: string,
    target: string,
    type: string,
    lag: number | null = null,
    polarity = '+',
    kw: Record<string, unknown> = {}
  ): void => {
    edges.push({ source, target, type, lag_days: lag, polarity, ...kw })
  }

  // driver → streams it explains
  const dmap = new Map<string, string[]>()
  for (const d of drivers) {
    for (const sid of d.explains ?? []) {
      const arr = dmap.get(sid) ?? []
      arr.push(d.driver ?? '')
      dmap.set(sid, arr)
    }
  }

  for (const s of futures) {
    const sid = s.id || s.title || ''
    if (!sid) continue
    const conf = (s.track || '') === 'personal'
    const snode = N(`stream:${sid}`, 'stream', s.title || s.objective || '', {
      track: s.track ?? '',
      date: s.target ?? '',
      confidential: conf,
      anchor_id: s.anchor_id ?? ''
    })
    const pl = (s.parent_label || '').trim()
    const dnames = dmap.get(sid) ?? (pl ? [pl] : [])
    for (const dn of dnames) {
      E(N(`driver:${dn}`, 'driver', dn, { track: s.track ?? '', inferred: true }), snode, 'drives')
    }
    const dby = s.decide_by || ''
    let prev: string | null = null
    let lastWhen: string = dby
    if (dby) {
      const dl = parseDeadline(dby)
      const dnode = N(`decision:${sid}`, 'decision', s.decision || `decide: ${s.title || ''}`, {
        track: s.track ?? '',
        date: dby,
        overdue: !!(dl && dl.getTime() < today.getTime())
      })
      E(dnode, snode, 'gates', daysBetween(dby, s.target ?? ''))
      if (s.cleared && s.blocked) {
        E(dnode, N(`outcome:${sid}:cleared`, 'outcome', String(s.cleared), { track: s.track ?? '' }), 'if_cleared', null, '+', { branch: true })
        E(dnode, N(`outcome:${sid}:blocked`, 'risk', String(s.blocked), { track: s.track ?? '' }), 'if_blocked', null, '-', { branch: true })
      }
      prev = dnode
    }
    const steps = s.steps ?? []
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]
      const when = st.when ?? ''
      const stid = N(`step:${sid}:${i}`, 'step', st.event ?? '', {
        track: s.track ?? '',
        date: when,
        done: !!st.done
      })
      if (prev) E(prev, stid, 'requires', lastWhen && when ? daysBetween(lastWhen, when) : null)
      prev = stid
      lastWhen = when || lastWhen
    }
    if (prev && !prev.startsWith('decision:')) {
      E(prev, snode, 'enables', lastWhen && s.target ? daysBetween(lastWhen, s.target) : null)
    }
    // fold the stream internals onto the stream node
    const node = nodes.get(snode)!
    node.decide_by = dby
    node.decision_id = dby ? `decision:${sid}` : ''
    node.fork =
      s.cleared && s.blocked
        ? { cleared: String(s.cleared).slice(0, 120), blocked: String(s.blocked).slice(0, 120) }
        : null
    node.steps = steps
      .slice(0, 8)
      .map((st) => ({ event: (st.event || '').slice(0, 60), when: st.when ?? '', done: !!st.done }))
  }

  return { nodes: [...nodes.values()], edges }
}

// ──────────────────── anchor decls (Level 1: nodes + dep/resource/feeds) ────────────────────

export interface AnchorDecl {
  id: string
  name: string
  kind: string
  date: string
  window_end: string
  immovable: boolean
  track: string
  attendees: string[]
  binds_contexts: string[]
  binds_tags: string[]
  binds_keywords: string[]
  binds_ids: string[]
  depends_on: string[]
  exclude_contexts: string[]
  aliases: string[]
  builds_toward: string
  confidential: boolean
  doc: string
}

const PLANNING_PILLARS = ['DUIN/Planning', '04 Notes']
const dirOK = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const listDir = (p: string): string[] => {
  try {
    return readdirSync(p).sort()
  } catch {
    return []
  }
}
const _slug = (s: string): string =>
  ((s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48) || 'output')

/** Parse `(C) anchor-*.md` decls with `type: anchor` frontmatter. Faithful to
 *  server.py:_read_anchor_decls — lightweight FM parse (no YAML dep). */
export function readAnchorDecls(vaultDir: string | null): AnchorDecl[] {
  if (!vaultDir) return []
  const base = vaultDir
  const paths: string[] = []
  const glob = (dir: string): void => {
    for (const f of listDir(dir)) {
      if (f.startsWith('(C) anchor-') && f.endsWith('.md')) paths.push(join(dir, f))
    }
  }
  const proj = join(base, '03 Projects')
  if (dirOK(proj)) for (const d of listDir(proj)) glob(join(proj, d))
  for (const a of arenaDirs(base)) glob(join(base, a))
  const planning = PLANNING_PILLARS.map((c) => join(base, c)).find(dirOK) ?? join(base, PLANNING_PILLARS[0])
  glob(join(planning, '_system'))

  const decls: AnchorDecl[] = []
  for (const p of [...new Set(paths)].sort()) {
    let txt: string
    try {
      txt = readFileSync(p, 'utf-8')
    } catch {
      continue
    }
    const t2 = txt.charCodeAt(0) === 0xFEFF ? txt.slice(1) : txt
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(t2)
    if (!m) continue
    const fm: Record<string, string> = {}
    for (const ln of m[1].split('\n')) {
      if (!ln.includes(':') || ln.trimStart().startsWith('#')) continue
      const i = ln.indexOf(':')
      fm[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
    }
    if (fm.type !== 'anchor') continue
    const lst = (k: string): string[] =>
      (fm[k] || '').split(',').map((x) => x.trim()).filter(Boolean)
    decls.push({
      id: fm['anchor-id'] || _slug(fm.name || 'anchor'),
      name: fm.name || '',
      kind: fm.kind || 'milestone',
      date: fm.date || '',
      window_end: fm['window-end'] || '',
      immovable: (fm.immovable || 'false').toLowerCase() === 'true',
      track: fm.track || '',
      attendees: lst('attendees'),
      binds_contexts: lst('binds-contexts'),
      binds_tags: lst('binds-tags').map((t) => t.replace(/^#/, '')),
      binds_keywords: lst('binds-keywords'),
      binds_ids: lst('binds-ids'),
      depends_on: lst('depends-on'),
      exclude_contexts: lst('exclude-contexts'),
      aliases: lst('aliases'),
      builds_toward: (fm['builds-toward'] || '').trim(),
      confidential: (fm.confidential || 'false').toLowerCase() === 'true',
      doc: relative(base, p).replace(/\\/g, '/')
    })
  }
  // channel-derived anchors (the channel→foresight bridge; TS sole writer of the jsonl).
  try {
    for (const l of readFileSync(join(stateDir(base), 'channel-anchors.jsonl'), 'utf-8').split(/\r?\n/)) {
      if (l.trim()) decls.push(JSON.parse(l) as AnchorDecl)
    }
  } catch (e) { console.debug('[causal-substrate] no channel anchors:', messageOf(e)) }
  return decls
}

// ──────────────────── task layer (Level 2: gate nodes = critical path) ────────────────────

export interface Task {
  id: string
  text: string
  done: boolean
  status: string
  priority: string
  due: string
  tags: string[]
  people: string[]
  contexts: string[]
  project: string
  source: string
  line: number
}

const TASK_LINE = /^\s*- \[([ xX])\]\s*(.*)$/
const TASK_FIELD = /\{\{(\w+)::\s*([^}]*)\}\}/g
const GENERIC_CTX = new Set(['ProjectA发行', 'ProjectAai', 'ProjectA情报', 'ProjectA'])

/** Parse one `- [ ] … {{key:: val}} #tag @person` line into a card. Pure port of
 *  server.py:parse_task_line. Returns null for non-task lines. */
export function parseTaskLine(line: string, source: string, idx: number): Task | null {
  const m = TASK_LINE.exec(line)
  if (!m) return null
  const done = m[1].toLowerCase() === 'x'
  const rest = m[2]
  const fields: Record<string, string> = {}
  for (const fm of rest.matchAll(TASK_FIELD)) fields[fm[1]] = fm[2].trim()
  const clean = rest.replace(TASK_FIELD, '')
  const tags = [...clean.matchAll(/#([^\s#]+)/g)].map((x) => x[1])
  const people = [...clean.matchAll(/@([^\s@]+)/g)].map((x) => x[1].replace(/[)}\];,.，。、]+$/, ''))
  const contexts = (fields.contexts || '').split(';').map((c) => c.trim()).filter(Boolean)
  const text = clean
    .replace(/#\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/[📩📅✅🔁⏳]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-—|]+|[\s\-—|]+$/g, '')
  const status = (fields.status || '').replace('Project.', '').trim() || (done ? 'Done' : 'Inbox')
  let project = ''
  if (source.startsWith('03 Projects/')) project = source.split('/')[1]
  else if (source.startsWith('06 Tasks/') || source.startsWith('DUIN/Tasks/'))
    project = source.split('/').pop()!.slice(0, -3)
  else if (source.endsWith('/Tasks.md') || /\/Tasks-\d+\.md$/.test(source)) project = source.split('/')[0]
  return {
    id: fields[TASK_ID_FIELD] ?? fields[LEGACY_TASK_ID_FIELD] ?? `${source}#${idx}`,
    text: (text.slice(0, 220) || '(untitled task)'),
    done,
    status,
    priority: fields.priority || '',
    due: fields.dateDue || '',
    tags: tags.slice(0, 6),
    people: people.slice(0, 6),
    contexts: contexts.slice(0, 6),
    project,
    source,
    line: idx
  }
}

/** FULL task dict matching server.py:parse_task_line's return EXACTLY (incl. movable /
 *  estimate / assignees + Python key order) — for surfaces that serialize the whole task
 *  (e.g. /state/conversations followups). parseTaskLine returns a reduced subset; this is
 *  the byte-parity form. Reuses the same TASK_LINE/TASK_FIELD parse. */
export interface TaskFull {
  id: string
  movable: boolean
  text: string
  done: boolean
  status: string
  priority: string
  due: string
  estimate: string
  assignees: string
  tags: string[]
  people: string[]
  contexts: string[]
  project: string
  source: string
  line: number
}
export function parseTaskFull(line: string, source: string, idx: number): TaskFull | null {
  const m = TASK_LINE.exec(line)
  if (!m) return null
  const done = m[1].toLowerCase() === 'x'
  const rest = m[2]
  const fields: Record<string, string> = {}
  for (const fm of rest.matchAll(TASK_FIELD)) fields[fm[1]] = fm[2].trim()
  const clean = rest.replace(TASK_FIELD, '')
  const tags = [...clean.matchAll(/#([^\s#]+)/g)].map((x) => x[1])
  const people = [...clean.matchAll(/@([^\s@]+)/g)].map((x) => x[1].replace(/[)}\];,.，。、]+$/, ''))
  const contexts = (fields.contexts || '').split(';').map((c) => c.trim()).filter(Boolean)
  const text = clean
    .replace(/#\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/[📩📅✅🔁⏳]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-—|]+|[\s\-—|]+$/g, '')
  const status = (fields.status || '').replace('Project.', '').trim() || (done ? 'Done' : 'Inbox')
  let project = ''
  if (source.startsWith('03 Projects/')) project = source.split('/')[1]
  else if (source.startsWith('06 Tasks/') || source.startsWith('DUIN/Tasks/')) project = source.split('/').pop()!.slice(0, -3)
  else if (source.endsWith('/Tasks.md') || /\/Tasks-\d+\.md$/.test(source)) project = source.split('/')[0]
  return {
    id: fields[TASK_ID_FIELD] ?? fields[LEGACY_TASK_ID_FIELD] ?? `${source}#${idx}`,
    movable: true,
    text: text.slice(0, 220) || '(untitled task)',
    done,
    status,
    priority: fields.priority || '',
    due: fields.dateDue || '',
    estimate: fields.estimate || '',
    assignees: fields.assignees || '',
    tags: tags.slice(0, 6),
    people: people.slice(0, 6),
    contexts: contexts.slice(0, 6),
    project,
    source,
    line: idx
  }
}

/** True iff a task matches the anchor's DECLARED rules (never date). Port of _anchor_binds. */
export function anchorBinds(t: Task, d: AnchorDecl): boolean {
  const lc = (xs: string[]): Set<string> => new Set(xs.map((x) => x.toLowerCase()))
  const ctx = lc(t.contexts)
  if ([...ctx].some((c) => lc(d.exclude_contexts).has(c))) return false
  if (t.id && d.binds_ids.includes(t.id)) return true
  if ([...ctx].some((c) => lc(d.binds_contexts).has(c))) return true
  if ([...lc(t.tags)].some((tg) => lc(d.binds_tags).has(tg))) return true
  const hay = `${t.text} ${t.contexts.join(' ')} ${t.tags.join(' ')} ${t.people.join(' ')}`.toLowerCase()
  return d.binds_keywords.some((kw) => hay.includes(kw.toLowerCase()))
}

/** Branch label = the most specific binding signal. Port of _anchor_branch. */
export function anchorBranch(contexts: string[], tags: string[], d: AnchorDecl): string {
  const own = new Set(d.binds_contexts.map((c) => c.toLowerCase()))
  const nonat = contexts.filter((c) => !c.startsWith('@'))
  for (const c of nonat) if (!own.has(c.toLowerCase()) && !GENERIC_CTX.has(c)) return c
  for (const c of contexts) if (c.startsWith('@')) return c.replace(/^@/, '')
  for (const c of nonat) if (!own.has(c.toLowerCase())) return c
  return tags[0] ?? 'misc'
}

/** Concise task label — the part after the 主项 `|`, truncated. Port of _short_item. */
export function shortItem(text: string): string {
  const parts = text.split(/[|｜]/, 2)
  const t = (parts.length > 1 ? parts[1] : parts[0]).trim().replace(/\s+/g, ' ')
  return t.length > 17 ? t.slice(0, 16) + '…' : t
}

const parseYMD = (s: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}
const dayDiff = (a: Date, b: Date): number => Math.floor((a.getTime() - b.getTime()) / 86400000)

/** Gather open, non-stale tasks from every task file. Port of the anchors() gather
 *  loop: skip done/Dropped, and drop non-P1 tasks >10 days overdue (past residue). */
export function gatherTasks(vaultDir: string | null, today: Date = new Date()): Task[] {
  if (!vaultDir) return []
  const out: Task[] = []
  for (const fp of taskFiles(vaultDir)) {
    let txt: string
    try {
      txt = readFileSync(fp, 'utf-8')
    } catch {
      continue
    }
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    const lines = txt.split(/\r?\n/) // CRLF-tolerant (Python's reader normalizes; JS split('\n') leaves \r)
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], rel, i)
      if (!t || t.done || t.status === 'Dropped') continue
      const td = parseYMD(t.due)
      if (td && dayDiff(today, td) > 10 && String(t.priority) !== '1') continue
      out.push(t)
    }
  }
  return out
}

/** Extend a stream graph with the anchor layer (Level 1: anchor/dependency/
 *  resource nodes + requires/staffs edges + the stream→anchor feeds pass +
 *  builds_toward spine). Gate nodes (critical path) + the anchor risk rollup are
 *  Level 2 (need task binding). Mutates + returns the arrays. */
export function extendWithAnchors(
  nodes: CGNode[],
  edges: CGEdge[],
  decls: AnchorDecl[],
  tasks: Task[] = [],
  today: Date = new Date()
): { nodes: CGNode[]; edges: CGEdge[] } {
  const map = new Map(nodes.map((n) => [n.id, n]))
  const N = (id: string, kind: string, label: string, kw: Record<string, unknown> = {}): string => {
    if (!map.has(id)) map.set(id, { id, kind, label: (label || '').slice(0, 80), ...kw })
    return id
  }
  const E = (source: string, target: string, type: string, lag: number | null = null, kw: Record<string, unknown> = {}): void => {
    edges.push({ source, target, type, lag_days: lag, polarity: '+', ...kw })
  }

  for (const a of decls) {
    if (a.confidential) continue
    // bind tasks → per-branch state → rolled-up risk (worst)
    const bound = tasks.filter((t) => anchorBinds(t, a))
    const branchState = new Map<string, { overdue: number; p1_overdue: number }>()
    for (const t of bound) {
      const bk = anchorBranch(t.contexts, t.tags, a)
      const st = branchState.get(bk) ?? { overdue: 0, p1_overdue: 0 }
      const d = parseYMD(t.due)
      if (d && dayDiff(today, d) > 0) {
        st.overdue++
        if (String(t.priority) === '1') st.p1_overdue++
      }
      branchState.set(bk, st)
    }
    let worst = 'green'
    for (const st of branchState.values()) {
      const state = st.p1_overdue ? 'red' : st.overdue ? 'amber' : 'green'
      if (state === 'red') {
        worst = 'red'
        break
      }
      if (state === 'amber') worst = 'amber'
    }
    const an = N(`anchor:${a.id}`, 'anchor', a.name, {
      track: a.track,
      date: a.date,
      immovable: a.immovable,
      risk: worst
    })
    // critical path → gate nodes (Level 2)
    const crit = [...bound].sort((x, y) => ((x.due || '~') < (y.due || '~') ? -1 : 1)).slice(0, 12)
    for (const c of crit) {
      const d = parseYMD(c.due)
      const slack = d ? dayDiff(d, today) : null
      const tid = N(`task:${c.id}`, 'gate', shortItem(c.text), {
        track: a.track,
        date: c.due,
        branch: anchorBranch(c.contexts, c.tags, a),
        slack
      })
      E(tid, an, 'requires', slack)
    }
    for (const dep of a.depends_on) E(N(`dep:${dep}`, 'dependency', dep), an, 'requires')
    for (const who of a.attendees) E(N(`res:${who}`, 'resource', who), an, 'staffs')
  }

  // feeds: explicit (stream.anchor_id → anchor), then fuzzy (bind-key in label), + builds_toward spine.
  const boundStreams = new Set<string>()
  for (const [nid, n] of map) {
    if (n.kind === 'stream' && n.anchor_id) {
      const aid = `anchor:${String(n.anchor_id)}`
      if (map.has(aid)) {
        E(nid, aid, 'feeds', null, { explicit: true })
        boundStreams.add(nid)
      }
    }
  }
  for (const d of decls) {
    if (d.confidential) continue
    const aid = `anchor:${d.id}`
    if (!map.has(aid)) continue
    const keys = [...d.binds_contexts, ...d.binds_keywords, ...d.aliases]
      .filter(Boolean)
      .map((k) => k.toLowerCase())
      .filter((k) => k.length >= 2) // drop 1-char keys that substring-match nearly anything
    for (const [nid, n] of map) {
      if (boundStreams.has(nid)) continue
      if (n.kind === 'stream' && keys.some((k) => labelMatchesKey(String(n.label || ''), k))) {
        // Fuzzy keyword bind — a HYPOTHESIS, not an explicit link. Tagged `inferred`
        // so it can't (alone) manufacture a convergence claim downstream.
        E(nid, aid, 'feeds', null, { inferred: true })
      }
    }
    if (d.builds_toward && map.has(`anchor:${d.builds_toward}`)) {
      E(aid, `anchor:${d.builds_toward}`, 'builds_toward', daysBetween(d.date, String(map.get(`anchor:${d.builds_toward}`)!.date ?? '')))
    }
  }

  return { nodes: [...map.values()], edges }
}

// A fuzzy bind-key matches a stream label by WORD BOUNDARY for ASCII keys (so a
// short latin key like "ai" doesn't substring-match "email"/"maintain"), and by
// substring for keys containing CJK (which have no word boundaries and whose
// substrings are meaningful). This is the guard that keeps coincidental keyword
// overlap from fabricating a `feeds` edge.
const HAS_CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/
export function labelMatchesKey(label: string, key: string): boolean {
  const hay = label.toLowerCase()
  if (HAS_CJK.test(key)) return hay.includes(key)
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${esc}\\b`).test(hay)
}

// ──────────────────── calibration index → edge confidence ────────────────────

interface CalIndex {
  patterns: Record<string, number>
  subjects: Record<string, string>
}

/** Per-pattern hit-rate + per-subject verdict from the calibration ledgers.
 *  Port of _calibration_index. */
export function loadCalibrationIndex(vaultDir: string | null): CalIndex {
  const idx: CalIndex = { patterns: {}, subjects: {} }
  if (!vaultDir) return idx
  const sd = stateDir(vaultDir)
  try {
    const fr = JSON.parse(readFileSync(join(sd, 'forecast-track-record.json'), 'utf-8')) as {
      patterns?: Record<string, { hit_rate?: number | null }>
    }
    for (const [k, p] of Object.entries(fr.patterns ?? {})) if (p?.hit_rate != null) idx.patterns[k] = p.hit_rate
  } catch (e) { console.debug('[causal-substrate] no forecast record:', messageOf(e)) }
  try {
    for (const l of readFileSync(join(sd, 'risk-predictions.jsonl'), 'utf-8').split(/\r?\n/)) {
      if (!l.trim()) continue
      const r = JSON.parse(l) as { verdict?: string; subjects?: string[] }
      if (r.verdict && ['materialized', 'averted', 'passed', 'failed'].includes(r.verdict)) {
        for (const s of r.subjects ?? []) idx.subjects[s] = r.verdict
      }
    }
  } catch (e) { console.debug('[causal-substrate] no pred ledger:', messageOf(e)) }
  return idx
}

const afterColon = (id: string): string => (id || '').split(':').slice(1).join(':')

/** (confidence, evidence) for an edge — earned from the ledger, else prior 0.5.
 *  Port of _edge_confidence. */
export function edgeConfidence(edge: CGEdge, idx: CalIndex): [number, string] {
  const v = idx.subjects[afterColon(edge.source)] ?? idx.subjects[afterColon(edge.target)]
  if (v === 'materialized' || v === 'passed') return [0.85, `validated:${v}`]
  if (v === 'averted') return [0.6, 'validated:averted']
  if (v === 'failed') return [0.3, 'validated:failed']
  const pat = ({ if_cleared: 'decision-window', if_blocked: 'decision-window', requires: 'chain-slippage', gates: 'decision-window' } as Record<string, string>)[edge.type]
  if (pat && idx.patterns[pat] !== undefined) return [Math.round((0.4 + 0.5 * idx.patterns[pat]) * 100) / 100, `pattern:${pat}`]
  return [0.5, 'prior']
}

// ──────────────────── the full causal_graph route response ────────────────────

export interface CausalGraphResponse {
  nodes: CGNode[]
  edges: CGEdge[]
  anchor: string | null
  critical_path_edges: CGEdge[]
  roadmap: Record<string, unknown>[]
  today: string
  stats: { nodes: number; edges: number; converge_nodes: number }
  note: string
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10)

const NOTE =
  'P0 derived causal graph — edges carry lag(days)+polarity; branch=decision out-edges; ' +
  'converge=in_degree>=2; time on edges not layout. Edges are hypotheses (P2 earns ' +
  'confidence from the calibration ledger).'

/** The full `/state/causal-graph` response — decorates the substrate with
 *  in_degree/converges, edge confidence, roadmap spine, stats, and the optional
 *  anchor-funnel filter. Faithful to server.py:causal_graph. */
export function causalGraph(vaultDir: string | null, anchorId = '', today: Date = new Date()): CausalGraphResponse {
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const { nodes, edges } = buildCausalGraph(vaultDir, t0)

  const indeg = new Map<string, number>()
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  for (const n of nodes) {
    n.in_degree = indeg.get(n.id) ?? 0
    // Convergence stays in_degree>=2. Coincidental convergence is prevented UPSTREAM
    // by the stronger `labelMatchesKey` (word-boundary + min-length) that gates which
    // fuzzy `feeds` edges exist at all — not by discounting the edges after the fact,
    // which would also erase the legitimate cold-start channel convergence. Fuzzy
    // feeds still carry `inferred:true` so the UI can mark them as hypotheses.
    n.converges = (indeg.get(n.id) ?? 0) >= 2
  }
  const cal = loadCalibrationIndex(vaultDir)
  for (const e of edges) {
    const [c, ev] = edgeConfidence(e, cal)
    e.confidence = c
    e.evidence = ev
  }

  const decls = new Map(readAnchorDecls(vaultDir).map((d) => [d.id, d]))
  const road: Record<string, unknown>[] = []
  for (const n of nodes) {
    if (!n.id.startsWith('anchor:')) continue
    const d = decls.get(n.id.split(':').slice(1).join(':'))
    if (d?.confidential) continue
    road.push({
      id: n.id,
      name: n.label,
      date: n.date ?? '',
      kind: d?.kind ?? 'anchor',
      risk: n.risk,
      track: n.track ?? '',
      in_degree: n.in_degree ?? 0,
      days_out: daysBetween(isoOf(t0), String(n.date ?? '')),
      builds_toward: d?.builds_toward ?? ''
    })
  }
  road.sort((a, b) => (String(a.date || '~') < String(b.date || '~') ? -1 : 1))

  let outNodes = nodes
  let outEdges = edges
  let crit: CGEdge[] = []
  if (anchorId) {
    const root = `anchor:${anchorId}`
    if (nodes.some((n) => n.id === root)) {
      const radj = new Map<string, string[]>()
      for (const e of edges) {
        const arr = radj.get(e.target) ?? []
        arr.push(e.source)
        radj.set(e.target, arr)
      }
      const keep = new Set([root])
      const frontier = [root]
      while (frontier.length) {
        for (const src of radj.get(frontier.pop()!) ?? []) if (!keep.has(src)) {
          keep.add(src)
          frontier.push(src)
        }
      }
      outNodes = nodes.filter((n) => keep.has(n.id))
      outEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
      crit = outEdges
        .filter((e) => e.type === 'requires' && e.lag_days != null)
        .sort((a, b) => (a.lag_days ?? 0) - (b.lag_days ?? 0))
        .slice(0, 8)
    }
  }
  return {
    nodes: outNodes,
    edges: outEdges,
    anchor: anchorId || null,
    critical_path_edges: crit,
    roadmap: road,
    today: isoOf(t0),
    stats: { nodes: outNodes.length, edges: outEdges.length, converge_nodes: outNodes.filter((n) => n.converges).length },
    note: NOTE
  }
}

/** Full causal-graph substrate = stream half + anchor Level 1. (Level 2 gates +
 *  the causal_graph decorations follow.) */
export function buildCausalGraph(vaultDir: string | null, today: Date = new Date()): { nodes: CGNode[]; edges: CGEdge[] } {
  // Normalize to the calendar day at UTC midnight — Python's date.today() has no
  // time, so a day-floor against `new Date()` (which carries the current time)
  // would push slack one day off.
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const s = buildStreamGraph(loadFutures(vaultDir), loadDrivers(vaultDir), t0)
  const decls = vaultDir ? readAnchorDecls(vaultDir) : []
  return extendWithAnchors(s.nodes, s.edges, decls, gatherTasks(vaultDir, t0), t0)
}

/**
 * Adapt the fs-native Stack-B graph to the Stack-A `CausalGraph` shape so `propagateGraph` can run
 * over it — the two-brain fuse. CGNode's `[k]` bag already carries slack/track; we surface exactly
 * the fields propagate reads (id/label/kind/slack + edge source/target/type).
 */
export function substrateCausalGraph(vaultDir: string | null, today: Date = new Date()): CausalGraph {
  const { nodes, edges } = buildCausalGraph(vaultDir, today)
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind as CausalKind,
      label: n.label,
      slack: typeof n.slack === 'number' ? n.slack : null,
      ...(typeof n.track === 'string' ? { track: n.track } : {}),
      // fields the insights engine + digest read (present in the CGNode bag)
      ...(typeof n.in_degree === 'number' ? { in_degree: n.in_degree } : {}),
      ...(typeof n.converges === 'boolean' ? { converges: n.converges } : {}),
      ...(typeof n.decide_by === 'string' && n.decide_by ? { decide_by: n.decide_by } : {}),
      ...(typeof n.date === 'string' ? { date: n.date } : {}),
      ...(n.fork && typeof n.fork === 'object' ? { fork: n.fork as { cleared: string; blocked: string } } : {})
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      lag_days: e.lag_days,
      ...(e.polarity === '+' || e.polarity === '-' ? { polarity: e.polarity } : {})
    }))
  }
}

// Native port of the resources/brain/server.py _convergence_pool loaders (§4b) —
// the six weighted evidence-layer sources + the pool assembly. Ported bottom-up and
// verified byte-exact against the Python oracle on the live dogfood vault via the
// python-import dump-and-diff method (read-only).
//
// Parity subtleties pinned by that method:
//   - Python text-mode reads apply universal-newline translation (\r\n → \n).
//   - Python str slicing/len is by CODE POINT, not UTF-16 unit (sliceCp / cpLen).
//   - pathlib .glob("**/*.md") walks NTFS scandir order (== Node readdirSync order)
//     and INCLUDES dotfiles (unlike the glob module) — so no hidden-file skip here.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, basename, relative, sep } from 'path'
import { arenaDirs } from './throughput'
import { loadTaskCorpus } from './task-corpus-native'
import { revealedRisks } from './world-state-native'
import { messageOf } from '../guarded'

/** One weighted evidence layer: [text, weight]. Matches convergence-native's PoolEntry. */
export type PoolEntry = [string, number]

function readSafe(fp: string): string {
  try {
    return readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return ''
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
/** Code-point length, matching Python len(str). */
function cpLen(s: string): number {
  let n = 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++
  return n
}

/** Python str slicing is by CODE POINT; JS String.slice is by UTF-16 code unit. */
export function sliceCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

/** Python str.splitlines(): splits on the full line-boundary set and yields NO
 *  trailing empty element when the string ends on a boundary. */
export function splitlinesPy(s: string): string[] {
  if (s === '') return []
  // The control characters ARE the spec here: this is Python str.splitlines()' exact
  // line-boundary set (\v \f \x1c \x1d \x1e are boundaries there but not for a JS
  // split('\n')). Narrowing the class would silently diverge from the port.
  // eslint-disable-next-line no-control-regex -- intentional, per the note above.
  const parts = s.split(new RegExp('\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]'))
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** re.sub(r"^---.*?---", "", t, count=1, flags=re.S) — strip a single leading
 *  frontmatter block. `^` anchors at string start (no MULTILINE); `.` spans newlines. */
function stripFirstFrontmatter(t: string): string {
  return t.replace(/^---[\s\S]*?---/, '')
}

// ── _pillar ──────────────────────────────────────────────────────────────────
const PILLAR_CANDIDATES: Record<string, string[]> = {
  decisions: ['DUIN/Decisions', '05 Decisions'],
  knowledge: ['DUIN/Knowledge', '02 Cards'],
  cards: ['DUIN/Knowledge', '02 Cards'],
  instincts: ['DUIN/Instincts', '02 Cards/instincts'],
  tasks: ['DUIN/Tasks', '06 Tasks'],
  raw: ['DUIN/00 Inbox', '00 Raw'],
  planning: ['DUIN/Planning', '04 Notes'],
  notes: ['DUIN/Planning', '04 Notes'],
  action: ['DUIN/Active', '10 Action'],
  rules: ['DUIN/Rules', '09 Rules'],
  templates: ['DUIN/Templates', '07 Templates'],
  agents: ['.duin/agents', '08 Agents'],
  meta: ['DUIN/Meta', '08 Agents']
}
/** Port of _pillar: DUIN arena layout first, else legacy numbered pillar, else the
 *  DUIN candidate (so writes create the DUIN layout). */
function pillarDir(vault: string, name: string): string {
  const cands = PILLAR_CANDIDATES[name] || [name]
  for (const c of cands) if (isDir(join(vault, c))) return join(vault, c)
  return join(vault, cands[0])
}

/** Recursive *.md collector mirroring pathlib Path.glob("**\/*.md"): pre-order
 *  (this dir's files in scandir order, then subdirs in scandir order), dotfiles
 *  INCLUDED, capped. */
function globMdPathlib(root: string, cap: number): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (out.length >= cap) return
    let ents: import('fs').Dirent[]
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of ents) {
      if (e.isDirectory()) subdirs.push(e.name)
      else if (e.name.endsWith('.md')) {
        out.push(join(dir, e.name))
        if (out.length >= cap) return
      }
    }
    for (const sd of subdirs) {
      walk(join(dir, sd))
      if (out.length >= cap) return
    }
  }
  walk(root)
  return out.slice(0, cap)
}

// ── _split_lines (brain_parse.py) ─────────────────────────────────────────────
/** Stripped lines longer than 6 code points, excluding `---` rules. */
export function splitLines(txt: string): string[] {
  const out: string[] = []
  for (const ln of splitlinesPy(txt || '')) {
    const s = ln.trim()
    if (cpLen(s) > 6 && !s.startsWith('---')) out.push(s)
  }
  return out
}

// ── _load_jsonl ───────────────────────────────────────────────────────────────
export function loadJsonl(path: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return out
  }
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      out.push(JSON.parse(ln))
    } catch (e) { console.debug('[futures-pool-native] skip bad row:', messageOf(e)) }
  }
  return out
}

// ── _goals_context ────────────────────────────────────────────────────────────
const GOALS_FILES = ['GOALS.md', '04 Notes/12-week/2026-Q2.md']
export function goalsContext(vaultDir: string | null, maxchars = 1900): string {
  if (!vaultDir) return ''
  const parts: string[] = []
  const me = join(vaultDir, 'me.md')
  if (existsSync(me)) {
    const t = stripFirstFrontmatter(readSafe(me))
    parts.push('### Identity & mission (me.md)\n' + sliceCp(t.trim(), 900))
  }
  for (const rel of GOALS_FILES) {
    const fp = join(vaultDir, rel)
    if (existsSync(fp)) parts.push('### ' + rel + '\n' + sliceCp(readSafe(fp), 1100))
  }
  return sliceCp(parts.join('\n\n'), maxchars)
}

// ── _cards_text ───────────────────────────────────────────────────────────────
/** Long-term memory layer: 02 Cards / DUIN Knowledge titles + descriptions. */
export function cardsText(vaultDir: string | null, cap = 70): string[] {
  if (!vaultDir) return []
  const out: string[] = []
  for (const fp of globMdPathlib(pillarDir(vaultDir, 'knowledge'), cap)) {
    const t = readSafe(fp)
    let title = ''
    let desc = ''
    for (const ln of splitlinesPy(t).slice(0, 18)) {
      if (ln.startsWith('# ') && !title) title = ln.slice(2).trim()
      const m = /^\s*description:\s*["']?(.+?)["']?\s*$/.exec(ln)
      if (m) desc = m[1]
    }
    const stem = basename(fp).replace(/\.[^.]*$/, '')
    const lbl = (title + ' ' + desc).trim() || stem
    if (cpLen(lbl) > 4) out.push(lbl)
  }
  return out
}

// ── _strategy_context ─────────────────────────────────────────────────────────
const STRATEGY_TERMS_SRC =
  '发行|平台|Steam|Xbox|PlayStation|PS5|TapTap|B站|bilibili|iOS|Google ?Play|安卓|海外|出海|launch|marketing' +
  '|买量|市场|用户|营收|上线|多平台|渠道|资源位|首发|定档'
const STRATEGY_TERMS_G = new RegExp(STRATEGY_TERMS_SRC, 'gi')
const STRATEGY_TERMS = new RegExp(STRATEGY_TERMS_SRC, 'i')
const NAME_KW_SRC = '方案|计划|规划|策略|strateg|发行|launch|plan|roadmap|商务|BD'
const NAME_KW_G = new RegExp(NAME_KW_SRC, 'gi')
const STRATEGY_GLOBS_DEFAULT = [
  '03 Projects/ProjectA/**/*.md',
  '08 Goals/**/*.md',
  '03 Projects/PartnerCo/**/*.md',
  '03 Projects/DUIN/**/*.md'
]
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]/

/** Port of _strategy_globs: 08 Goals + every 03 Projects/<dir> + every arena. */
function strategyGlobs(vault: string): string[] {
  let out = ['08 Goals/**/*.md']
  const base = join(vault, '03 Projects')
  try {
    for (const d of readdirSync(base).sort()) {
      if (isDir(join(base, d)) && !d.startsWith('.') && !d.startsWith('_')) out.push(`03 Projects/${d}/**/*.md`)
    }
  } catch {
    out = [...STRATEGY_GLOBS_DEFAULT] // reset on error, but the arena loop below STILL runs (matches Python)
  }
  for (const a of arenaDirs(vault)) out.push(`${a}/**/*.md`)
  return out
}

/** Port of _strategy_context: score project/goal docs by platform-strategy density,
 *  keep the relevant lines of the top maxdocs. */
export function strategyContext(vaultDir: string | null, maxdocs = 3, maxchars = 1700): string {
  if (!vaultDir) return ''
  const base = vaultDir
  const SKIP = ['.obsidian', 'node_modules', '_agui', `${sep}00 Raw${sep}`]
  const cands: [number, string, string][] = []
  for (const pat of strategyGlobs(vaultDir)) {
    const prefix = pat.replace(/\/\*\*\/\*\.md$/, '')
    for (const fp of globMdPathlib(join(base, prefix), Infinity)) {
      if (SKIP.some((s) => fp.includes(s))) continue
      const fname = basename(fp)
      if (fname === 'Tasks.md' || fname.includes('_Owed-Decisions')) continue
      const txt = readSafe(fp)
      const lines = splitlinesPy(txt)
      const checkboxes = lines.filter((ln) => CHECKBOX.test(ln)).length
      if (lines.length && checkboxes / Math.max(lines.length, 1) > 0.4) continue
      const score = (txt.match(STRATEGY_TERMS_G) || []).length + 8 * (fname.match(NAME_KW_G) || []).length
      if (score > 4) cands.push([score, fp, txt])
    }
  }
  cands.sort((a, b) => b[0] - a[0]) // stable in V8 → ties keep glob order (matches Python)
  const out: string[] = []
  for (const [, fp, txt] of cands.slice(0, maxdocs)) {
    const rel = relative(base, fp).replace(/\\/g, '/')
    const keep: string[] = []
    for (const ln of splitlinesPy(txt)) {
      if (!ln.trim() || CHECKBOX.test(ln)) continue
      if (ln.trimStart().startsWith('#') || STRATEGY_TERMS.test(ln)) {
        keep.push(ln.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+$/, ''))
      }
    }
    out.push(`### ${rel}\n` + sliceCp(keep.join('\n'), maxchars))
  }
  return out.join('\n\n')
}

// ── list_tasks capping (pool tasks layer) ────────────────────────────────────
/** The tasks list_tasks returns: full corpus with a 60-per-status cap (so a huge
 *  Done backlog doesn't bloat). The pool only needs text/done of the capped set. */
function cappedTasks(vaultDir: string): { text: string; done: boolean }[] {
  const counts: Record<string, number> = {}
  const capped: { text: string; done: boolean }[] = []
  for (const t of loadTaskCorpus(vaultDir)) {
    counts[t.status] = (counts[t.status] || 0) + 1
    if (counts[t.status] <= 60) capped.push({ text: t.text, done: t.done })
  }
  return capped
}

const DELTAS_REL = ['.duin', '_state', 'world-state-deltas.jsonl']

// ── _convergence_pool ─────────────────────────────────────────────────────────
/** Port of _convergence_pool: the 6 weighted evidence layers (foundation → project
 *  → long-term memory → short-term memory → tasks → risks), keeping non-empty
 *  entries longer than 4 code points. `now` feeds revealed_risks. */
export function convergencePool(vaultDir: string | null, now: Date = new Date()): PoolEntry[] {
  if (!vaultDir) return []
  const layers: PoolEntry[] = []
  for (const t of splitLines(goalsContext(vaultDir))) layers.push([t, 3.0]) // foundation
  for (const t of splitLines(strategyContext(vaultDir))) layers.push([t, 2.5]) // project
  for (const t of cardsText(vaultDir)) layers.push([t, 2.0]) // long-term memory
  for (const d of loadJsonl(join(vaultDir, ...DELTAS_REL))) layers.push([(d.summary as string) || '', 1.5]) // short-term
  try {
    for (const t of cappedTasks(vaultDir)) if (!t.done) layers.push([t.text, 1.0]) // tasks/actions
  } catch (e) { console.debug('[futures-pool-native] parity: list_tasks() wrapped in try/except:', messageOf(e)) }
  try {
    for (const r of revealedRisks(vaultDir, now).risks) layers.push([r.summary || r.title || '', 1.0]) // risks
  } catch (e) { console.debug('[futures-pool-native] parity: revealed_risks() wrapped in try/except:', messageOf(e)) }
  return layers.filter(([x]) => x != null && x !== '' && cpLen(x) > 4)
}

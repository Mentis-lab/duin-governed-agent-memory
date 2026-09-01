// Native port of the resources/brain/server.py loop-artifact READ routes (§4e) —
// the last routes that shelled out to loop_runner.py. Loop EXECUTION is already
// native (loop-scheduler.ts); these are the reads:
//   - list_schedules / _schedule_names — from .duin/loops/loops.yaml directly
//     (replicating loop_runner.py --list --json), so the subprocess is no longer
//     invoked for reads at all.
//   - list_intel / list_documents / read_document_bytes — file walks over the
//     produced artifacts (04 Notes|DUIN/Planning /intel and Outputs/).
//
// (/state/meeting-scan is NOT here — scan_chat_meetings is an LLM route, not a
// loop_runner shell; it's a model-gen concern, deferred separately.)
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative } from 'path'
import yaml from 'js-yaml'
import { atomicWriteFileSync } from '../atomic-write'
import { snapshotToTrash } from '../local-brain/vault-trash'

// Inlined port of loop_runner.py is_due / loop-scheduler.ts isDue (kept local so
// this read-only module doesn't drag in the scheduler's electron-runtime deps).
const DOW = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
function isDue(sch: Record<string, unknown>, lastIso: string | undefined, now: Date): boolean {
  const last = lastIso ? new Date(lastIso) : null
  const lastValid = last && !Number.isNaN(last.getTime()) ? last : null
  if ('every_hours' in sch) {
    const hours = Number(sch.every_hours)
    return !lastValid || now.getTime() - lastValid.getTime() >= hours * 3600_000
  }
  if ('daily_at' in sch) {
    const [hh, mm] = String(sch.daily_at).split(':').map((x) => parseInt(x, 10))
    const target = new Date(now)
    target.setHours(hh || 0, mm || 0, 0, 0)
    return now >= target && (!lastValid || lastValid < target)
  }
  if ('weekly_on' in sch) {
    const dow = DOW.indexOf(String(sch.weekly_on).toLowerCase().slice(0, 3))
    if (dow < 0) return false
    const [hh, mm] = String(sch.at ?? '00:00').split(':').map((x) => parseInt(x, 10))
    const pyDow = (now.getDay() + 6) % 7
    if (pyDow !== dow) return !!lastValid && now.getTime() - lastValid.getTime() >= 7 * 86400_000
    const target = new Date(now)
    target.setHours(hh || 0, mm || 0, 0, 0)
    return now >= target && (!lastValid || lastValid < target)
  }
  return false
}

// ── shared helpers ────────────────────────────────────────────────────────────
function readText(fp: string, maxCp?: number): string {
  try {
    const t = readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return maxCp == null ? t : [...t].slice(0, maxCp).join('')
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
function sliceCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}
function stripEdge(s: string, ch: string): string {
  let a = 0
  let b = s.length
  while (a < b && s[a] === ch) a++
  while (b > a && s[b - 1] === ch) b--
  return s.slice(a, b)
}

const PILLAR_CANDIDATES: Record<string, string[]> = { planning: ['DUIN/Planning', '04 Notes'] }
function pillarDir(vault: string, name: string): string {
  const cands = PILLAR_CANDIDATES[name] || [name]
  for (const c of cands) if (isDir(join(vault, c))) return join(vault, c)
  return join(vault, cands[0])
}

/** re.match(r"^---\n(.*?)\n---", head, re.S) — the frontmatter block or "". */
function fmOf(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
/** Port of _fm_kv: k: v pairs from the frontmatter, values stripped of surrounding quotes. */
function fmKv(head: string): Record<string, string> {
  const d: Record<string, string> = {}
  for (const line of fmOf(head).split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) {
      const k = line.slice(0, i).trim()
      if (k && !k.startsWith('-')) d[k] = stripEdge(stripEdge(line.slice(i + 1).trim(), '"'), "'")
    }
  }
  return d
}
function artifactTitle(txt: string, fm: Record<string, string>, fallback: string): string {
  if (fm.title) return fm.title
  for (const line of txt.split('\n')) if (line.startsWith('# ')) return line.slice(2).trim()
  return fallback
}
/** Map an output's source token to its schedule name. */
function matchSchedule(source: string, names: string[]): string {
  const s = (source || '').toLowerCase().trim()
  if (!s || s === 'manual') return ''
  for (const n of names) {
    const nl = n.toLowerCase()
    if (s === nl || nl.includes(s) || s.includes(nl)) return n
  }
  return ''
}

// ── loops.yaml → schedules ────────────────────────────────────────────────────
interface RawLoop {
  name: string
  enabled?: boolean
  schedule?: Record<string, unknown>
  run?: { executor?: string; target?: string }
  note?: string
}
function loopsPath(vault: string): string {
  return join(vault, '.duin', 'loops', 'loops.yaml')
}

/**
 * Three states that MUST NOT collapse into one value:
 *   - the registry is genuinely empty (no file yet, or `loops:` with nothing under it)
 *   - the file is there but unreadable as a registry (YAML threw, or the top-level
 *     `loops:` key is absent/renamed/not-a-list)
 *   - the registry parsed and has entries
 *
 * The old loadLoopsRaw returned `[]` for all three — a YAML throw was caught and swallowed,
 * and `doc?.loops ?? []` produced `[]` with no exception at all when the top-level key was
 * missing. Every CRUD action then rewrote the whole file from that `[]`, so ONE hand-edit
 * typo in a file whose own header invites hand-editing ("managed via /loops or
 * loop_runner.py") turned the next pause click into a total wipe of every loop definition.
 * Reads may still degrade to an empty list; WRITES must abort instead.
 */
type LoopsLoad = { ok: true; loops: RawLoop[] } | { ok: false; error: string }
function loadLoops(vault: string): LoopsLoad {
  const path = loopsPath(vault)
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    // No file yet is a legitimately empty registry (a fresh vault); anything else — a
    // permission error, a directory in the way — is NOT, and must not license a rewrite.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, loops: [] }
    return { ok: false, error: `cannot read ${path}: ${(err as Error)?.message ?? 'read failed'}` }
  }
  let doc: unknown
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA })
  } catch (err) {
    return { ok: false, error: `loops.yaml is not valid YAML (${(err as Error)?.message ?? 'parse failed'})` }
  }
  // A comments-only / whitespace-only file parses to null — that is the header DUIN itself
  // writes over an empty registry, so it counts as empty rather than as damage.
  if (doc === null || doc === undefined) return { ok: true, loops: [] }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'loops.yaml does not contain a top-level mapping' }
  }
  const raw = (doc as { loops?: unknown }).loops
  // `loops:` with an empty value is an explicit empty registry. Absent entirely (or renamed)
  // is the SILENT variant of the same corruption — no exception, no clue, and previously
  // indistinguishable from empty.
  if (raw === null || raw === undefined) {
    if (!('loops' in (doc as object))) {
      return { ok: false, error: "loops.yaml has no top-level 'loops:' key" }
    }
    return { ok: true, loops: [] }
  }
  if (!Array.isArray(raw)) return { ok: false, error: "loops.yaml's 'loops:' is not a list" }
  return { ok: true, loops: raw as RawLoop[] }
}

/** Read-side view: degrading to an empty list is fine here — nothing is written back. */
function loadLoopsRaw(vault: string): RawLoop[] {
  const r = loadLoops(vault)
  return r.ok ? r.loops : []
}
function loadLoopsState(vault: string): Record<string, string> {
  try {
    const s = JSON.parse(readFileSync(join(vault, '.duin', '_state', 'loops-state.json'), 'utf-8'))
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}
function scheduleStr(sch: Record<string, unknown>): string {
  if ('daily_at' in sch) return `daily@${sch.daily_at}`
  if ('weekly_on' in sch) return `weekly:${sch.weekly_on}@${sch.at ?? '00:00'}`
  if ('every_hours' in sch) return `every:${sch.every_hours}h`
  return String(sch)
}

export interface ScheduleRow {
  name: string
  schedule: string
  executor: string
  target: string
  enabled: boolean
  paused: boolean
  due: boolean
  last: string
  note: string
}
/** Port of list_schedules (== loop_runner --list --json shape). */
export function listSchedules(vaultDir: string | null, now: Date = new Date()): { schedules: ScheduleRow[] } {
  if (!vaultDir) return { schedules: [] }
  const st = loadLoopsState(vaultDir)
  const rows = loadLoopsRaw(vaultDir).map((lp) => {
    const last = st[lp.name] || ''
    const en = lp.enabled ?? true
    const sch = lp.schedule || {}
    const run = lp.run || {}
    return {
      name: lp.name,
      schedule: scheduleStr(sch),
      executor: run.executor ?? '?',
      target: run.target ?? '',
      enabled: en,
      paused: !en,
      due: en ? isDue(sch, last, now) : false,
      last,
      note: lp.note ?? ''
    }
  })
  return { schedules: rows }
}
/** Port of _schedule_names — live loop names for back-linking artifacts. */
export function scheduleNames(vaultDir: string | null): string[] {
  return listSchedules(vaultDir).schedules.map((r) => r.name)
}

const LOOPS_HEADER =
  '# DUIN loops registry — managed via /loops or loop_runner.py (--add/--remove/--pause/--resume).\n' +
  '# Schedule: {daily_at:"HH:MM"} | {weekly_on:dow, at:"HH:MM"} | {every_hours:N}\n' +
  '# Executor: signal | script | duin | brain (=DUIN brain :8765).  Full schema: .duin/skills/loops/SKILL.md\n'

/** Port of loop_runner.py::parse_schedule. Throws on a bad schedule string. */
function parseSchedule(s: string): Record<string, unknown> {
  s = (s || '').trim().toLowerCase()
  if (s.startsWith('every:')) {
    const v = s.slice(s.indexOf(':') + 1).replace(/h+$/, '')
    return { every_hours: v.includes('.') ? parseFloat(v) : parseInt(v, 10) }
  }
  if (s.startsWith('weekly:')) {
    const rest = s.slice(s.indexOf(':') + 1)
    const [dow, at] = [...rest.split('@'), '00:00'].slice(0, 2)
    return { weekly_on: dow, at }
  }
  if (s.startsWith('daily@') || s.startsWith('daily:')) {
    return { daily_at: s.replace('daily@', '').replace('daily:', '') }
  }
  throw new Error(`bad schedule '${s}' — use daily@HH:MM | weekly:dow@HH:MM | every:Nh`)
}

/**
 * Rewrite loops.yaml, preserving the prior bytes first.
 *
 * Two things this must do that the bare writeFileSync did not:
 *  - Preserve + record. A round-trip through yaml.dump is lossy even when it succeeds: every
 *    comment in the file is dropped (the real vault's registry carries authored design
 *    rationale inline), and the caller's `loops` is a re-serialisation, not the user's bytes.
 *    So snapshot the current file into .trash first — same primitive, same JSONL journal the
 *    rest of the vault's overwrites use — and the prior content stays recoverable with a
 *    record of what changed, when, and why. Per vault-trash's own contract, a FAILED snapshot
 *    means the caller must not write.
 *  - Write atomically. A bare writeFileSync can leave a truncated registry if it is
 *    interrupted; the sibling ledger in this directory (binding-store.writeBindings) already
 *    routes through atomicWriteFileSync for exactly this reason.
 */
function writeLoops(vault: string, loops: RawLoop[], reason: string): { ok: boolean; error?: string } {
  const path = loopsPath(vault)
  const body = LOOPS_HEADER + yaml.dump({ loops }, { sortKeys: false, lineWidth: 80, schema: yaml.JSON_SCHEMA })
  if (existsSync(path)) {
    // Skip the snapshot only when the write changes nothing on disk — a no-op rewrite has no
    // prior content to lose, and snapshotting it would just churn .trash.
    let unchanged: boolean
    try {
      unchanged = readFileSync(path, 'utf-8') === body
    } catch {
      unchanged = false
    }
    if (unchanged) return { ok: true }
    const snap = snapshotToTrash(vault, path, 'ui', `loops.yaml rewrite: ${reason}`)
    if (!snap.ok) {
      return { ok: false, error: `refusing to rewrite loops.yaml — could not preserve the prior copy (${snap.error})` }
    }
  }
  try {
    atomicWriteFileSync(path, body, 0o644)
  } catch (err) {
    return { ok: false, error: `failed to write loops.yaml: ${(err as Error)?.message ?? 'write failed'}` }
  }
  return { ok: true }
}

export interface ScheduleActionResult {
  ok: boolean
  message: string
}
/** Port of the loops.yaml CRUD in loop_runner.py main (--add/--edit/--remove/
 *  --pause/--resume). "run" is handled by the caller (native executor). */
export function scheduleAction(vaultDir: string, payload: Record<string, unknown>): ScheduleActionResult {
  const action = String(payload.action ?? '').trim()
  const name = String(payload.name ?? '').trim()
  const schedule = String(payload.schedule ?? '')
  const executor = String(payload.executor ?? '')
  const target = payload.target === undefined || payload.target === null ? null : String(payload.target)
  const targs = String(payload.args ?? '')
  const note = String(payload.note ?? '')
  // Every branch below rewrites the WHOLE file from this list, so an unreadable registry has
  // to stop the action outright — rewriting from a fallback [] would delete every definition
  // the user hand-authored, which is precisely the failure this guard exists to prevent.
  const load = loadLoops(vaultDir)
  if (!load.ok) {
    return { ok: false, message: `${load.error} — refusing to rewrite it; fix the file by hand, nothing was changed` }
  }
  const loops = load.loops

  if (action === 'add') {
    if (!(name && schedule && (target ?? ''))) return { ok: false, message: '--add needs --name --schedule --target [--executor --args --note --disabled]' }
    if (loops.some((l) => l.name === name)) return { ok: false, message: `loop '${name}' already exists — --remove it first` }
    let sch: Record<string, unknown>
    try {
      sch = parseSchedule(schedule)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    const nl: RawLoop = { name, schedule: sch, run: { executor: executor || 'signal', target: target ?? '' }, enabled: !payload.disabled }
    if (targs) (nl.run as Record<string, unknown>).args = targs
    if (note) nl.note = note
    loops.push(nl)
    const w = writeLoops(vaultDir, loops, `add '${name}'`)
    if (!w.ok) return { ok: false, message: w.error ?? 'write failed' }
    return { ok: true, message: `added loop '${name}'  (${JSON.stringify(sch)}, ${executor || 'signal'})` }
  }
  if (action === 'edit') {
    if (!name) return { ok: false, message: '--edit needs --name [--schedule --executor --target --args --note]' }
    let hit = false
    for (const l of loops) {
      if (l.name !== name) continue
      hit = true
      if (schedule) {
        try {
          l.schedule = parseSchedule(schedule)
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        }
      }
      const run = (l.run = l.run || {}) as Record<string, unknown>
      if (executor) run.executor = executor
      if (target !== null && target !== '') run.target = target
      if (targs) run.args = targs
      if (note) l.note = note
    }
    if (!hit) return { ok: false, message: `no loop named '${name}'` }
    const w = writeLoops(vaultDir, loops, `edit '${name}'`)
    if (!w.ok) return { ok: false, message: w.error ?? 'write failed' }
    return { ok: true, message: `edited '${name}'` }
  }
  if (action === 'remove') {
    const n = loops.length
    const kept = loops.filter((l) => l.name !== name)
    // Nothing matched ⇒ nothing to do. `edit` above already returns before writing in this
    // case; remove/pause/resume were the call sites that skipped the guard and rewrote the
    // file anyway while REPORTING that they had done nothing.
    if (kept.length === n) return { ok: false, message: `no loop named '${name}'` }
    const w = writeLoops(vaultDir, kept, `remove '${name}'`)
    if (!w.ok) return { ok: false, message: w.error ?? 'write failed' }
    return { ok: true, message: `removed '${name}'` }
  }
  if (action === 'pause' || action === 'resume') {
    const val = action === 'resume'
    let hit = false
    for (const l of loops) {
      if (l.name === name) {
        l.enabled = val
        hit = true
      }
    }
    if (!hit) return { ok: false, message: `no loop named '${name}'` }
    const w = writeLoops(vaultDir, loops, `${val ? 'resume' : 'pause'} '${name}'`)
    if (!w.ok) return { ok: false, message: w.error ?? 'write failed' }
    return { ok: true, message: `${val ? 'resumed' : 'paused'} '${name}'` }
  }
  return { ok: false, message: `bad action '${action}'` }
}

// ── artifact walks ────────────────────────────────────────────────────────────
/** os.walk top-down: [dirpath, filenames] per directory, scandir order. */
function walk(root: string): [string, string[]][] {
  const out: [string, string[]][] = []
  const rec = (dir: string): void => {
    let ents: import('fs').Dirent[]
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const files: string[] = []
    const dirs: string[] = []
    for (const e of ents) (e.isDirectory() ? dirs : files).push(e.name)
    out.push([dir, files])
    for (const d of dirs) rec(join(dir, d))
  }
  rec(root)
  return out
}

export interface IntelItem {
  path: string
  title: string
  date: string
  source: string
  from_schedule: string
  track: string
  summary: string
  bytes: number
}
/** Port of list_intel. */
export function listIntel(vaultDir: string | null): { intel: IntelItem[] } {
  if (!vaultDir) return { intel: [] }
  const base = vaultDir
  const intelRoot = join(pillarDir(vaultDir, 'planning'), 'intel')
  const names = scheduleNames(vaultDir)
  const items: IntelItem[] = []
  for (const [dirpath, files] of walk(intelRoot)) {
    for (const fn of files) {
      if (!fn.endsWith('.md')) continue
      const full = join(dirpath, fn)
      const rel = relative(base, full).replace(/\\/g, '/')
      const txt = readText(full, 2000)
      let size: number
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      const fm = fmKv(txt)
      const subRaw = relative(intelRoot, dirpath).replace(/\\/g, '/')
      const src = fm.source || (subRaw !== '.' && subRaw !== '' ? subRaw : 'manual')
      items.push({
        path: rel,
        title: sliceCp(artifactTitle(txt, fm, fn.slice(0, -3)), 160),
        date: fm.date || '',
        source: src,
        from_schedule: fm.from_schedule || matchSchedule(src, names),
        track: fm.track || '',
        summary: sliceCp(fm.summary || fm.description || '', 240),
        bytes: size
      })
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  return { intel: items }
}

const DOC_EXT: Record<string, string> = {
  '.docx': 'word',
  '.doc': 'word',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.pdf': 'pdf',
  '.pptx': 'ppt',
  '.ppt': 'ppt',
  '.csv': 'csv',
  '.md': 'markdown'
}
const DOC_CT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv',
  md: 'text/markdown'
}
function isoLocalSec(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function extLower(fn: string): string {
  const i = fn.lastIndexOf('.')
  return i < 0 ? '' : fn.slice(i).toLowerCase()
}

export interface DocItem {
  path: string
  name: string
  format: string
  ext: string
  bytes: number
  source: string
  from_schedule: string
  created: string
}
/** Port of list_documents. */
export function listDocuments(vaultDir: string | null): { documents: DocItem[] } {
  if (!vaultDir) return { documents: [] }
  const base = vaultDir
  const docsRoot = join(vaultDir, 'Outputs')
  const names = scheduleNames(vaultDir)
  const items: DocItem[] = []
  for (const [dirpath, files] of walk(docsRoot)) {
    for (const fn of files) {
      const ext = extLower(fn)
      if (!(ext in DOC_EXT) || ext === '.md') continue
      const full = join(dirpath, fn)
      const rel = relative(base, full).replace(/\\/g, '/')
      let stt: import('fs').Stats
      try {
        stt = statSync(full)
      } catch {
        continue
      }
      const subRaw = relative(docsRoot, dirpath).replace(/\\/g, '/')
      const src = subRaw !== '.' && subRaw !== '' ? subRaw : 'manual'
      items.push({
        path: rel,
        name: fn,
        format: DOC_EXT[ext],
        ext: ext.replace(/^\./, ''),
        bytes: stt.size,
        source: src,
        from_schedule: matchSchedule(src, names),
        created: isoLocalSec(stt.mtimeMs)
      })
    }
  }
  items.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
  return { documents: items }
}

/** Port of read_document_bytes: safe read of a file under Outputs/. */
export function readDocumentBytes(vaultDir: string | null, rel: string): { bytes: Buffer; contentType: string } | null {
  if (!vaultDir) return null
  const root = join(vaultDir, 'Outputs')
  const full = join(vaultDir, rel)
  const nRoot = root.replace(/[\\/]+$/, '')
  if (!(full === nRoot || full.startsWith(nRoot + '\\') || full.startsWith(nRoot + '/'))) return null
  try {
    if (!statSync(full).isFile()) return null
    const ext = extLower(full).replace(/^\./, '')
    return { bytes: readFileSync(full), contentType: DOC_CT[ext] || 'application/octet-stream' }
  } catch {
    return null
  }
}

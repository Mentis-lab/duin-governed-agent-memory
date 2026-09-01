// Model-backed WRITE — port of capture_work (server.py:6382): the "missing verb". The operator
// says what they're working on; a capture-router model turns it into a grounded WORK-ITEM, writes
// the task line to the right vault file (DUIN task-id + inline fields + 关联 origin), and BINDS it to the move it
// advances (a task-linked step, dedup on task_id) — or, if the work implies a NEW move, stages it
// via the same cascade review tray. Never invents a due date.
//
// Extraction-style write (structure the given text) → injected bare oneshot; keyless ⇒ '' ⇒ the
// deterministic fallbacks (title=text, no bind) still write the task, matching Python's brain-down
// path. Reuses loadTrackRegistry / arenaDirs / LANG_RULE / extractFirstJsonObject / stageCascade;
// replicates the small tasks-pillar + atomic-write + future-nodes helpers locally.

import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'fs'
import { join, sep, dirname } from 'path'
import { createHash } from 'crypto'
import { loadTrackRegistry } from './tracks-native'
import { arenaDirs } from './throughput'
import { LANG_RULE } from './stream-sync-write-native'
import { extractFirstJsonObject } from './extraction-util'
import { stageCascade, type GenerateFn, type StageDeps } from './cascade-native'
import { TASK_ID_FIELD } from './task-fields'
import { messageOf } from '../guarded'

const TASKS_PILLARS = ['DUIN/Tasks', '06 Tasks']
const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

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
/** The tasks pillar dir: first of DUIN/Tasks | 06 Tasks that exists, else the first candidate.
 *  Mirrors Python _pillar('tasks', …). */
function tasksPillarDir(base: string): string {
  return join(base, TASKS_PILLARS.find((c) => isDir(join(base, c))) ?? TASKS_PILLARS[0])
}
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true }) // ensure the pillar/arena dir exists
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}
function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    throw e // a transient lock/IO error must not degrade to [] → the re-save below would overwrite the file empty
  }
  const rows: Record<string, unknown>[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[capture-work-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}
function saveFutureNodes(vaultDir: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  atomicWrite(futuresPath(vaultDir), body)
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Build capture_work's router prompt — verbatim from server.py:6400-6410. `laneEnum` is the
 *  pipe-joined track lanes, `menu` the ≤40 active-stream projection. Exported for diffing. */
export function buildCapturePrompt(text: string, laneEnum: string, menu: unknown[]): string {
  return (
    'You are DUIN\'s capture router. The operator just told you what they\'re working on. Turn it into a ' +
    'grounded WORK-ITEM and BIND it to the move it advances. BE HONEST: do NOT invent a due date — set ' +
    '"due" only if the operator stated one. Set "stream_id" to a MENU id ONLY if that move is genuinely ' +
    'what this advances; else "" and, only if the work clearly implies a new ongoing move, set ' +
    '"new_stream" to a short title. Pick the track lane from: ' + laneEnum + '.\n' + LANG_RULE +
    '\nWORK (verbatim): ' + JSON.stringify(text) +
    '\nMOVE MENU: ' + JSON.stringify(menu) +
    '\nOutput ONLY a JSON object: {"title":"clean actionable phrasing","is_task":true|false,' +
    '"track":"<lane>","stream_id":"<menu id or empty>","new_stream":"<title or empty>",' +
    '"priority":"P1|P2|P3 or empty","due":"YYYY-MM-DD or empty","origin":"[[note]] or empty"}.'
  )
}

export interface CaptureWorkResult {
  ok: boolean
  error?: string
  task?: { id: string; title: string; track: string; priority: string; due: string; path: string }
  bound_to?: { stream_id: unknown; title: string; track: unknown } | null
  proposed_stream?: string | null
}

export interface CaptureWorkDeps extends StageDeps {
  generate: GenerateFn
}

/** Resolve the target task file for a captured item: the bound track's project Tasks.md (legacy
 *  03 Projects or arena) else the shared tasks-pillar Inbox.md. Port of server.py:6423-6432. PURE-ish. */
function targetFile(base: string, reg: { lane?: string; project?: string }[], track: string): string {
  const proj = track ? (reg.find((t) => t.lane === track && t.project)?.project ?? '') : ''
  if (proj && isDir(join(base, '03 Projects', proj))) return join(base, '03 Projects', proj, 'Tasks.md')
  if (proj && arenaDirs(base).includes(proj)) return join(base, proj, 'Tasks.md')
  return join(tasksPillarDir(base), 'Inbox.md')
}

/**
 * Capture a work-item from free text. Port of capture_work. Writes a task line, optionally binds a
 * task-linked step to the matched move, and optionally stages a new-move cascade proposal.
 */
export async function captureWork(vaultDir: string, text: string, deps: CaptureWorkDeps): Promise<CaptureWorkResult> {
  const t = (text || '').trim()
  if (!t) return { ok: false, error: 'empty' }
  if (!vaultDir) return { ok: false, error: 'no vault' }

  const reg = loadTrackRegistry(vaultDir)
  const lanes = [...new Set(reg.map((r) => r.lane).filter((l): l is string => !!l))]
  const streams = loadFutureNodes(vaultDir)
  const active = streams.filter((s) => s.status === 'open' || s.status === 'engaged' || s.status === 'synced')
  const menu = active
    .slice(0, 40)
    .map((s) => ({ id: s.id, title: String(s.title ?? '').slice(0, 60), track: s.track ?? '', objective: String(s.objective ?? '').slice(0, 80) }))
  // COLD-START A3: no hardcoded operator lanes. With no lanes defined yet the model is told the
  // track is unknown rather than being handed someone else's taxonomy to choose from.
  const laneEnum = lanes.join('|') || 'unknown'

  const obj = extractFirstJsonObject(await deps.generate(buildCapturePrompt(t, laneEnum, menu))) ?? {}

  const title = (String(obj.title || t).trim().slice(0, 200)) || t.slice(0, 200)
  const track = String(obj.track ?? '')
  const priRaw = String(obj.priority ?? '').trim()
  const pri = priRaw === 'P1' || priRaw === 'P2' || priRaw === 'P3' ? priRaw : ''
  let due = String(obj.due ?? '').trim()
  if (!DUE_RE.test(due)) due = ''
  const sid = String(obj.stream_id ?? '')
  const origin = String(obj.origin ?? '').trim()
  const opid = 'cap-' + createHash('md5').update(title + t, 'utf-8').digest('hex').slice(0, 8)

  const fp = targetFile(vaultDir, reg, track)
  const rel = fp.slice(vaultDir.length).replace(new RegExp(sep.replace(/\\/g, '\\\\'), 'g'), '/').replace(/^\/+/, '')

  let fields = `{{${TASK_ID_FIELD}:: ${opid}}} {{status:: Project.Inbox}}`
  if (pri) fields += ` {{priority:: ${pri}}}`
  if (due) fields += ` {{dateDue:: ${due}}}`
  let line = `- [ ] ${title} ${fields}`
  if (origin.startsWith('[[')) line += `  关联：${origin}`

  let prior: string
  if (isFile(fp)) {
    prior = readFileSync(fp, 'utf-8')
    if (prior && !prior.endsWith('\n')) prior += '\n'
  } else {
    prior = '---\ntype: tasks\ncreated-by: duin\n---\n\n# Captured\n\n'
  }
  atomicWrite(fp, prior + line + '\n')

  // Ground the matched move: append a task-bound step (dedup on task_id) → closes a projection gap.
  let boundInfo: { stream_id: unknown; title: string; track: unknown } | null = null
  const bound = streams.find((s) => s.id === sid) ?? null
  if (bound) {
    const steps = Array.isArray(bound.steps) ? (bound.steps as Record<string, unknown>[]) : []
    if (!steps.some((st) => st.task_id === opid)) {
      steps.push({ event: title, when: due, task_id: opid, gap: false, done: false })
      bound.steps = steps
      saveFutureNodes(vaultDir, streams)
    }
    boundInfo = { stream_id: bound.id, title: String(bound.title ?? '').slice(0, 80), track: bound.track }
  }

  // No move fits but the work implies one → propose it via the cascade review tray (judged, soft).
  let proposed: string | null = null
  const newStreamTitle = String(obj.new_stream ?? '').trim()
  if (!bound && newStreamTitle) {
    stageCascade(vaultDir, 'active-work', 'capture', [{
      title: newStreamTitle, track, task_id: opid, task_title: title, due,
      change: `new move grounded by captured work: ${title}`
    }], deps)
    proposed = newStreamTitle
  }

  return {
    ok: true,
    task: { id: opid, title, track, priority: pri, due, path: rel },
    bound_to: boundInfo,
    proposed_stream: proposed
  }
}

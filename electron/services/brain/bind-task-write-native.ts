// bind_task / unbind_task (native) — the interactive gap-closer: bind an existing task to the
// move it advances (append a task-linked step, idempotent), or remove the binding(s). Port of
// bind_task (server.py:6552) + unbind_task (server.py:6573). PURE future-node edits (no model);
// bind_task looks up the task's text for the step label via the task corpus (falls back to the id).

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { findTaskText } from './task-corpus-native'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/

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
    } catch (e) { console.debug('[bind-task-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}
function saveFutureNodes(vaultDir: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const path = futuresPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

export interface BindTaskResult {
  ok: boolean
  error?: string
  already?: boolean
  stream_id?: unknown
  title?: string
  track?: unknown
}

/** Bind a task to the move it advances (idempotent task-linked step). Port of bind_task. */
export function bindTask(vaultDir: string | null, taskId: string, streamId: string, due = ''): BindTaskResult {
  if (!taskId || !streamId) return { ok: false, error: 'task_id and stream_id required' }
  if (!vaultDir) return { ok: false, error: 'stream not found' }
  const streams = loadFutureNodes(vaultDir)
  const s = streams.find((x) => x.id === streamId)
  if (!s) return { ok: false, error: 'stream not found' }
  const steps = Array.isArray(s.steps) ? (s.steps as Record<string, unknown>[]) : []
  if (steps.some((st) => st.task_id === taskId)) {
    return { ok: true, already: true, stream_id: streamId }
  }
  const title = String(findTaskText(vaultDir, taskId) ?? taskId).slice(0, 80)
  const cleanDue = DUE_RE.test(due) ? due : ''
  steps.push({ event: title, when: cleanDue, task_id: taskId, gap: false, done: false })
  s.steps = steps
  saveFutureNodes(vaultDir, streams)
  return { ok: true, stream_id: streamId, title: String(s.title ?? '').slice(0, 80), track: s.track }
}

/** Remove a task's binding(s) — from one stream (streamId given) or all. Port of unbind_task. */
export function unbindTask(vaultDir: string | null, taskId: string, streamId = ''): { ok: boolean; error?: string; removed?: number } {
  if (!taskId) return { ok: false, error: 'task_id required' }
  if (!vaultDir) return { ok: true, removed: 0 }
  const streams = loadFutureNodes(vaultDir)
  let changed = 0
  for (const s of streams) {
    if (streamId && s.id !== streamId) continue
    const steps = Array.isArray(s.steps) ? (s.steps as Record<string, unknown>[]) : []
    const kept = steps.filter((st) => st.task_id !== taskId)
    if (kept.length !== steps.length) {
      s.steps = kept
      changed += steps.length - kept.length
    }
  }
  if (changed) saveFutureNodes(vaultDir, streams)
  return { ok: true, removed: changed }
}

// Native port of Python `event_prep(event_id)` (server.py) — the prep view for one
// milestone (event/anchor): the open tasks that PREP it (matched by the anchor's
// DECLARED bind rules over the full Kanban corpus, never date proximity) + the moves
// (streams) that feed it. Powers the event inspector panel; the task count also badges
// the node in the brain graph. Pure read — reuses the causal-substrate loaders.
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { readAnchorDecls, anchorBinds, anchorBranch, parseTaskLine, loadFutures, type Task } from './causal-substrate'
import { taskFiles } from './throughput'
import { readFileSync } from 'fs'
import { relative } from 'path'

export interface EventPrepResponse {
  ok: boolean
  error?: string
  event?: { id: string; name: string; date: string }
  tasks: { id: string; text: string; branch: string; due: string; project: string }[]
  moves: { id: string; title: string; track: string }[]
  counts?: { tasks: number; moves: number }
}

/** All Kanban tasks parsed (read-only, NO filter — matches _load_task_corpus, which
 *  keeps done rows too; _bound_tasks_for drops done). */
function loadTaskCorpus(vaultDir: string): Task[] {
  const out: Task[] = []
  for (const fp of taskFiles(vaultDir)) {
    let txt: string
    try {
      txt = readFileSync(fp, 'utf-8')
    } catch {
      continue
    }
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    const lines = txt.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], rel, i)
      if (t) out.push(t)
    }
  }
  return out
}

/** Faithful port of server.py:event_prep(). Pure fs (via shared loaders). */
export function eventPrep(vaultDir: string | null, eventId: string): EventPrepResponse {
  if (!vaultDir) return { ok: false, error: 'unknown event', tasks: [], moves: [] }
  // {d["id"]: d for d in decls}.get(event_id) — last decl with a given id wins.
  const byId = new Map<string, ReturnType<typeof readAnchorDecls>[number]>()
  for (const d of readAnchorDecls(vaultDir)) byId.set(d.id, d)
  const decl = byId.get(eventId)
  if (!decl) return { ok: false, error: 'unknown event', tasks: [], moves: [] }

  const bt = loadTaskCorpus(vaultDir).filter((t) => !t.done && anchorBinds(t, decl))
  const tasks = bt.map((t) => ({
    id: t.id || '',
    text: (t.text || '').slice(0, 140),
    branch: anchorBranch(t.contexts, t.tags, decl),
    due: t.due || '',
    project: t.project || ''
  }))
  const moves = loadFutures(vaultDir)
    .filter((s) => s.status !== 'declined' && (s.anchor_id || '') === eventId)
    .map((s) => ({ id: s.id || '', title: s.title || '', track: s.track || '' }))
  return {
    ok: true,
    event: { id: eventId, name: decl.name || '', date: decl.date || '' },
    tasks,
    moves,
    counts: { tasks: tasks.length, moves: moves.length }
  }
}

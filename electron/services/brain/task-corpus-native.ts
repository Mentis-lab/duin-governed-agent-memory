// Task corpus — all Kanban tasks parsed once (read-only). The native equivalent of
// _load_task_corpus / list_tasks' task set, used by the scout (open-task dedup) and bind_task
// (step title lookup). Reuses taskFiles (the vault task-file discovery) + parseTaskLine.

import { readFileSync } from 'fs'
import { relative } from 'path'
import { taskFiles } from './throughput'
import { parseTaskLine, type Task } from './causal-substrate'

/** Every task line across the vault's task files, parsed. Port of _load_task_corpus. */
export function loadTaskCorpus(vaultDir: string): Task[] {
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

/** Text of every open (non-done) task — the scout's "do NOT duplicate" set. */
export function openTaskTexts(vaultDir: string): string[] {
  return loadTaskCorpus(vaultDir)
    .filter((t) => !t.done)
    .map((t) => t.text)
}

/** The text of a task by id, or null. Used by bind_task for the step's event label. */
export function findTaskText(vaultDir: string, id: string): string | null {
  const t = loadTaskCorpus(vaultDir).find((x) => x.id === id)
  return t ? t.text : null
}

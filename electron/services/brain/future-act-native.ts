// act_future (native) — the operator dispositions a stream: engage (follow), pass (decline → won't
// resurface), keep (low-relevance backlog, survives the dormancy gate but ranks low), delete
// (remove), or reset. Port of act_future (server.py:1911). Deterministic future-node edit.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'

const futuresPath = (v: string): string => join(v, '.duin', '_state', 'future-nodes.jsonl')

function loadFutureNodes(v: string): Record<string, unknown>[] {
  try {
    return readFileSync(futuresPath(v), 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    }).filter((x): x is Record<string, unknown> => x !== null)
  } catch {
    return []
  }
}
function saveFutureNodes(v: string, rows: Record<string, unknown>[]): void {
  const path = futuresPath(v)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  renameSync(tmp, path)
}

const STATUS_MAP: Record<string, string> = { engage: 'engaged', pass: 'declined', reset: 'open' }

export interface ActFutureResult {
  ok: boolean
  id: string
  action: string
}

/** Disposition a stream by id. Port of act_future. */
export function actFuture(vaultDir: string | null, nodeId: string, action: string): ActFutureResult {
  if (!vaultDir) return { ok: true, id: nodeId, action }
  let nodes = loadFutureNodes(vaultDir)
  if (action === 'delete') {
    nodes = nodes.filter((n) => n.id !== nodeId)
    saveFutureNodes(vaultDir, nodes)
    return { ok: true, id: nodeId, action: 'delete' }
  }
  for (const n of nodes) {
    if (n.id !== nodeId) continue
    if (action === 'keep') {
      n.kept = true
    } else {
      n.status = STATUS_MAP[action] ?? n.status ?? 'open'
      if (action === 'pass') n.kept = false
    }
  }
  saveFutureNodes(vaultDir, nodes)
  return { ok: true, id: nodeId, action }
}

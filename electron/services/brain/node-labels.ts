// node-labels — the operator's name for a derived entity.
//
// A construction entity's label is whatever the extractor last said it was; nothing let the
// operator correct it. This is that correction: an append-only ledger under the vault's own
// state, last write wins, an empty label clears the override. It is applied to the SERVED
// graph after the build pipeline has run (after the mechanical-duplicate fold), so naming a
// node never folds it onto another node, and it keys on the entity id, which convergeConstruction
// keeps stable across rebuilds — so the name survives them. A vault note is named by its file;
// renaming that goes through vault-organize.ts, not here.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'

export interface NodeLabelEntry {
  id: string
  label: string
  at: string
  actor?: string
}

export function nodeLabelsPath(vaultDir: string | null | undefined): string | null {
  if (typeof vaultDir !== 'string' || !vaultDir.trim()) return null
  return join(vaultDir, '.duin', '_state', 'node-labels.jsonl')
}

/** Last write wins; an empty label removes the override. Malformed lines are skipped. */
export function parseNodeLabels(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of (body || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as Partial<NodeLabelEntry>
      if (!o || typeof o.id !== 'string' || !o.id.trim()) continue
      const label = typeof o.label === 'string' ? o.label.trim() : ''
      if (label) out.set(o.id, label)
      else out.delete(o.id)
    } catch {
      /* skip */
    }
  }
  return out
}

let memo: { path: string; size: number; mtimeMs: number; labels: Map<string, string> } | null = null

/** The current overrides for a vault, memoised on the ledger's size and mtime. */
export function readNodeLabels(vaultDir: string | null | undefined): Map<string, string> {
  const p = nodeLabelsPath(vaultDir)
  if (!p || !existsSync(p)) return new Map()
  try {
    const st = statSync(p)
    if (memo && memo.path === p && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.labels
    const labels = parseNodeLabels(readFileSync(p, 'utf8'))
    memo = { path: p, size: st.size, mtimeMs: st.mtimeMs, labels }
    return labels
  } catch {
    return new Map()
  }
}

/** Record the operator's name for a node (or clear it with an empty label). False when the
 *  ledger could not be written. */
export function recordNodeLabel(vaultDir: string | null | undefined, id: string, label: string, actor = 'operator'): boolean {
  const p = nodeLabelsPath(vaultDir)
  if (!p || !id.trim()) return false
  try {
    mkdirSync(dirname(p), { recursive: true })
    const entry: NodeLabelEntry = { id: id.trim(), label: label.trim(), at: new Date().toISOString(), actor }
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8')
    memo = null
    return true
  } catch {
    return false
  }
}

/** Apply the overrides to a built graph's nodes in place. Returns how many nodes were renamed.
 *  A renamed node carries `labelBy: 'operator'` so a surface can say where the name came from. */
export function applyNodeLabels(nodes: Array<Record<string, unknown>>, labels: Map<string, string>): number {
  if (labels.size === 0) return 0
  let n = 0
  for (const node of nodes) {
    const id = typeof node.id === 'string' ? node.id : ''
    const label = id ? labels.get(id) : undefined
    if (label === undefined || node.label === label) continue
    node.label = label
    node.labelBy = 'operator'
    n++
  }
  return n
}

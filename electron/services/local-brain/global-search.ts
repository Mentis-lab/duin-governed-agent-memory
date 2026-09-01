// Global search — the backend for the Cmd/Ctrl+K command palette (Phase 2:
// search-only). It REUSES the existing hybrid note retriever (`search()` in
// index-store.ts — BM25 + sqlite-vec fused by RRF) for note/doc hits, and
// filters the already-built brain graph (`buildBrainGraph`) for node hits.
//
// It writes NOTHING and introduces NO new retriever: notes come straight from
// `search()`, nodes are a label filter over the canonical brain graph with a
// degree read off the same links the graph draws. Both the HTTP `/state/search`
// route and the `brain:search` IPC handler call `globalSearch()` so the two
// surfaces can never drift.
import { join } from 'path'
import { search as noteSearch } from './index-store'
import { buildBrainGraph } from '../brain/brain-graph-native'
import { readGraphNative, nativeGraphMtime } from '../brain/graph-native'
import { brainAssetsDir } from '../brain-paths'

export interface GlobalSearchNote {
  /** Vault-relative path of the source note (also the DocView open target). */
  file: string
  /** Note title — the file basename without extension. */
  title: string
  /** Parent-folder breadcrumb (" / "-joined). Degraded from the design's
   *  heading breadcrumb: SearchHit carries no headingPath, so we surface the
   *  folder path instead. */
  breadcrumb: string
  snippet: string
  score: number
}

export interface GlobalSearchNode {
  id: string
  label: string
  kind: string
  layer?: string
  degree: number
}

export interface GlobalSearchResult {
  query: string
  notes: GlobalSearchNote[]
  nodes: GlobalSearchNode[]
}

interface NodeRow {
  id: string
  label: string
  kind: string
  layer?: string
  degree: number
}

// Node index cache — building the full brain graph on every keystroke is
// wasteful, so we memo the flattened node list keyed by vault + graph-db mtime
// (the same invalidation the /state/brain-graph route uses). A search is then a
// cheap in-memory substring scan.
let _nodeCache: { key: string; rows: NodeRow[] } | null = null

function nodeIndex(vault: string): NodeRow[] {
  const key = `${vault}:${nativeGraphMtime(vault)}`
  if (_nodeCache && _nodeCache.key === key) return _nodeCache.rows

  const logoDir = join(brainAssetsDir(), 'web', 'public', 'project-logos')
  const graph = buildBrainGraph(vault || null, { prod: readGraphNative(vault), logoDir })
  const degree = new Map<string, number>()
  for (const l of graph.links) {
    const s = String((l as { source: unknown }).source ?? '')
    const t = String((l as { target: unknown }).target ?? '')
    if (s) degree.set(s, (degree.get(s) ?? 0) + 1)
    if (t) degree.set(t, (degree.get(t) ?? 0) + 1)
  }
  const rows: NodeRow[] = graph.nodes.map((n) => {
    const id = String((n as { id: unknown }).id ?? '')
    return {
      id,
      label: String((n as { label?: unknown }).label ?? id),
      kind: String((n as { kind?: unknown }).kind ?? 'note'),
      layer: (n as { layer?: string }).layer,
      degree: degree.get(id) ?? 0
    }
  })
  _nodeCache = { key, rows }
  return rows
}

/** "03 Projects/Foo/note.md" -> "03 Projects / Foo". Empty for a vault-root note. */
function breadcrumbOf(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/')
  parts.pop() // drop the filename
  return parts.join(' / ')
}

/** "03 Projects/Foo/note.md" -> "note". */
function titleOf(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? file
  return base.replace(/\.[^.]+$/, '')
}

/**
 * Grouped global search for the command palette. Notes come from the existing
 * hybrid retriever; nodes are a degree-ranked label match over the brain graph.
 * Pure read — safe to call on every keystroke (both legs are cheap on a local
 * vault; the node list is cached).
 */
export async function globalSearch(
  query: string,
  vault: string,
  opts?: { noteK?: number; nodeK?: number }
): Promise<GlobalSearchResult> {
  const q = (query ?? '').trim()
  if (!q) return { query: q, notes: [], nodes: [] }
  const noteK = opts?.noteK ?? 8
  const nodeK = opts?.nodeK ?? 8

  const hits = await noteSearch(q, noteK)
  const notes: GlobalSearchNote[] = hits.map((h) => ({
    file: h.file,
    title: titleOf(h.file),
    breadcrumb: breadcrumbOf(h.file),
    snippet: h.snippet,
    score: h.score
  }))

  const ql = q.toLowerCase()
  let nodes: GlobalSearchNode[]
  try {
    nodes = nodeIndex(vault)
      .filter((n) => n.kind !== 'core' && n.label.toLowerCase().includes(ql))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, nodeK)
      .map((n) => ({ id: n.id, label: n.label, kind: n.kind, layer: n.layer, degree: n.degree }))
  } catch {
    // A missing/locked graph db degrades to note-only results rather than failing.
    nodes = []
  }

  return { query: q, notes, nodes }
}

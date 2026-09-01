// retrieval-tool-pack.ts — give the agentic executors (loops, forkAgent,
// headless) the SAME retrieval the chat grounding already uses: hybrid (RRF)
// vault search + brain-graph multi-hop. Both handlers REUSE existing functions —
// `index-store.search` (the RRF-fused hybrid) and the `retrieve-agent` graph
// walk — so there is ONE retrieval spine for chat AND agents, not a parallel
// copy. Read-only, no approval (like read_file/list_dir).

import { toolRegistry } from './tool-registry'
import { search } from './local-brain/index-store'
import { deriveGraph } from './local-brain/graph-derive'
import { toGraphView, graphNeighbors } from './brain/retrieve-agent'

const MAX_K = 12
const MAX_NEIGHBORS = 30

toolRegistry.registerNative(
  {
    id: 'search_notes',
    name: 'search_notes',
    title: 'Search notes',
    description:
      'Hybrid search of the indexed vault — semantic embeddings AND keyword, fused by ' +
      'reciprocal rank, so an exact term surfaces even if it ranks low semantically. Returns ' +
      'the top matching notes as `path — snippet`. Use this to FIND relevant notes (by meaning ' +
      'or exact term) before reading them with read_file. Read-only.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for (natural language or keywords).' },
        k: { type: 'number', description: 'Max results (default 6, max 12).' }
      },
      required: ['query'],
      additionalProperties: false
    },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    const q = String((args as { query?: unknown }).query ?? '').trim()
    if (!q) return { result: 'Error: query is required', status: 'error' }
    const kRaw = Number((args as { k?: unknown }).k)
    const k = Number.isFinite(kRaw) ? Math.max(1, Math.min(MAX_K, Math.floor(kRaw))) : 6
    try {
      const hits = await search(q, k)
      if (hits.length === 0) return '(no matching notes)'
      return hits.map((h) => `${h.file} — ${h.snippet}`).join('\n')
    } catch (e) {
      return { result: `Error: ${(e as Error).message}`, status: 'error' }
    }
  }
)

toolRegistry.registerNative(
  {
    id: 'walk_links',
    name: 'walk_links',
    title: 'Walk note links',
    description:
      'Follow the wikilink graph from a note to its neighbours — the multi-hop step ' +
      '("find note A, then what it links to"). Pass a note path or a [[link]] target; returns ' +
      'the connected notes with link direction (→ outgoing, ← incoming). Call again on a ' +
      'neighbour to go deeper. Read-only.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'A note path or [[link]]/entity name to walk from.' }
      },
      required: ['from'],
      additionalProperties: false
    },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    const seed = String((args as { from?: unknown }).from ?? '').trim()
    if (!seed) return { result: 'Error: `from` is required', status: 'error' }
    try {
      const neighbors = graphNeighbors(toGraphView(deriveGraph()), seed)
      if (neighbors.length === 0) return `(no links found from "${seed}")`
      return neighbors
        .slice(0, MAX_NEIGHBORS)
        .map(
          (n) =>
            `${n.dir === 'out' ? '→' : '←'} ${n.id}${n.label && n.label !== n.id ? ` (${n.label})` : ''} [${n.via}]`
        )
        .join('\n')
    } catch (e) {
      return { result: `Error: ${(e as Error).message}`, status: 'error' }
    }
  }
)

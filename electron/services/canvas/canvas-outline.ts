// JSON Canvas (jsoncanvas.org, spec 1.0) → readable outline.
//
// WHY THIS EXISTS. A `.canvas` file is a blueprint a human draws and an agent
// reads. Raw canvas JSON is unreadable to both a retriever (coordinates and ids
// dominate the token budget) and to a model asked to follow the plan. This
// module is the single translation from the on-disk document to prose an LLM
// can act on, and it is deliberately PURE — no fs, no electron, no registry
// lookups — so the same function serves ingest, agent context, and tests.
//
// SPEC SCOPE. Spec 1.0 defines four node types (text/file/link/group) and six
// required node fields (id,type,x,y,width,height). The spec does NOT define
// whether unknown custom properties survive a round-trip through other editors
// (notably Obsidian), so bindings are expressed ONLY through spec-standard
// fields: a `file` node carries a vault path, a `link` node carries a URL. No
// custom keys are read or written — a canvas authored here stays loadable
// anywhere, and one authored elsewhere stays loadable here.

/** A `duin://` URL on a `link` node binds that block to something in the app.
 *  Chosen over a custom node property precisely because `url` is spec-standard. */
const DUIN_SCHEME = 'duin://'

export interface CanvasNode {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  /** type=text */ text?: string
  /** type=file */ file?: string
  /** type=file */ subpath?: string
  /** type=link */ url?: string
  /** type=group */ label?: string
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  label?: string
}

export interface CanvasDoc {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** What a block points at. `null` = the block is prose, not a reference. */
export type CanvasBinding =
  | { kind: 'note'; path: string; subpath?: string }
  | { kind: 'skill'; name: string }
  | { kind: 'tool'; id: string }
  | { kind: 'entity'; id: string }
  | { kind: 'url'; url: string }

/**
 * Parse canvas JSON, tolerating everything the spec leaves optional.
 *
 * Tolerance is the point: these files are hand-edited in other editors and a
 * blueprint that fails closed on one malformed node is worse than one that
 * renders the rest. Nodes missing an `id` or `type` are dropped (nothing can
 * reference them); missing geometry defaults to 0 so ordering still works.
 * Throws ONLY when the top level is not a JSON object — that is a wrong-file
 * error the caller should surface, not paper over.
 */
export function parseCanvas(raw: string): CanvasDoc {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`, { cause: err })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Not a JSON Canvas document: top level must be an object')
  }
  const obj = data as Record<string, unknown>
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : []
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : []

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

  const nodes: CanvasNode[] = []
  for (const n of rawNodes) {
    if (!n || typeof n !== 'object') continue
    const r = n as Record<string, unknown>
    const id = str(r.id)
    const type = str(r.type)
    if (!id || !type) continue
    nodes.push({
      id,
      type,
      x: num(r.x),
      y: num(r.y),
      width: num(r.width),
      height: num(r.height),
      color: str(r.color),
      text: str(r.text),
      file: str(r.file),
      subpath: str(r.subpath),
      url: str(r.url),
      label: str(r.label)
    })
  }

  const known = new Set(nodes.map((n) => n.id))
  const edges: CanvasEdge[] = []
  for (const e of rawEdges) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const id = str(r.id)
    const fromNode = str(r.fromNode)
    const toNode = str(r.toNode)
    if (!id || !fromNode || !toNode) continue
    // Drop dangling edges. A blueprint that claims a connection to a deleted
    // block would read as a real dependency to the agent following it.
    if (!known.has(fromNode) || !known.has(toNode)) continue
    edges.push({ id, fromNode, toNode, label: str(r.label) })
  }

  return { nodes, edges }
}

/** Decode what a block references. See the header note on why this reads only
 *  spec-standard fields. Unrecognised `duin://` hosts fall back to a plain URL
 *  rather than throwing — a newer app version may mint hosts this one predates. */
export function bindingOf(node: CanvasNode): CanvasBinding | null {
  if (node.type === 'file' && node.file) {
    return { kind: 'note', path: node.file, subpath: node.subpath }
  }
  if (node.type === 'link' && node.url) {
    const url = node.url
    if (url.toLowerCase().startsWith(DUIN_SCHEME)) {
      const rest = url.slice(DUIN_SCHEME.length)
      const slash = rest.indexOf('/')
      const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
      const value = slash === -1 ? '' : rest.slice(slash + 1)
      if (value) {
        if (host === 'skill') return { kind: 'skill', name: value }
        if (host === 'tool') return { kind: 'tool', id: value }
        if (host === 'node' || host === 'entity') return { kind: 'entity', id: value }
      }
    }
    return { kind: 'url', url }
  }
  return null
}

/** Human-facing one-liner for a binding — used in the outline and reusable by UI. */
export function describeBinding(b: CanvasBinding): string {
  switch (b.kind) {
    case 'note':
      return `note ${b.path}${b.subpath ? b.subpath : ''}`
    case 'skill':
      return `skill ${b.name}`
    case 'tool':
      return `capability ${b.id}`
    case 'entity':
      return `entity ${b.id}`
    case 'url':
      return `link ${b.url}`
  }
}

/** Collapse a text node to a single readable line. Canvas text is markdown and
 *  can be a whole paragraph; the outline needs a label, not the body. */
function summarizeText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Reading order: top-to-bottom, then left-to-right, `id` as the final tiebreak.
 *
 *  Geometry is used ONLY for presentation order here. It deliberately does not
 *  carry meaning beyond that — an execution engine that infers ordering from XY
 *  (n8n does) makes moving a box on the canvas change behaviour, which is a trap
 *  for a document humans rearrange for legibility. The `id` tiebreak keeps the
 *  output byte-stable so re-ingesting an unchanged canvas re-chunks identically. */
function readingOrder(a: CanvasNode, b: CanvasNode): number {
  if (a.y !== b.y) return a.y - b.y
  if (a.x !== b.x) return a.x - b.x
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Groups are spatial, not structural — the spec gives them no member list, so
 *  containment is computed from rectangles. Fully-contained only; a node
 *  straddling a boundary belongs to nothing, which matches what the eye sees. */
function membersOf(group: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter(
    (n) =>
      n.id !== group.id &&
      n.type !== 'group' &&
      n.x >= group.x &&
      n.y >= group.y &&
      n.x + n.width <= group.x + group.width &&
      n.y + n.height <= group.y + group.height
  )
}

/** The one-line identity of a block. Exported so the VISUAL renderer labels a
 *  block exactly as the outline does — two views that disagree about what a
 *  block is would be worse than having only one. */
export function labelOf(node: CanvasNode): string {
  if (node.type === 'group') return node.label?.trim() || '(unnamed group)'
  if (node.type === 'text') return summarizeText(node.text ?? '') || '(empty note)'
  const b = bindingOf(node)
  if (b) return describeBinding(b)
  return `(${node.type})`
}

export interface OutlineOptions {
  /** Shown as the document heading — normally the canvas filename. */
  title?: string
}

/**
 * Render a canvas as the text an agent reads.
 *
 * Format is a stable outline rather than a re-serialization of the graph: each
 * block gets a short ordinal handle ([1], [2], …) so the connections section can
 * reference blocks unambiguously even when two of them carry identical text.
 * Handles are assigned in reading order, so the same canvas always produces the
 * same text.
 */
export function canvasToOutline(doc: CanvasDoc, opts: OutlineOptions = {}): string {
  const { nodes, edges } = doc
  const title = opts.title?.trim()
  const out: string[] = []
  out.push(`# Canvas${title ? `: ${title}` : ''}`)

  if (nodes.length === 0) {
    out.push('', '(empty canvas — no blocks)')
    return out.join('\n')
  }

  const ordered = [...nodes].sort(readingOrder)
  const handle = new Map<string, string>()
  const blocks = ordered.filter((n) => n.type !== 'group')
  blocks.forEach((n, i) => handle.set(n.id, `[${i + 1}]`))

  const groups = ordered.filter((n) => n.type === 'group')
  out.push('', `${blocks.length} block${blocks.length === 1 ? '' : 's'}, ${edges.length} connection${edges.length === 1 ? '' : 's'}${groups.length ? `, ${groups.length} group${groups.length === 1 ? '' : 's'}` : ''}.`)

  out.push('', '## Blocks')
  for (const n of blocks) {
    const parts: string[] = [`- ${handle.get(n.id)} ${labelOf(n)}`]
    // A text block that also sits inside a group reads better with the group
    // named inline than with a separate membership section to cross-reference.
    const owner = groups.find((g) => membersOf(g, blocks).some((m) => m.id === n.id))
    if (owner) parts.push(`  (in group "${owner.label?.trim() || 'unnamed'}")`)
    out.push(parts.join(''))
  }

  if (edges.length > 0) {
    out.push('', '## Connections')
    const orderedEdges = [...edges].sort((a, b) => {
      const ai = blocks.findIndex((n) => n.id === a.fromNode)
      const bi = blocks.findIndex((n) => n.id === b.fromNode)
      if (ai !== bi) return ai - bi
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    for (const e of orderedEdges) {
      const from = handle.get(e.fromNode) ?? '[?]'
      const to = handle.get(e.toNode) ?? '[?]'
      const via = e.label?.trim() ? ` — ${e.label.trim()} —` : ''
      out.push(`- ${from} →${via} ${to}`)
    }
  }

  // Referenced material is listed separately so a retriever surfaces the paths
  // even when the block labels are truncated prose.
  const refs = blocks
    .map((n) => bindingOf(n))
    .filter((b): b is CanvasBinding => b !== null && b.kind !== 'url')
  if (refs.length > 0) {
    out.push('', '## References')
    for (const b of refs) out.push(`- ${describeBinding(b)}`)
  }

  return out.join('\n')
}

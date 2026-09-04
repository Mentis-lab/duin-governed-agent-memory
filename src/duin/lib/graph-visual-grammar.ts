// The brain map's VISUAL GRAMMAR: every channel the GPU renderer (@cosmos.gl/graph) can draw,
// bound to ONE DUIN concept the operator already knows from the Explorer, the node panel and the
// seam ledger. Pure data and pure functions, so the renderer, the legend and the tests read the
// same rules. Nothing here knows about React or WebGL.
//
//   channel        DUIN concept                          rule
//   ─────────────  ────────────────────────────────────  ───────────────────────────────────────────
//   point shape    node KIND family (node-panel KIND_META)  see shapeForNode
//   point color    folder / scheme, or detected cluster  brain-shell palette memos (unchanged)
//   point size     connectedness (degree)                brain-shell sizeFor (unchanged)
//   point alpha    recency of the file                   brain-shell recencyMul (unchanged)
//   rings          selected (focus ring) · locked (outline)  cosmos focusedPointIndex / outlinedPointIndices
//   link stroke    always solid                           provenance (declared vs inferred) is the tooltip's job
//   link arrow     direction of a relation, in focus     arrowForLink, drawn only on lit links
//   link color     higher-priority endpoint's hue at idle; in focus a solid gradient from the
//                  source's hue to the target's, brighter on the anchor's own links (litLinks)
//   greyout        "not in the neighbourhood you asked about"  GREYOUT per theme
//
// Provenance: DUIN's thesis is memory you can read, diff and overrule. A wikilink the operator
// typed and a relation an LLM extracted are different kinds of claim, and graph-insight's
// edgeProvenance already tells them apart for the report. The renderer only sees a link's `type`
// (confidence never reaches it), so the vocabulary below mirrors that classifier. It used to
// draw as a dotted stroke on lit links; the operator's verdict (2026-09-03, "use solid gradient
// line") moved it to the link tooltip, where the words fit.

/** cosmos PointShape enum values (modules/GraphData). Kept as a literal so no cosmos import
 *  is needed in a pure module. */
export const POINT_SHAPE = {
  circle: 0, square: 1, triangle: 2, diamond: 3, pentagon: 4, hexagon: 5, star: 6, cross: 7, none: 8,
} as const

/**
 * Shape by KIND FAMILY. The bulk of the map (notes, cards, topics, decisions, people) stays a
 * circle so the field reads calm; a shape is spent only where the family means something the
 * operator navigates by. At overview zoom every mark is a dot regardless, so the grammar costs
 * nothing until you zoom in, which is exactly when you want it.
 *
 *   star      the core, the one centre
 *   hexagon   folder hubs, the region legend
 *   pentagon  the work structure: project, track, strategy, move
 *   triangle  aims: goal, key result
 *   diamond   points in time: event, milestone, release
 *   square    organisations
 *   cross     things demanding attention: risk, issue, owed decision
 *   circle    everything else (note, card, page, topic, decision, person, index, unknown)
 */
export function shapeForNode(n: { kind?: string | null } | null | undefined): number {
  switch (n?.kind) {
    case 'core': return POINT_SHAPE.star
    case 'folder': return POINT_SHAPE.hexagon
    case 'project': case 'track': case 'strategy': case 'move': return POINT_SHAPE.pentagon
    case 'goal': case 'kr': return POINT_SHAPE.triangle
    case 'event': case 'milestone': case 'release': return POINT_SHAPE.diamond
    case 'org': return POINT_SHAPE.square
    case 'risk': case 'issue': case 'owed': return POINT_SHAPE.cross
    default: return POINT_SHAPE.circle
  }
}

export type LinkProvenance = 'declared' | 'inferred'

/** Link types the OPERATOR or the vault's own structure declared. Everything else on the map was
 *  produced by the construction pass (an LLM reading the notes) and is a claim about the notes,
 *  not a fact in them. Mirrors graph-insight's edgeProvenance, extended with the structural
 *  families brain-graph-native mints (folder containment, project indexes, roadmap anchors). */
const DECLARED_LINK_TYPES = new Set([
  'wiki', 'wikilink', 'link', 'refs',            // typed by the operator in a note
  'in', 'contains', 'anchors', 'indexes', 'domain', // vault / product structure
  'has_kr', 'builds_toward', 'guides',           // the declared roadmap (goals, KRs, strategy)
])

export function linkProvenance(type: string | null | undefined): LinkProvenance {
  return DECLARED_LINK_TYPES.has(String(type ?? '')) ? 'declared' : 'inferred'
}

/** Relation families with no direction worth an arrowhead: containment and structure, where the
 *  arrow would only say "is inside", and the loose/similarity edges, which are symmetric. */
const UNDIRECTED_LINK_TYPES = new Set(['in', 'contains', 'anchors', 'indexes', 'domain', 'loose', 'synonym', 'related', 'similar'])

/** Whether a link carries a direction the operator can read (A depends on B, A mentions B,
 *  A attends B). Arrows are drawn only on LIT links: on ten thousand whisper-alpha links they
 *  are clutter, on the fifteen you are studying they answer "which way does this go". */
export function arrowForLink(type: string | null | undefined): boolean {
  return !UNDIRECTED_LINK_TYPES.has(String(type ?? ''))
}

/**
 * The links of a focus neighbourhood, in cosmos link-index order. `pairs` is the flat
 * [s0, t0, s1, t1, …] point-index array handed to `setLinks`; `lit` the lit point indices;
 * `anchor` the focus anchor's point index (undefined when only a lens restricts).
 *
 * A link is lit when BOTH endpoints are lit: at depth 1 that is exactly the anchor's own
 * connections, at depth 2+ also the connections between its neighbours. `incident` is the
 * subset touching the anchor, drawn brighter, so the first hop reads above the rest.
 */
export function litLinks(
  pairs: ArrayLike<number>,
  lit: ReadonlySet<number>,
  anchor: number | undefined,
): { indices: number[]; incident: number[] } {
  const indices: number[] = []
  const incident: number[] = []
  const n = Math.floor(pairs.length / 2)
  for (let i = 0; i < n; i++) {
    const s = pairs[i * 2], t = pairs[i * 2 + 1]
    if (!lit.has(s) || !lit.has(t)) continue
    indices.push(i)
    if (anchor !== undefined && (s === anchor || t === anchor)) incident.push(i)
  }
  return { indices, incident }
}

/** RGBA in 0..1, the form cosmos wants. */
export type Rgba = [number, number, number, number]

/**
 * How far the rest of the map recedes while a neighbourhood is lit. Multipliers on each
 * mark's own alpha (cosmos semantics), chosen to land on the legacy canvas painter's
 * operator-accepted absolute values: dimmed nodes at ~0.22, dimmed links at ~0.03 over a
 * 0.11 whisper (dark), and their light-theme counterparts over near-white paper. The dimmed
 * point COLOR is a fixed neutral rather than cosmos's default darkened hue, so the receded
 * field reads as one quiet surface instead of a dim rainbow.
 */
export const GREYOUT: Record<'dark' | 'light', { point: number; link: number; pointColor: Rgba }> = {
  dark: { point: 0.22, link: 0.27, pointColor: [0.35, 0.39, 0.47, 1] },
  light: { point: 0.3, link: 0.38, pointColor: [0.59, 0.63, 0.69, 1] },
}

/** The focus accent (the teal the rings already use) and the two tiers a lit link can take. */
export const FOCUS_ACCENT: Record<'dark' | 'light', Rgba> = {
  dark: [0.37, 0.92, 0.83, 0.95],
  light: [0.05, 0.43, 0.4, 0.95],
}
export const LIT_LINK_ALPHA = { incident: 0.85, neighbourhood: 0.5 } as const

/** Delicate arrowheads: the default scale draws a barb wider than a small node. */
export const LIT_ARROW_SCALE = 0.6

/** cosmos can blend each link's RGB from its source point's hue to its target point's (the
 *  endpoint gradient; opacity still comes from the link's own alpha).
 *
 *  At IDLE it stays off. Evaluated 2026-09-02 in the offline harness on the live map: at the
 *  0.11 whisper alpha the links carry, the blend is imperceptible at overview and at 5x, and it
 *  would silently replace the deliberate "a link takes its higher-priority endpoint's hue" rule
 *  (roadmap links read as roadmap). One constant, so the next person can flip it and look.
 *
 *  In FOCUS it is on: a lit link is a solid line running from the hovered node's colour into
 *  its neighbour's, the anchor's own links at the brighter alpha tier. The operator's verdict
 *  (2026-09-03): "not dotted line but a gradient solid line". */
export const LINK_GRADIENT_AT_IDLE = false
export const LINK_GRADIENT_IN_FOCUS = true

/** How many of a lit neighbourhood's members get a label (anchor first, then by degree). */
export const MAX_FOCUS_LABELS = 40

// ── Size, weight and ink (2026-09-03, the operator's list: notes first, adaptive ink, small core) ──

/**
 * A node's drawn radius in world units. ONE function for the GPU adapter, the legacy canvas
 * painter, its hit area and the offline harness, so they cannot drift.
 *
 *   core      5      the one centre; a mark, not a medallion (was 11: "the logo too big")
 *   folder    3.5    the region hubs
 *   product   2.4 + √deg × 0.7, capped at 8: the biggest project used to be a 19-unit disc
 *   the rest  1.1 + √deg × 0.35, and an extracted (construction-layer) node at 0.8 of that,
 *             so the notes the operator wrote carry the picture and the brain's extractions
 *             sit behind them
 */
export const NODE_SIZE = { core: 5, folder: 3.5, hubCap: 8 } as const

/** How the extracted layer recedes behind the vault's own notes: size, point alpha, and the
 *  alpha of a link whose BOTH ends are extracted (a note-to-entity link keeps full ink, so the
 *  entities still visibly attach to the notes they came from). */
export const LAYER_WEIGHT = { construction: { size: 0.8, alpha: 0.72, link: 0.75 } } as const

export function sizeForNode(n: { kind?: string; layer?: string; deg?: number } | null | undefined): number {
  if (!n) return 1.1
  if (n.kind === 'core') return NODE_SIZE.core
  if (n.kind === 'folder') return NODE_SIZE.folder
  const deg = n.deg || 0
  if (n.layer === 'product') return Math.min(NODE_SIZE.hubCap, 2.4 + Math.sqrt(deg) * 0.7)
  const r = 1.1 + Math.sqrt(deg) * 0.35
  return n.layer === 'construction' ? r * LAYER_WEIGHT.construction.size : r
}

/** Point-alpha multiplier for a node's layer (1 = full). */
export function layerAlpha(n: { layer?: string } | null | undefined): number {
  return n?.layer === 'construction' ? LAYER_WEIGHT.construction.alpha : 1
}

/**
 * Link ink adapts to how many links are drawn. The 0.11 whisper alpha (dark) was tuned when the
 * map drew ~16k links and their overlap composited the web toward 0.4; at 6.5k the same stamp
 * reads as nothing, and the "spokes" the operator remembers were link ink. The boost keeps the
 * COMPOSITED density roughly constant: √(16000 / links), clamped so a small map never turns
 * into a wire frame (1.8x) and a huge one is never dimmed below the tuned value (1x).
 */
export const INK_REFERENCE_LINKS = 16000
export function linkInkBoost(linkCount: number): number {
  const b = Math.sqrt(INK_REFERENCE_LINKS / Math.max(1, linkCount))
  return Math.max(1, Math.min(1.8, b))
}

/** Blend two #rrggbb colours (t = 0 → a, 1 → b). Anything unparseable returns `a` unchanged. */
export function blendHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a || ''), pb = /^#([0-9a-f]{6})$/i.exec(b || '')
  if (!pa || !pb) return a
  const x = parseInt(pa[1], 16), y = parseInt(pb[1], 16)
  const k = Math.max(0, Math.min(1, t))
  const ch = (sh: number): number => Math.round(((x >> sh) & 255) * (1 - k) + ((y >> sh) & 255) * k)
  return '#' + [ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** With Clusters on, a node keeps its folder hue and leans this far toward its community's
 *  colour: membership reads, the map does not turn into candy (the 2026-09-03 verdict). */
export const CLUSTER_TINT = 0.55

/**
 * A community's display name. graph-insight names a community "<top hub> · <track>" with a
 * " #n" suffix when several share a name; on the live map that produced "DUIN · DUIN" and
 * "示例项目 · 示例项目 #7" at the centre of the screen. Collapse the doubled half, keep the suffix
 * (it is what tells two same-named communities apart), trim the rest.
 */
export function clusterDisplayLabel(label: string | null | undefined): string {
  const s = String(label ?? '').trim()
  const m = /^(.+?)\s+·\s+(.+?)(\s+#\d+)?$/.exec(s)
  if (!m) return s
  const [, a, b, suffix = ''] = m
  return (a.trim() === b.trim() ? a.trim() : `${a.trim()} · ${b.trim()}`) + suffix
}

// ── Camera ────────────────────────────────────────────────────────────────────────────

/** Zoom level a click-to-focus lands on (was 6: "the centering is too close every time"). */
export const FOCUS_ZOOM = 3
/** Padding of a whole-map frame, as cosmos's fitView fraction (was 0.14). */
export const FIT_PADDING = 0.2
/** Re-frame after a settle when the drawn node count moved by at least this fraction. */
export const REFIT_DRIFT = 0.2

/**
 * The points a whole-map frame should fit: those inside the [lo, hi] quantile box on each axis.
 * cosmos's fitView uses the bounding box of EVERY point, so a handful of far-flung nodes shrank
 * the body to a third of the viewport; framing the 2..98% box keeps the body large and lets the
 * strays hang off the edge. Returns every index when there are too few points to trim.
 */
export function frameIndices(xs: ArrayLike<number>, ys: ArrayLike<number>, lo = 0.02, hi = 0.98): number[] {
  const n = Math.min(xs.length, ys.length)
  const all = Array.from({ length: n }, (_, i) => i)
  if (n < 50) return all
  const q = (vals: number[], p: number): number => {
    const s = vals.slice().sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]
  }
  const xv = Array.from(xs).slice(0, n), yv = Array.from(ys).slice(0, n)
  const x0 = q(xv, lo), x1 = q(xv, hi), y0 = q(yv, lo), y1 = q(yv, hi)
  const kept = all.filter((i) => xv[i] >= x0 && xv[i] <= x1 && yv[i] >= y0 && yv[i] <= y1)
  return kept.length >= 2 ? kept : all
}

// ── Labels ────────────────────────────────────────────────────────────────────────────

/** Labels a viewport can hold without piling up: about one per 28,000 px² (25 in a 902×778
 *  window, 57 at 1600×1000), never fewer than 8, never more than `cap` (the renderer passes the
 *  zoom-label cap plus the focus-label cap, 80). */
export function labelBudget(width: number, height: number, cap = 40): number {
  return Math.max(8, Math.min(cap, Math.round((width * height) / 28000)))
}

/** Approximate rendered width of a label at `fontPx`: CJK glyphs are square, Latin ~0.55 em. */
export function estimateLabelWidth(text: string, fontPx = 9): number {
  let w = 0
  for (const ch of text) w += /[　-鿿가-힯＀-￯]/.test(ch) ? fontPx : fontPx * 0.55
  return w + 6
}

export type LabelCandidate = {
  id: string
  /** Screen box: centred on `x`, top edge at `y` (the overlay's translate(-50%, 0) placement). */
  x: number
  y: number
  w: number
  h: number
  /** Higher wins a collision and the budget: selected/hovered 5, focus 4, cluster name 3.5, anchor 3, zoom label 1 + degree scaled. */
  priority: number
}

/**
 * Greedy label placement: take candidates by priority, skip any whose box overlaps one already
 * placed, stop at the budget. O(k²) over the ≤ ~150 candidates a sync produces, which is
 * nothing next to the O(N) membership pass that precedes it.
 */
export function placeLabels(cands: LabelCandidate[], budget: number): LabelCandidate[] {
  const sorted = cands.slice().sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const placed: LabelCandidate[] = []
  for (const c of sorted) {
    if (placed.length >= budget) break
    const cl = c.x - c.w / 2, cr = c.x + c.w / 2, ct = c.y, cb = c.y + c.h
    let hit = false
    for (const p of placed) {
      const pl = p.x - p.w / 2, pr = p.x + p.w / 2, pt = p.y, pb = p.y + p.h
      if (cl < pr && cr > pl && ct < pb && cb > pt) { hit = true; break }
    }
    if (!hit) placed.push(c)
  }
  return placed
}

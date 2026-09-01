// topic-tracks.ts — the MISSING MIDDLE of the memory pyramid.
//
// DUIN materializes one concept file per promoted operator fact (concept-materialize.ts). That is the
// "typed record" level. Above it there is nothing: no artifact that groups related records and notes
// into a themed track with a summary and explicit links back to its members. The top level exists too
// (operator-model ~= user profile). So the pyramid is raw-notes -> records -> [GAP] -> profile.
//
// Why that gap is expensive: NapMem (arXiv 2607.05794v1) ablates exactly this. Their `records-only
// tools` arm is their LARGEST drop (-17.81 avg), and `w/o upper levels` costs -8.63 — the mid-level
// abstraction carries real weight because it is what lets a query land on a THEME and then descend to
// evidence, instead of pattern-matching individual records. DUIN currently sits nearer the
// records-only end of that ablation than the full pyramid.
//
// This module builds that level DETERMINISTICALLY from machinery DUIN already has: graph-insight's
// Louvain community detection. No model call, no nondeterminism, no new clustering — a track IS a
// community, named and written down with its full membership as provenance.
//
// Deliberately NOT model-generated. A narrative summary would need an LLM per track, which makes the
// layer expensive, nondeterministic, and unreproducible — and the useful part of a topic track for
// retrieval is the MEMBERSHIP (what belongs together, and what evidence backs it), not the prose. A
// generated narrative can be layered on later; the provenance skeleton is what unblocks navigation.

/** Minimal graph shape this needs — deliberately structural, so the module does not couple to
 *  CausalGraph/GraphView and stays unit-testable without building a real brain graph. */
export interface TrackNode {
  id: string
  label?: string
  /** provenance note (relpath) this node came from, when it is an entity */
  note?: string
}
export interface TrackEdge {
  source: string
  target: string
}

export interface TopicTrack {
  /** stable slug derived from the label — the file name, so it must not drift run to run */
  id: string
  label: string
  /** dominant lane/track name, best-effort */
  lane: string
  size: number
  /** EVERY member node id — the provenance links that make the track navigable */
  members: string[]
  /** member notes (relpaths) — what retrieval can actually cite */
  notes: string[]
  /** most-connected members, for the summary line */
  hubs: { id: string; label: string; degree: number }[]
  /** ids of other tracks this one shares an edge with */
  neighbors: string[]
}

/** A community smaller than this is not a topic — it is a pair or a singleton, and writing a file
 *  for it would bury the real tracks in noise. */
export const MIN_TRACK_SIZE = 3

const slugify = (s: string): string =>
  (s || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'

/**
 * Derive topic tracks from a community assignment. PURE and deterministic: members and neighbours are
 * sorted, hubs are ranked by degree with id as a stable tiebreak, so the same graph always produces
 * byte-identical tracks (which is what makes the materialized files diffable rather than churning).
 */
export function deriveTopicTracks(
  nodes: TrackNode[],
  edges: TrackEdge[],
  communities: Map<string, number>,
  opts: { minSize?: number; laneOf?: (n: TrackNode) => string | undefined } = {}
): TopicTrack[] {
  const minSize = opts.minSize ?? MIN_TRACK_SIZE
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const degree = new Map<string, number>()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }

  const groups = new Map<number, string[]>()
  for (const n of nodes) {
    const c = communities.get(n.id)
    if (c === undefined) continue
    const g = groups.get(c)
    if (g) g.push(n.id)
    else groups.set(c, [n.id])
  }

  // community id -> track slug, needed to resolve cross-community edges into neighbour links
  const kept = [...groups.entries()].filter(([, ids]) => ids.length >= minSize)
  const labelOf = (ids: string[]): { label: string; lane: string; hubs: TopicTrack['hubs'] } => {
    const hubs = ids
      .map((id) => ({
        id,
        label: byId.get(id)?.label ?? id,
        degree: degree.get(id) ?? 0
      }))
      .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
      .slice(0, 5)
    const lanes = new Map<string, number>()
    for (const id of ids) {
      const lane = opts.laneOf?.(byId.get(id) as TrackNode)
      if (lane) lanes.set(lane, (lanes.get(lane) ?? 0) + 1)
    }
    // dominant lane, ties broken alphabetically so the label is stable
    const lane =
      [...lanes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? ''
    return { label: lane || hubs[0]?.label || 'untitled', lane, hubs }
  }

  const slugByCommunity = new Map<number, string>()
  const seenSlug = new Map<string, number>()
  for (const [cid, ids] of kept) {
    const base = slugify(labelOf(ids).label)
    // collision-free: a second community with the same dominant label gets a numeric suffix rather
    // than silently overwriting the first one's file.
    const n = (seenSlug.get(base) ?? 0) + 1
    seenSlug.set(base, n)
    slugByCommunity.set(cid, n === 1 ? base : `${base}-${n}`)
  }

  const neighborsOf = new Map<number, Set<number>>()
  for (const e of edges) {
    const a = communities.get(e.source)
    const b = communities.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    if (!slugByCommunity.has(a) || !slugByCommunity.has(b)) continue
    if (!neighborsOf.has(a)) neighborsOf.set(a, new Set())
    if (!neighborsOf.has(b)) neighborsOf.set(b, new Set())
    neighborsOf.get(a)!.add(b)
    neighborsOf.get(b)!.add(a)
  }

  return kept
    .map(([cid, ids]) => {
      const { label, lane, hubs } = labelOf(ids)
      const members = [...ids].sort()
      const notes = [
        ...new Set(members.map((id) => byId.get(id)?.note).filter((s): s is string => !!s))
      ].sort()
      return {
        id: slugByCommunity.get(cid)!,
        label,
        lane,
        size: members.length,
        members,
        notes,
        hubs,
        neighbors: [...(neighborsOf.get(cid) ?? [])]
          .map((c) => slugByCommunity.get(c)!)
          .filter(Boolean)
          .sort()
      }
    })
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1))
}

/**
 * Write the track lane to disk and RETIRE any track file no longer derived — reconcile semantics,
 * mirroring concept-materialize so a renamed or dissolved community does not leave a stale topic
 * behind claiming members it no longer has. Only ever touches `track-*.md`, so it cannot disturb
 * concept files or anything hand-authored sharing the directory. Returns what changed; a rewrite
 * with identical bytes is reported as `unchanged` so a no-op run is visibly a no-op.
 */
export function materializeTracks(
  tracks: TopicTrack[],
  dir: string,
  io: {
    list: (dir: string) => string[]
    read: (path: string) => string | null
    write: (path: string, body: string) => void
    remove: (path: string) => void
    join: (a: string, b: string) => string
  }
): { written: string[]; unchanged: string[]; retired: string[] } {
  const written: string[] = []
  const unchanged: string[] = []
  const want = new Set<string>()
  for (const t of tracks) {
    const { slug, md } = trackFile(t)
    want.add(slug)
    const p = io.join(dir, slug)
    if (io.read(p) === md) unchanged.push(slug)
    else {
      io.write(p, md)
      written.push(slug)
    }
  }
  const retired = io
    .list(dir)
    .filter((f) => f.startsWith('track-') && f.endsWith('.md') && !want.has(f))
    .sort()
  for (const f of retired) io.remove(io.join(dir, f))
  return { written: written.sort(), unchanged: unchanged.sort(), retired }
}

/**
 * Render a track as an OKF memory file. Machine-owned and marked as such, mirroring
 * concept-materialize's contract so the same do-not-hand-edit discipline applies and the same
 * `.brain/memory` retrieval carve-out picks it up.
 */
export function trackFile(t: TopicTrack): { slug: string; md: string } {
  const fm = [
    '---',
    `name: ${t.label}`,
    `description: Topic track — ${t.size} linked members${t.lane ? ` in ${t.lane}` : ''}`,
    'type: learned',
    'metadata:',
    '  kind: topic-track',
    `  trackId: ${t.id}`,
    `  lane: ${t.lane}`,
    `  size: ${t.size}`,
    '  source: machine',
    `tags: [topic-track, learned]`,
    '---',
    ''
  ]
  const body = [
    '<!-- generated: duin-topic-tracks · machine-owned · do not hand-edit -->',
    '',
    `# ${t.label}`,
    '',
    `A topic track: ${t.size} members clustered by the brain graph${t.lane ? ` under **${t.lane}**` : ''}.`,
    '',
    '## Central members',
    ...(t.hubs.length ? t.hubs.map((h) => `- ${h.label} (${h.degree} links)`) : ['- (none)']),
    '',
    '## Supporting notes',
    ...(t.notes.length ? t.notes.map((n) => `- [[${n}]]`) : ['- (none)']),
    '',
    '## Related tracks',
    ...(t.neighbors.length ? t.neighbors.map((n) => `- ${n}`) : ['- (none)']),
    ''
  ]
  return { slug: `track-${t.id}.md`, md: [...fm, ...body].join('\n') }
}

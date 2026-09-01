// Native port of resources/brain/server.py :: build_brain_graph() (5352-5658) —
// the capstone of the brain-graph unification (WS2). The combined SECOND-BRAIN
// graph: DUIN CORE at the center, the product graph (goals · tracks · moves ·
// strategies · projects · risks · insights · people) as the inner structure, and
// the vault knowledge base as the surrounding cloud — bridged so there are NO
// islands.
//
// Composes the already-native blocks:
//   - readGraphNative (graph-native)    ← the product store; INJECTED as `prod`
//     because it needs better-sqlite3 (Electron ABI, unloadable under vitest). The
//     route wires `readGraph(vault)`; tests inject a synthetic store graph.
//   - buildGraph (build-graph-native)   ← the vault note cloud (nodes/links/refs/tags)
//   - listOkrs (okrs-native)            ← per-project OKR goal/kr nodes
//   - projectLogoUrl (project-logo-native) ← project node logo (logoDir INJECTED)
//   - eventPrep (event-prep-native)     ← the roadmap-anchor prep badge count
//
// PARITY NOTE (why this is content-exact, not byte-exact): Python emits the
// project-association and generic-clustering edges by iterating Python SETS, whose
// order is hash-seed dependent (nondeterministic run-to-run). So the parity bar is
// the CONTENT — the same node set (with the same first-wins attributes) and the
// same undirected typed edge set — not the array order. Every set-driven pass here
// is a pure dedup (index-hub ids and edge pairs are deterministic regardless of
// visitation order), so iterating those sets in SORTED order changes only the
// emission order, never the content — and gives this port stable, diffable output.
import type { GraphReadResult } from './graph-native'
import { buildGraph } from './build-graph-native'
import { listOkrs } from './okrs-native'
import { projectLogoUrl } from './project-logo-native'
import { eventPrep } from './event-prep-native'
import { getResolvedConstruction } from './construct'
import { buildDuinGraph } from './build-duin-graph'
import { normalizeStoreId, loadStoreProjectAlias } from './canonical-id'

type Node = Record<string, unknown>
interface Edge {
  source: string
  target: string
  type: string
}
export interface BrainGraph {
  nodes: Node[]
  links: Edge[]
  core: string
  stats: { nodes: number; edges: number }
}

export interface BuildBrainGraphOpts {
  /** The product store graph — readGraph(vault). Injected (SQLite ABI). */
  prod: GraphReadResult
  /** Physical project-logos directory (…/web/public/project-logos). */
  logoDir: string
  /** "now" for the roadmap-anchor passed/upcoming fade. Defaults to new Date(). */
  now?: Date
}

// ── string helpers matching Python os.path semantics on '/'-joined vault rels ──
function relDirname(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}
function relBasename(s: string): string {
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}
/** _cluster_key: topic-level folder, depth capped at 3. `d ? split : []` variant. */
function clusterKey(rel: string): string {
  const d = relDirname(rel)
  const parts = d ? d.split('/') : []
  return parts.length > 3 ? parts.slice(0, 3).join('/') : d || '(root)'
}
/** _topic_of's key derivation from a node's group. `d.split("/")` unconditional
 *  variant (empty group → [''] → length 1 → "(root)"). */
function topicKey(group: string): string {
  const d = group || ''
  const parts = d.split('/')
  return parts.length > 3 ? parts.slice(0, 3).join('/') : d || '(root)'
}
function stripPy(s: string, chars: string): string {
  // Python str.strip(chars): remove any leading/trailing char in `chars`.
  const set = new Set(chars.split(''))
  let a = 0
  let b = s.length
  while (a < b && set.has(s[a])) a++
  while (b > a && set.has(s[b - 1])) b--
  return s.slice(a, b)
}

const WIKILINK = /\[\[([^\]|#]+)/g

/** Native build_brain_graph. `vaultDir` is HARNESS_DIR; `prod`/`logoDir` injected. */
export function buildBrainGraph(vaultDir: string | null, opts: BuildBrainGraphOpts): BrainGraph {
  const now = opts.now ?? new Date()
  const prod = opts.prod
  const logoDir = opts.logoDir
  const vault = buildGraph(vaultDir)
  const CORE = '__core__'
  const nodes: Node[] = []
  const seen = new Set<string>()

  const add = (nid: string, kw: Node): void => {
    if (!seen.has(nid)) {
      seen.add(nid)
      nodes.push({ id: nid, ...kw })
    }
  }

  // People/orgs ARE vault notes — merge them INTO their note (map store "vault:/path"
  // id → the build_graph rel id) so isolated product person/org nodes don't duplicate.
  const vaultRel = (eid: string): string =>
    eid.startsWith('vault:') ? eid.slice('vault:'.length).replace(/^\/+/, '') : ''
  const personPaths = new Set<string>()
  const orgPaths = new Set<string>()
  for (const n of prod.nodes) {
    const rel = vaultRel(String(n.id))
    if (!rel) continue
    if (n.kind === 'person') personPaths.add(rel)
    else if (n.kind === 'org') orgPaths.add(rel)
  }

  // ── Arena de-dup ──────────────────────────────────────────────────────────
  const arenaAliases = (n: Node): Set<string> => {
    const pid = String(n.id ?? '').trim()
    const base = stripPy(pid, '《》 ')
    const al = new Set<string>([pid, base])
    const title = String(n.title ?? '').trim()
    const head = title.split('·')[0].trim()
    if (head && head.toLowerCase() === base.toLowerCase()) al.add(head)
    const out = new Set<string>()
    for (const x of al) {
      const t = x.trim().toLowerCase()
      if (t) out.add(t)
    }
    return out
  }
  const arenaAlias = new Map<string, Set<string>>()
  const arenaKind = new Map<string, string>()
  for (const n of prod.nodes) {
    if (n.kind === 'project' || n.kind === 'track') {
      arenaAlias.set(String(n.id), arenaAliases(n))
      arenaKind.set(String(n.id), String(n.kind))
    }
  }
  const arenaForFolder = (f: string): string | null => {
    const fl = (f || '').trim().toLowerCase()
    const hits: string[] = []
    for (const [pid, al] of arenaAlias) if (al.has(fl)) hits.push(pid)
    return hits.length === 1 ? hits[0] : null
  }

  const noteAlias = new Map<string, string>() // "<arena>/<arena>.md" rel → product node id
  for (const n of vault.nodes) {
    const rel = String(n.id)
    const f = n.group
    if (!f || f === '(root)') continue
    const pid = arenaForFolder(f)
    if (pid && rel.toLowerCase().endsWith('.md')) {
      const nameBase = relBasename(rel).slice(0, -3).trim().toLowerCase()
      if (arenaAlias.get(pid)?.has(nameBase)) noteAlias.set(rel, pid)
    }
  }

  add(CORE, { kind: 'core', label: 'DUIN CORE', layer: 'core' })
  const today7 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // ── product nodes ─────────────────────────────────────────────────────────
  for (const n of prod.nodes) {
    if (n.kind === 'person' || n.kind === 'org') continue // merged into the vault note below
    const extra: Node = {}
    if (n.kind === 'project') {
      const lu = projectLogoUrl(logoDir, String(n.id))
      if (lu) extra.logo = lu
    } else if (n.kind === 'event' || n.kind === 'milestone' || n.kind === 'release') {
      const d = String((n.target as string) || (n.decide_by as string) || '').slice(0, 10)
      if (d) {
        extra.date = d
        extra.passed = d.slice(0, 7) < today7
      }
      const ep = eventPrep(vaultDir, String(n.id))
      if (ep.ok && ep.counts) {
        const pc = ep.counts.tasks + ep.counts.moves
        if (pc) extra.prep = pc
      }
    }
    add(String(n.id), {
      kind: n.kind,
      label: (n.title as string) || String(n.id),
      layer: 'product',
      declared: (n.declared as number) ?? 1,
      group: n.kind,
      ...extra
    })
  }

  // ── vault notes ───────────────────────────────────────────────────────────
  const ntags = vault.note_tags || {}
  for (const n of vault.nodes) {
    const rid = String(n.id)
    if (noteAlias.has(rid)) continue // folded into its arena's product node
    const g = n.group || ''
    const low = ('/' + rid + '/').toLowerCase()
    const k = personPaths.has(rid)
      ? 'person'
      : orgPaths.has(rid)
        ? 'org'
        : g === '02 Cards' || low.includes('/knowledge/') || low.includes('/instincts/')
          ? 'card'
          : g === '05 Decisions' || low.includes('/decisions/')
            ? 'decision'
            : 'note'
    const tg = [...(ntags[rid] || [])].sort().slice(0, 16)
    add(rid, {
      kind: k,
      label: (n.label as string) || rid,
      layer: 'vault',
      group: n.group || '',
      ...(tg.length ? { tags: tg } : {})
    })
  }

  // ── folder hubs ───────────────────────────────────────────────────────────
  const folders = [...new Set(vault.nodes.map((n) => n.group).filter((g) => g && g !== '(root)'))].sort()
  const folderHub = new Map<string, string>()
  for (const f of folders) {
    const pid = arenaForFolder(f)
    if (pid) {
      folderHub.set(f, pid) // the product node IS the hub
    } else {
      folderHub.set(f, `__folder__${f}`)
      add(`__folder__${f}`, { kind: 'folder', label: f, layer: 'folder', group: f })
    }
  }

  // ── edges ─────────────────────────────────────────────────────────────────
  const edges: Edge[] = []
  const edgePairs = new Set<string>()
  const pairKey = (s: string, t: string): string => (s < t ? s + '\0' + t : t + '\0' + s)
  const link = (s0: string, t0: string, ty: string): void => {
    const s = noteAlias.get(s0) ?? s0
    const t = noteAlias.get(t0) ?? t0
    if (seen.has(s) && seen.has(t) && s !== t) {
      const key = pairKey(s, t)
      if (edgePairs.has(key)) return
      edgePairs.add(key)
      edges.push({ source: s, target: t, type: ty })
    }
  }

  for (const e of prod.edges) link(e.src, e.dst, e.type ?? 'rel')
  for (const l of vault.links) link(l.source, l.target, 'wiki')
  for (const f of folders) link(CORE, folderHub.get(f) as string, 'domain')
  for (const n of vault.nodes) {
    const f = n.group
    if (!f || f === '(root)') continue
    const hub = folderHub.get(f) as string
    if (arenaKind.get(hub) === 'project') continue // proj-assoc owns these (clustered)
    link(hub, String(n.id), 'in')
  }
  for (const n of prod.nodes) {
    if (['goal', 'event', 'milestone', 'release', 'project', 'track'].includes(String(n.kind)))
      link(CORE, String(n.id), 'anchors')
  }
  const projs = prod.nodes.filter((n) => n.kind === 'project').map((n) => String(n.id))

  // ── PROJECT ASSOCIATIONS ──────────────────────────────────────────────────
  const REF_CLUSTER_MIN = 2
  const projAlias = new Map<string, Set<string>>()
  for (const pn of projs) {
    const first = pn.split(/\s+/).filter(Boolean)[0]
    const al = new Set<string>([pn.toLowerCase(), stripPy(pn, '《》 ').toLowerCase(), (first ?? pn).toLowerCase()])
    const clean = new Set<string>()
    for (const a of al) if (a) clean.add(a)
    projAlias.set(pn, clean)
  }
  const noteRefs = vault.note_refs || {}
  const noteTags = vault.note_tags || {}
  const projAssoc = new Map<string, Set<string>>()
  for (const pn of projs) projAssoc.set(pn, new Set<string>())
  const NOISE = ['/backups/', '/_state/', '/snapshot', '/runtime-', '/.daily-ingest', '/_archive/']
  for (const n of vault.nodes) {
    const rel = String(n.id)
    if (rel.startsWith('.duin/') || NOISE.some((s) => ('/' + rel).includes(s))) continue
    const relpath = ('/' + rel + '/').toLowerCase()
    const refs = noteRefs[rel] || []
    const tags = noteTags[rel] || []
    for (const [pn, al] of projAlias) {
      if (rel.startsWith(`03 Projects/${pn}`) || rel.startsWith(`${pn}/`)) {
        projAssoc.get(pn)!.add(rel)
        continue
      }
      const wl = refs.some((r) => [...al].some((a) => r.includes(a)))
      const tg = tags.some((t) => [...al].some((a) => t.startsWith(a)))
      const pa = [...al].some((a) => relpath.includes('/' + a + '/'))
      if (wl || tg || pa) projAssoc.get(pn)!.add(rel)
    }
  }
  for (const [pn, relsSet] of projAssoc) {
    const byFolder = new Map<string, string[]>()
    for (const rel of [...relsSet].sort()) {
      // sorted: content-safe (set-driven dedup), deterministic emission
      const key = clusterKey(rel)
      if (!byFolder.has(key)) byFolder.set(key, [])
      byFolder.get(key)!.push(rel)
    }
    for (const [folder, members] of byFolder) {
      if (members.length >= REF_CLUSTER_MIN) {
        const idx = `__projidx__${pn}__${folder}`
        const leaf = relBasename(folder) || folder
        add(idx, { kind: 'index', label: `▸ ${leaf}`, layer: 'folder', group: folder })
        link(pn, idx, 'indexes')
        for (const rel of members) link(idx, rel, 'in')
      } else {
        for (const rel of members) link(pn, rel, 'about')
      }
    }
  }

  // ── PRODUCT REFERENCES ────────────────────────────────────────────────────
  const vidx = new Map<string, string>()
  for (const n of vault.nodes) {
    const key = String(n.label ?? '').toLowerCase()
    if (!vidx.has(key)) vidx.set(key, String(n.id))
  }
  for (const n of prod.nodes) {
    if (n.kind === 'person' || n.kind === 'org' || n.kind === 'project') continue
    let blob = (n.body as string) || ''
    const ex = n.extra
    if (ex) blob += ' ' + (typeof ex === 'string' ? ex : JSON.stringify(ex))
    if (!blob) continue
    let m: RegExpExecArray | null
    const re = new RegExp(WIKILINK.source, 'g')
    while ((m = re.exec(blob)) !== null) {
      let tgt = relBasename(m[1]).trim().toLowerCase()
      if (tgt.endsWith('.md')) tgt = tgt.slice(0, -3)
      const dst = vidx.get(tgt)
      if (dst) {
        link(String(n.id), dst, 'refs')
      } else {
        for (const [pn, al] of projAlias) {
          if (al.has(tgt) || [...al].some((a) => tgt.includes(a))) {
            link(String(n.id), pn, 'refs')
            break
          }
        }
      }
    }
  }

  // ── GENERIC FAN-OUT CLUSTERING ────────────────────────────────────────────
  const GEN_MIN = 5
  const GEN_ANCHORS = new Set(['person', 'org', 'goal', 'track', 'strategy', 'move', 'insight', 'risk'])
  const GEN_LEAVES = new Set(['note', 'person', 'org'])
  const byid = new Map<string, Node>()
  for (const n of nodes) byid.set(String(n.id), n)
  const topicOf = (nid: string): string | null => {
    const n = byid.get(nid)
    if (!n || !GEN_LEAVES.has(String(n.kind))) return null
    return topicKey(String(n.group || ''))
  }
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set())
    if (!adj.has(e.target)) adj.set(e.target, new Set())
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }
  const toRemove = new Set<string>()
  const toAdd: [string, string, string][] = []
  for (const a of nodes.filter((n) => GEN_ANCHORS.has(String(n.kind)))) {
    const aid = String(a.id)
    const buckets = new Map<string, string[]>()
    for (const nb of [...(adj.get(aid) || [])].sort()) {
      // sorted: content-safe (set-driven dedup), deterministic emission
      const key = topicOf(nb)
      if (key) {
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key)!.push(nb)
      }
    }
    for (const [key, members] of buckets) {
      if (members.length >= GEN_MIN) {
        const hub = `__idx__${key}`
        const leaf = relBasename(key) || key
        add(hub, { kind: 'index', label: `▸ ${leaf}`, layer: 'folder', group: key })
        toAdd.push([aid, hub, 'indexes'])
        for (const m2 of members) {
          toAdd.push([hub, m2, 'in'])
          toRemove.add(pairKey(aid, m2))
        }
      }
    }
  }
  if (toRemove.size) {
    const kept = edges.filter((e) => !toRemove.has(pairKey(e.source, e.target)))
    edges.length = 0
    edges.push(...kept)
    // edgePairs no longer authoritative for removed pairs; rebuild so re-adds land.
    edgePairs.clear()
    for (const e of edges) edgePairs.add(pairKey(e.source, e.target))
  }
  for (const [s, t, ty] of toAdd) link(s, t, ty)

  // ── deep OKRs (goal + kr nodes added directly) ────────────────────────────
  for (const o of listOkrs(vaultDir)) {
    if (o.kind === 'goal') {
      add(o.id, { kind: 'goal', label: o.title, layer: 'product', group: 'goal', desc: o.desc || '' })
      if (o.project) link(o.project, o.id, 'contains')
      link(CORE, o.id, 'anchors')
    } else {
      add(o.id, {
        kind: 'kr',
        label: o.title,
        layer: 'product',
        group: 'kr',
        parent: o.parent || '',
        status: o.status || '',
        state: o.state || '',
        progress: o.progress || '',
        owner: o.owner || '',
        due: o.due || ''
      })
      if (o.parent) link(o.parent, o.id, 'has_kr')
    }
  }

  // ── NO ISLANDS: any still-loose node hangs off CORE ───────────────────────
  const deg = new Map<string, number>()
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) || 0) + 1)
    deg.set(e.target, (deg.get(e.target) || 0) + 1)
  }
  for (const n of nodes) {
    const id = String(n.id)
    if (id !== CORE && (deg.get(id) || 0) === 0) link(CORE, id, 'loose')
  }

  const graph: BrainGraph = { nodes, links: edges, core: CORE, stats: { nodes: nodes.length, edges: edges.length } }

  // ── ENTITY OVERLAY (flag-gated, ON by default) ─────────────────────────────
  // The home MAP is composed from the product store + vault cloud, and now also
  // includes the LLM-constructed entity layer (getConstruction) that drives
  // retrieval. Default ON: the overlay runs unless DUIN_MAP_ENTITY_OVERLAY==='0'.
  // This is a PURE post-composition addition — when disabled (='0') NOTHING below
  // runs and `graph` is returned exactly as before, byte/content-identical to the
  // Python golden. The overlay itself is deterministic and idempotent (id/undirected-pair
  // dedup, native ids authoritative on collision, self/dangling edges dropped).
  if (process.env.DUIN_MAP_ENTITY_OVERLAY !== '0') {
    // Identity-spine P6: the entity resolver (DUIN_ENTITY_RESOLVER, default-ON since P3)
    // collapses whitelisted duplicate entity ids onto their stable canonical id BEFORE the
    // merge, so the MAP dedups the churning slug variants (ProjectA×4 → one node). This now reads
    // the SHARED, memoized getResolvedConstruction() so there is ONE resolver call site across
    // the MAP, retrieval, the benchmark, and the mergedGraph surfaces — no per-caller drift.
    // Under DUIN_ENTITY_RESOLVER=0 it is a raw passthrough ⇒ MAP unchanged.
    const construction = getResolvedConstruction()
    if (construction) {
      // Identity-spine P6 step ④ — CLOSE THE PRODUCT SEAM. The product project/track nodes were
      // minted by THIS file's own loop (above) with their BARE store id — cards-native emits
      // `id = the raw project field` (e.g. 'ProjectA'), NOT via normalizeStoreId — so a product 'ProjectA'
      // and the resolver's canonical construction id 'project:ProjectA' would render as TWO separate
      // MAP nodes (the arena/vaultRel fold only collapses vault NOTES/folders, never construction
      // entity ids). Fold the product node onto the construction canonical id (STORE_PROJECT_ALIAS
      // via normalizeStoreId) so buildDuinGraph's base-wins byId merges them into ONE node.
      // Gated INSIDE the overlay block AND requires the canonical id to actually EXIST in the
      // construction, so the base MAP (overlay off / no construction) is byte-parity untouched.
      const constructionIds = new Set(construction.entities.map((e) => e.id))
      // Cold-start A3 emptied the built-in STORE_PROJECT_ALIAS, so the fold table is now the
      // VAULT's (`.duin/_state/store-project-alias.json`). Reading the built-in here would make
      // the seam permanently unclosable rather than merely unconfigured.
      const projectAlias = loadStoreProjectAlias(vaultDir)
      const rename = new Map<string, string>()
      for (const n of graph.nodes) {
        if (n.layer !== 'product') continue
        const k = String(n.kind ?? '')
        if (k !== 'project' && k !== 'track') continue
        const rawId = String(n.id ?? '')
        const canon = normalizeStoreId(rawId, k, projectAlias)
        // Fold ONLY onto a canonical id the construction actually mints, and never collide onto
        // an id already present on the MAP (base-wins; first claim keeps it deterministic).
        if (canon === rawId || !constructionIds.has(canon)) continue
        if (seen.has(canon) || [...rename.values()].includes(canon)) continue
        rename.set(rawId, canon)
      }
      let baseNodes: Node[] = graph.nodes
      let baseLinks: Edge[] = graph.links
      if (rename.size) {
        baseNodes = graph.nodes.map((n) =>
          rename.has(String(n.id)) ? { ...n, id: rename.get(String(n.id)) as string } : n
        )
        const pairs = new Set<string>()
        baseLinks = []
        for (const e of graph.links) {
          const s = rename.get(e.source) ?? e.source
          const t = rename.get(e.target) ?? e.target
          if (s === t) continue // self-loop after the fold
          const pk = pairKey(s, t)
          if (pairs.has(pk)) continue // duplicate undirected pair after the fold
          pairs.add(pk)
          baseLinks.push({ ...e, source: s, target: t })
        }
      }

      // Phase B-2: overlayConstruction folded into the ONE shared builder. MAP shape:
      // productLayer:'construction' tags each added entity {layer:'construction',group:kind};
      // dedup:'undirected' = one typed edge per unordered pair (native ids authoritative).
      const built = buildDuinGraph({
        base: { nodes: baseNodes, edges: baseLinks },
        construction,
        dedup: 'undirected',
        productLayer: 'construction',
        // MAP ONLY. Roughly half this graph is `topic`, and most of those relate to nothing and appear in
        // one note — a single document's vocabulary rather than structure to navigate by. The
        // retrieval traversal and `/graph` deliberately do NOT opt in: dropping nodes from
        // retrieval is a separate decision needing its own evidence. See pruneUnstructuredTopics.
        pruneUnstructuredTopics: true
      })
      return {
        ...graph,
        nodes: built.nodes as unknown as Node[],
        links: built.edges as unknown as Edge[],
        stats: { nodes: built.nodes.length, edges: built.edges.length }
      }
    }
  }

  return graph
}

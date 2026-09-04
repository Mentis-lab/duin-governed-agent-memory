import { describe, it, expect } from 'vitest'
import { cullForLod, idOf, type LodNode, type LodLink, focusNeighbourhood, DEFAULT_FAN_OUT, budgetBySalience } from './graph-lod'

const BULK = new Set(['mentions', 'synonym'])
/** Only `core` is structural in these fixtures; everything else earns its place by degree. */
const roleIsCore = (n: LodNode): boolean => n.kind === 'core'

function n(id: string, kind = 'note'): LodNode {
  return { id, kind }
}
function l(source: string, target: string, type = 'link'): LodLink {
  return { source, target, type }
}

/** Degree of every surviving node, counted over the surviving links. */
function degrees(r: { nodes: LodNode[]; links: LodLink[] }): Map<string, number> {
  const d = new Map<string, number>()
  for (const node of r.nodes) d.set(node.id, 0)
  for (const link of r.links) {
    d.set(idOf(link.source), (d.get(idOf(link.source)) || 0) + 1)
    d.set(idOf(link.target), (d.get(idOf(link.target)) || 0) + 1)
  }
  return d
}

describe('cullForLod', () => {
  it('keeps a node that reaches minDegree on non-bulk links', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const links = [l('a', 'b'), l('a', 'c')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).toContain('a')
  })

  it('ignores bulk link families when computing degree', () => {
    // `x` has two edges, but both are bulk — it must not survive on them.
    const nodes = [n('x'), n('y'), n('z')]
    const links = [l('x', 'y', 'mentions'), l('x', 'z', 'synonym')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).not.toContain('x')
  })

  it('drops degree-1 leaves that are not structural', () => {
    const nodes = [n('hub'), n('a'), n('b'), n('leaf')]
    const links = [l('hub', 'a'), l('hub', 'b'), l('leaf', 'a')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    // `leaf` has degree 1 and no role — it goes.
    expect(r.nodes.map((x) => x.id)).not.toContain('leaf')
  })

  it('keeps a role node however sparsely linked', () => {
    const nodes = [n('core', 'core'), n('a'), n('b'), n('c')]
    const links = [l('core', 'a'), l('a', 'b'), l('a', 'c')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).toContain('core')
  })

  // ── the regression this module was extracted for ────────────────────────────────────
  it('never strands a kept node that has neighbours available', () => {
    // `core` is kept for its role. Its ONLY neighbour is `leaf`, a degree-1 node the plain
    // degree rule culls — which used to leave `core` at degree 0 in the drawn graph. A
    // degree-0 node has no link force acting on it, so charge alone flings it to the rim.
    const nodes = [n('core', 'core'), n('leaf'), n('h1'), n('h2'), n('h3')]
    const links = [l('core', 'leaf'), l('h1', 'h2'), l('h1', 'h3'), l('h2', 'h3')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })

    const ids = r.nodes.map((x) => x.id)
    expect(ids).toContain('core')
    expect(ids).toContain('leaf') // rescued so `core` arrives attached
    expect(degrees(r).get('core')).toBeGreaterThan(0)
  })

  it('rescues the highest-degree neighbour, re-attaching to structure not to another leaf', () => {
    // `core`'s neighbours are `weak` (degree 1) and `strong` (degree 1 here, but 3 overall
    // once its own edges count). The rescue must pick `strong`.
    const nodes = [n('core', 'core'), n('weak'), n('strong'), n('s1'), n('s2')]
    const links = [
      l('core', 'weak'),
      l('core', 'strong'),
      l('strong', 's1'),
      l('strong', 's2')
    ]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    // `strong` survives on its own degree (3) anyway, so `core` is already attached and no
    // rescue is needed — the invariant still has to hold.
    expect(degrees(r).get('core')).toBeGreaterThan(0)
    expect(r.nodes.map((x) => x.id)).toContain('strong')
  })

  it('leaves a genuinely isolated node isolated without throwing', () => {
    const nodes = [n('lonely', 'core'), n('h1'), n('h2'), n('h3')]
    const links = [l('h1', 'h2'), l('h1', 'h3'), l('h2', 'h3')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).toContain('lonely') // kept for its role
    expect(degrees(r).get('lonely')).toBe(0) // nothing to attach it to — honest outcome
  })

  // ── the bulk-edge fallback: 3,327 live nodes have NOTHING but a `mentions` edge ──
  it('rescues through a bulk edge when that is the only connection a kept node has', () => {
    // `char` is role-kept and its sole link is `mentions` — the shape of a game character that
    // reached the graph because notes mention it. Dropping bulk links strands it at the rim.
    const nodes = [n('char', 'core'), n('hub'), n('h1'), n('h2')]
    const links = [l('char', 'hub', 'mentions'), l('hub', 'h1'), l('hub', 'h2'), l('h1', 'h2')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).toContain('char')
    expect(degrees(r).get('char')).toBeGreaterThan(0)
    // the EDGE must come back too — admitting only the neighbour leaves the same picture
    expect(r.links.some((x) => idOf(x.source) === 'char' || idOf(x.target) === 'char')).toBe(true)
  })

  it('prefers a strong edge over a bulk one when both are available', () => {
    const nodes = [n('x', 'core'), n('weak'), n('strong'), n('s1'), n('s2')]
    const links = [
      l('x', 'weak', 'mentions'),
      l('x', 'strong'),
      l('strong', 's1'),
      l('strong', 's2')
    ]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    const ids = r.nodes.map((y) => y.id)
    expect(ids).toContain('strong')
    expect(ids).not.toContain('weak') // reachable only over a bulk edge, and not needed
  })

  it('re-admits ONE bulk edge per rescued node, not the whole bulk family', () => {
    const nodes = [n('a', 'core'), n('b', 'core'), n('hub'), n('h1'), n('h2')]
    const links = [
      l('a', 'hub', 'mentions'), l('a', 'h1', 'mentions'), l('a', 'h2', 'mentions'),
      l('b', 'hub', 'synonym'),
      l('hub', 'h1'), l('hub', 'h2'), l('h1', 'h2')
    ]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.links.filter((x) => BULK.has(String(x.type)))).toHaveLength(2)
  })

  it('the invariant: every survivor with a neighbour in the source graph keeps one', () => {
    // A spray of role nodes each hanging off its own leaf — the exact shape that produced
    // 280 degree-0 nodes on the live vault.
    const nodes: LodNode[] = []
    const links: LodLink[] = []
    for (let i = 0; i < 20; i++) {
      nodes.push(n(`core${i}`, 'core'), n(`leaf${i}`))
      links.push(l(`core${i}`, `leaf${i}`))
    }
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    const deg = degrees(r)
    const stranded = r.nodes.filter((x) => (deg.get(x.id) || 0) === 0)
    expect(stranded).toHaveLength(0)
  })

  it('emits only links whose endpoints both survived', () => {
    const nodes = [n('hub'), n('a'), n('b'), n('leaf')]
    const links = [l('hub', 'a'), l('hub', 'b'), l('a', 'b'), l('leaf', 'hub')]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    const ids = new Set(r.nodes.map((x) => x.id))
    for (const link of r.links) {
      expect(ids.has(idOf(link.source))).toBe(true)
      expect(ids.has(idOf(link.target))).toBe(true)
    }
  })

  it('reads source/target that force-graph has rewritten into node objects', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const links: LodLink[] = [
      { source: { id: 'a' }, target: { id: 'b' }, type: 'link' },
      { source: { id: 'a' }, target: { id: 'c' }, type: 'link' }
    ]
    const r = cullForLod(nodes, links, { bulkLinkTypes: BULK, isRoleKept: roleIsCore })
    expect(r.nodes.map((x) => x.id)).toContain('a')
  })
})

// The centre-force mapping (slider → forceX/forceY strength) is tested where it lives now:
// graph-layout-forces.test.ts.

// ── focus neighbourhood ───────────────────────────────────────────────────────────
//
// Two operator reports, hours apart, that pull in opposite directions. Both have to hold.
//
//   1. "the connection highlights are so connected it's no longer relevant." — a flat
//      2-hop BFS through one hub lit the whole graph.
//   2. "connection depth highlighting is currently broken." — the degree gate that
//      answered (1) made depth a no-op: on the live vault the derived threshold was 12,
//      75% of an ordinary node's neighbours sat above it, and the median lit set was 4 at
//      every depth from 2 to 5. Stepping 1→2 changed nothing for 47 of 80 anchors.
//
// The rule is a per-node fan-out budget (see graph-lod.ts). The shapes below are the two
// reports: a hub joined to 40 leaves, and an anchor whose only neighbours are hubs.

function graphOf(edges: [string, string][]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  const add = (a: string, b: string): void => {
    let s = m.get(a)
    if (!s) { s = new Set(); m.set(a, s) }
    s.add(b)
  }
  for (const [a, b] of edges) { add(a, b); add(b, a) }
  return m
}

/** a — hub — b, plus the hub wired to 40 unrelated leaves. */
function hubEdges(): [string, string][] {
  const edges: [string, string][] = [['a', 'hub'], ['hub', 'b']]
  for (let i = 0; i < 40; i++) edges.push(['hub', `leaf${i}`])
  return edges
}
const hubGraph = (): Map<string, Set<string>> => graphOf(hubEdges())

/** An anchor whose only neighbours are two hubs — the shape most live-vault nodes have. */
function hubDenseGraph(): Map<string, Set<string>> {
  const edges: [string, string][] = [['a', 'h1'], ['a', 'h2']]
  for (let i = 0; i < 30; i++) {
    edges.push(['h1', `p${i}`], [`p${i}`, `r${i}`]) // h1's neighbours each lead one hop further
    edges.push(['h2', `q${i}`])                    // h2's are dead ends
  }
  return graphOf(edges)
}

describe('focusNeighbourhood — every hop lights more, and no hop floods through a hub', () => {
  it('REPORT 1: 2 hops from an ordinary node through a hub lights a budget, not the graph', () => {
    const lit = focusNeighbourhood('a', hubGraph(), { depth: 2 })
    expect(lit.has('a')).toBe(true)
    expect(lit.has('hub')).toBe(true)
    // the hub contributes its fan-out and no more — 43 was the blowout
    expect(lit.size).toBe(2 + DEFAULT_FAN_OUT)
  })

  it('REPORT 2: on a hub-dense graph each extra hop still lights MORE than the last', () => {
    const g = hubDenseGraph()
    const sizes = [1, 2, 3].map((d) => focusNeighbourhood('a', g, { depth: d }).size)
    expect(sizes[0]).toBe(3) // a + h1 + h2
    expect(sizes[1]).toBeGreaterThan(sizes[0])
    expect(sizes[2]).toBeGreaterThan(sizes[1])
    // and each hop is bounded by the budget: at most fanOut per node on the frontier
    expect(sizes[1] - sizes[0]).toBeLessThanOrEqual(2 * DEFAULT_FAN_OUT)
  })

  it('still expands normally where there is no hub — depth 2 stays useful', () => {
    const g = graphOf([['a', 'b'], ['b', 'c'], ['c', 'd']])
    const lit = focusNeighbourhood('a', g, { depth: 2 })
    expect([...lit].sort()).toEqual(['a', 'b', 'c'])
  })

  // Focusing a hub is a deliberate question — "what does this touch?" — and refusing to
  // answer it because the node has many edges would suppress the one case where the
  // operator asked on purpose.
  it('ALWAYS expands the anchor itself in full, however connected it is', () => {
    const lit = focusNeighbourhood('hub', hubGraph(), { depth: 1 })
    expect(lit.size).toBe(43) // hub + a + b + 40 leaves
    expect(lit.has('leaf7')).toBe(true)
  })

  it('depth 1 is exactly the anchor and its direct neighbours', () => {
    const lit = focusNeighbourhood('b', graphOf([['a', 'b'], ['b', 'c'], ['c', 'd']]), { depth: 1 })
    expect([...lit].sort()).toEqual(['a', 'b', 'c'])
  })

  it('an isolated node lights only itself, and does not throw', () => {
    expect([...focusNeighbourhood('lonely', graphOf([['a', 'b']]), { depth: 3 })]).toEqual(['lonely'])
  })

  it('terminates on a cycle', () => {
    const lit = focusNeighbourhood('a', graphOf([['a', 'b'], ['b', 'c'], ['c', 'a']]), { depth: 9 })
    expect([...lit].sort()).toEqual(['a', 'b', 'c'])
  })

  it('spends the budget on the most SPECIFIC neighbours — leaves before sub-hubs', () => {
    // The hub touches a budget's worth of leaves and as many sub-hubs (8 more edges
    // each). From `a`, the hub's budget goes to the leaves: those are the relationships
    // that say something.
    const K = DEFAULT_FAN_OUT
    const edges: [string, string][] = [['a', 'hub']]
    for (let i = 0; i < K; i++) edges.push(['hub', `leaf${i}`])
    for (let i = 0; i < K; i++) {
      edges.push(['hub', `sub${i}`])
      for (let j = 0; j < 8; j++) edges.push([`sub${i}`, `sub${i}-${j}`])
    }
    const lit = focusNeighbourhood('a', graphOf(edges), { depth: 2 })
    for (let i = 0; i < K; i++) {
      expect(lit.has(`leaf${i}`)).toBe(true)
      expect(lit.has(`sub${i}`)).toBe(false)
    }
  })

  it('is deterministic regardless of edge insertion order', () => {
    const fwd = focusNeighbourhood('a', graphOf(hubEdges()), { depth: 2 })
    const rev = focusNeighbourhood('a', graphOf([...hubEdges()].reverse()), { depth: 2 })
    expect([...fwd].sort()).toEqual([...rev].sort())
  })

  it('maxLit truncates by hop — the nearest survive', () => {
    const lit = focusNeighbourhood('hub', hubGraph(), { depth: 2, maxLit: 5 })
    expect(lit.size).toBeLessThanOrEqual(5)
    expect(lit.has('hub')).toBe(true)
  })

  it('a node with no more unseen neighbours than the budget is lit in full — the budget truncates, it never shrinks', () => {
    // a — hub, and the hub touches exactly a budget's worth of others: nothing is cut.
    // Which is what makes the budget, not the traversal, the thing doing the work.
    const edges: [string, string][] = [['a', 'hub']]
    for (let i = 0; i < DEFAULT_FAN_OUT; i++) edges.push(['hub', `n${i}`])
    const lit = focusNeighbourhood('a', graphOf(edges), { depth: 2 })
    expect(lit.size).toBe(2 + DEFAULT_FAN_OUT)
  })
})

describe('budgetBySalience — a fixed number on screen, the skeleton first, then the most salient', () => {
  const sal = (n: LodNode): number => Number(n.s ?? 0)
  const isCore = (n: LodNode): boolean => n.kind === 'core'
  const sn = (id: string, s: number, kind = 'note'): LodNode => ({ id, kind, s })

  it('is a no-op at or under the budget', () => {
    const nodes = [sn('a', 1), sn('b', 2)]
    const links = [l('a', 'b')]
    const r = budgetBySalience(nodes, links, { budget: 2, isRoleKept: isCore, salienceOf: sal })
    expect(r.nodes).toBe(nodes)
    expect(r.links).toBe(links)
  })

  it('keeps the skeleton even when it alone exceeds the budget', () => {
    const nodes = [sn('c1', 0, 'core'), sn('c2', 0, 'core'), sn('c3', 0, 'core'), sn('x', 99)]
    const r = budgetBySalience(nodes, [], { budget: 2, isRoleKept: isCore, salienceOf: sal })
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('spends the remainder on the most salient, deterministically', () => {
    const nodes = [sn('core', 0, 'core'), sn('low', 1), sn('mid', 5), sn('high', 9), sn('tie1', 5)]
    const r = budgetBySalience(nodes, [], { budget: 3, isRoleKept: isCore, salienceOf: sal })
    // core + high + (mid vs tie1 at 5: id order → mid)
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['core', 'high', 'mid'])
  })

  it('rescues a kept node whose neighbours all fell under the budget, via its most salient neighbour', () => {
    const nodes = [sn('core', 0, 'core'), sn('hub', 9), sn('leafA', 1), sn('leafB', 2)]
    const links = [l('hub', 'leafA'), l('hub', 'leafB')]
    // budget 2 → core + hub; hub would float → its most salient neighbour (leafB) comes back with the edge
    const r = budgetBySalience(nodes, links, { budget: 2, isRoleKept: isCore, salienceOf: sal })
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['core', 'hub', 'leafB'])
    expect(r.links).toEqual([l('hub', 'leafB')])
  })

  it('the invariant: every survivor with a neighbour in the source graph keeps at least one', () => {
    const nodes = [sn('core', 0, 'core'), sn('hub', 9), sn('leafA', 1), sn('leafB', 2), sn('far', 5)]
    const links = [l('hub', 'leafA'), l('hub', 'leafB'), l('core', 'leafA'), l('far', 'leafB')]
    const r = budgetBySalience(nodes, links, { budget: 2, isRoleKept: isCore, salienceOf: sal })
    const d = degrees(r)
    const hasNeighbour = new Set(links.flatMap((x) => [idOf(x.source), idOf(x.target)]))
    for (const node of r.nodes) if (hasNeighbour.has(node.id)) expect(d.get(node.id) || 0).toBeGreaterThan(0)
  })

  it('emits only links whose endpoints both survived', () => {
    const nodes = [sn('a', 9), sn('b', 8), sn('c', 1), sn('d', 0)]
    const links = [l('a', 'b'), l('c', 'd')]
    const r = budgetBySalience(nodes, links, { budget: 2, isRoleKept: isCore, salienceOf: sal })
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(r.links).toEqual([l('a', 'b')])
  })
})

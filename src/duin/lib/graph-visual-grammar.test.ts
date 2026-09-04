import { describe, expect, it } from 'vitest'
import {
  POINT_SHAPE, shapeForNode, linkProvenance, arrowForLink, litLinks, GREYOUT, LINK_GRADIENT_AT_IDLE, LINK_GRADIENT_IN_FOCUS,
  NODE_SIZE, LAYER_WEIGHT, sizeForNode, layerAlpha, linkInkBoost, blendHex, CLUSTER_TINT, clusterDisplayLabel,
  FOCUS_ZOOM, FIT_PADDING, frameIndices, labelBudget, estimateLabelWidth, placeLabels,
} from './graph-visual-grammar'

describe('shapeForNode: shape is spent on kind FAMILIES the operator navigates by', () => {
  it('gives the skeleton its own marks', () => {
    expect(shapeForNode({ kind: 'core' })).toBe(POINT_SHAPE.star)
    expect(shapeForNode({ kind: 'folder' })).toBe(POINT_SHAPE.hexagon)
  })
  it('groups the roadmap by family, not by kind', () => {
    for (const k of ['project', 'track', 'strategy', 'move']) expect(shapeForNode({ kind: k })).toBe(POINT_SHAPE.pentagon)
    for (const k of ['goal', 'kr']) expect(shapeForNode({ kind: k })).toBe(POINT_SHAPE.triangle)
    for (const k of ['event', 'milestone', 'release']) expect(shapeForNode({ kind: k })).toBe(POINT_SHAPE.diamond)
    expect(shapeForNode({ kind: 'org' })).toBe(POINT_SHAPE.square)
    for (const k of ['risk', 'issue', 'owed']) expect(shapeForNode({ kind: k })).toBe(POINT_SHAPE.cross)
  })
  it('leaves the bulk of the map a circle, unknown kinds included', () => {
    for (const k of ['note', 'card', 'page', 'topic', 'decision', 'person', 'index', 'whatever', undefined]) {
      expect(shapeForNode({ kind: k })).toBe(POINT_SHAPE.circle)
    }
    expect(shapeForNode(null)).toBe(POINT_SHAPE.circle)
  })
})

describe('link provenance: what the operator wrote vs what the construction pass inferred (the tooltip reads it)', () => {
  it('declared = typed wikilinks and vault/product structure', () => {
    for (const t of ['wiki', 'wikilink', 'link', 'refs', 'in', 'contains', 'anchors', 'indexes', 'domain', 'has_kr', 'builds_toward', 'guides']) {
      expect(linkProvenance(t)).toBe('declared')
    }
  })
  it('inferred = every LLM-extracted relation, and anything unknown', () => {
    for (const t of ['about', 'affects', 'attends', 'owns', 'depends', 'blocks', 'part-of', 'mentions', 'loose', 'synonym', 'never-seen', undefined, null]) {
      expect(linkProvenance(t)).toBe('inferred')
    }
  })
})

describe('the endpoint gradient: off at idle (imperceptible at whisper alpha), on in focus (the operator\'s verdict)', () => {
  it('idle off, focus on', () => {
    expect(LINK_GRADIENT_AT_IDLE).toBe(false)
    expect(LINK_GRADIENT_IN_FOCUS).toBe(true)
  })
})

describe('arrowForLink: a direction the operator can read', () => {
  it('directed relations get an arrowhead', () => {
    for (const t of ['wiki', 'about', 'affects', 'attends', 'owns', 'depends', 'blocks', 'part-of', 'mentions', 'builds_toward']) {
      expect(arrowForLink(t)).toBe(true)
    }
  })
  it('containment and symmetric edges do not', () => {
    for (const t of ['in', 'contains', 'anchors', 'indexes', 'domain', 'loose', 'synonym']) expect(arrowForLink(t)).toBe(false)
  })
})

describe('litLinks: the neighbourhood\'s own edges, in cosmos link order', () => {
  // points: 0 anchor, 1 and 2 neighbours, 3 outside
  const pairs = new Float32Array([
    0, 1, // 0: anchor–neighbour  (incident)
    2, 0, // 1: neighbour–anchor  (incident, reversed)
    1, 2, // 2: neighbour–neighbour (lit at depth ≥ 2, not incident)
    1, 3, // 3: neighbour–outside (dark)
    3, 2, // 4: outside–neighbour (dark)
  ])
  it('lights a link only when both endpoints are lit, and tiers the anchor\'s own links', () => {
    const r = litLinks(pairs, new Set([0, 1, 2]), 0)
    expect(r.indices).toEqual([0, 1, 2])
    expect(r.incident).toEqual([0, 1])
  })
  it('with no anchor (a lens alone) nothing is incident, the lit set still applies', () => {
    const r = litLinks(pairs, new Set([1, 2, 3]), undefined)
    expect(r.indices).toEqual([2, 3, 4])
    expect(r.incident).toEqual([])
  })
  it('an empty lit set lights nothing (cosmos then greys every link)', () => {
    expect(litLinks(pairs, new Set(), 0)).toEqual({ indices: [], incident: [] })
  })
})

describe('sizeForNode: one radius rule for every painter (2026-09-03: small core, capped hubs, extracted layer behind)', () => {
  it('core is a mark, folders and hubs as before, the biggest hub capped', () => {
    expect(sizeForNode({ kind: 'core' })).toBe(NODE_SIZE.core)
    expect(NODE_SIZE.core).toBeLessThan(6)
    expect(sizeForNode({ kind: 'folder' })).toBe(3.5)
    expect(sizeForNode({ kind: 'project', layer: 'product', deg: 4 })).toBeCloseTo(2.4 + Math.sqrt(4) * 0.7, 9)
    expect(sizeForNode({ kind: 'project', layer: 'product', deg: 577 })).toBe(NODE_SIZE.hubCap)
  })
  it('an extracted node draws smaller and fainter than a note of the same degree', () => {
    const note = { kind: 'note', layer: 'vault', deg: 9 }, ent = { kind: 'topic', layer: 'construction', deg: 9 }
    expect(sizeForNode(ent)).toBeCloseTo(sizeForNode(note) * LAYER_WEIGHT.construction.size, 9)
    expect(layerAlpha(ent)).toBe(LAYER_WEIGHT.construction.alpha)
    expect(layerAlpha(note)).toBe(1)
    expect(sizeForNode(null)).toBeGreaterThan(0)
  })
})

describe('linkInkBoost: constant composited density, bounded', () => {
  it('1 at the reference count and above, √ ratio below, capped at 1.8', () => {
    expect(linkInkBoost(16000)).toBe(1)
    expect(linkInkBoost(60000)).toBe(1)
    expect(linkInkBoost(6531)).toBeCloseTo(Math.sqrt(16000 / 6531), 9)
    expect(linkInkBoost(11912)).toBeCloseTo(Math.sqrt(16000 / 11912), 9)
    expect(linkInkBoost(100)).toBe(1.8)
    expect(linkInkBoost(0)).toBe(1.8)
  })
})

describe('blendHex: the cluster tint keeps the folder hue underneath', () => {
  it('interpolates channel-wise and clamps t', () => {
    expect(blendHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(blendHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(blendHex('#ff0000', '#0000ff', 7)).toBe('#0000ff')
  })
  it('leaves anything unparseable alone', () => {
    expect(blendHex('rgba(1,2,3,0.5)', '#ffffff', 0.5)).toBe('rgba(1,2,3,0.5)')
    expect(blendHex('#123456', 'nope', 0.5)).toBe('#123456')
  })
  it('the tint is a lean, not a recolour', () => {
    expect(CLUSTER_TINT).toBeGreaterThan(0.3)
    expect(CLUSTER_TINT).toBeLessThan(0.8)
  })
})

describe('clusterDisplayLabel: a doubled community name collapses, the disambiguating suffix stays', () => {
  it('collapses "X · X" and keeps "#n"', () => {
    expect(clusterDisplayLabel('DUIN · DUIN')).toBe('DUIN')
    expect(clusterDisplayLabel('云雀 · 云雀 #7')).toBe('云雀 #7')
    expect(clusterDisplayLabel('DUIN · DUIN #2')).toBe('DUIN #2')
  })
  it('leaves a real pair and plain names alone', () => {
    expect(clusterDisplayLabel('Kestrel Labs · 云雀')).toBe('Kestrel Labs · 云雀')
    expect(clusterDisplayLabel('3rd, Inc.')).toBe('3rd, Inc.')
    expect(clusterDisplayLabel('  2026-Q2 ')).toBe('2026-Q2')
    expect(clusterDisplayLabel(null)).toBe('')
  })
})

describe('frameIndices: frame the body, let the strays hang off the edge', () => {
  it('drops the far outliers and keeps the rest', () => {
    const xs: number[] = [], ys: number[] = []
    for (let i = 0; i < 200; i++) { xs.push(i % 20); ys.push(Math.floor(i / 20)) }
    xs.push(5000); ys.push(0)   // index 200: a stray far right
    xs.push(0); ys.push(-5000)  // index 201: a stray far up
    const kept = new Set(frameIndices(xs, ys))
    expect(kept.has(200)).toBe(false)
    expect(kept.has(201)).toBe(false)
    expect(kept.size).toBeGreaterThan(180)
  })
  it('too few points: everything is framed', () => {
    const r = frameIndices([0, 10, 1000], [0, 10, 1000])
    expect(r).toEqual([0, 1, 2])
  })
  it('the camera constants are the loosened ones', () => {
    expect(FOCUS_ZOOM).toBeLessThan(6)
    expect(FIT_PADDING).toBeGreaterThan(0.14)
  })
})

describe('labels: a viewport budget and greedy overlap culling', () => {
  it('budget scales with area, floored and capped', () => {
    expect(labelBudget(902, 778)).toBe(25)
    expect(labelBudget(1600, 1000)).toBe(40)
    expect(labelBudget(1600, 1000, 60)).toBe(57)
    expect(labelBudget(100, 100)).toBe(8)
  })
  it('CJK glyphs are wider than Latin ones', () => {
    expect(estimateLabelWidth('云雀游戏', 9)).toBeGreaterThan(estimateLabelWidth('moon', 9))
    expect(estimateLabelWidth('', 9)).toBe(6)
  })
  it('places by priority, skips overlaps, respects the budget', () => {
    const box = (id: string, x: number, y: number, priority: number) => ({ id, x, y, w: 40, h: 12, priority })
    const placed = placeLabels([
      box('low', 100, 100, 1),      // same spot as high: loses
      box('high', 100, 100, 5),
      box('near', 120, 105, 3),     // overlaps high (x 80..120 vs 100..140, y 100..112 vs 105..117): culled
      box('far', 300, 300, 2),
      box('farther', 600, 600, 1.5),
    ], 3)
    expect(placed.map((p) => p.id)).toEqual(['high', 'far', 'farther'])
  })
  it('a zero budget places nothing; ties break by id so placement is deterministic', () => {
    expect(placeLabels([{ id: 'a', x: 0, y: 0, w: 10, h: 10, priority: 1 }], 0)).toEqual([])
    const r = placeLabels([{ id: 'b', x: 500, y: 0, w: 10, h: 10, priority: 1 }, { id: 'a', x: 0, y: 0, w: 10, h: 10, priority: 1 }], 5)
    expect(r.map((p) => p.id)).toEqual(['a', 'b'])
  })
})

describe('greyout lands on the legacy painter\'s accepted look', () => {
  it('dark links: 0.11 whisper × multiplier ≈ 0.03 absolute; points ≈ 0.22', () => {
    expect(0.11 * GREYOUT.dark.link).toBeCloseTo(0.03, 2)
    expect(GREYOUT.dark.point).toBeCloseTo(0.22, 2)
  })
  it('light links: 0.26 × multiplier ≈ 0.1 absolute', () => {
    expect(0.26 * GREYOUT.light.link).toBeCloseTo(0.1, 1)
  })
})

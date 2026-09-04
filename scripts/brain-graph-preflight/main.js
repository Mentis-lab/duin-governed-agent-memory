/* global window, document */
// Offline pre-flight harness: renders the LIVE DUIN map (dumped from the deployed app) through
// @cosmos.gl/graph with the same config cosmos-brain-canvas.tsx uses, then applies the grammar
// under test. Driven by run.cjs (window.__scenario), screenshots judged by eye. Mirrors
// src/duin/lib/graph-visual-grammar.ts by hand: keep the two in step when the grammar changes.
import { Graph } from '@cosmos.gl/graph'

const SPACE = 8192
const G = window.__GRAPH
const nodes = G.nodes, rawLinks = G.links
const idx = new Map(nodes.map((n, i) => [n.id, i]))
const links = rawLinks.filter((l) => idx.has(l.s) && idx.has(l.t))

// world → space transform (pushStructural)
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
for (const n of nodes) { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y }
const span = Math.max(maxX - minX, maxY - minY, 1)
const s = Math.min(2, (SPACE * 0.55) / span)
const ox = SPACE / 2 - ((minX + maxX) / 2) * s, oy = SPACE / 2 - ((minY + maxY) / 2) * s
const pos = new Float32Array(nodes.length * 2)
nodes.forEach((n, i) => { pos[i * 2] = n.x * s + ox; pos[i * 2 + 1] = n.y * s + oy })
const pairs = new Float32Array(links.length * 2)
links.forEach((l, i) => { pairs[i * 2] = idx.get(l.s); pairs[i * 2 + 1] = idx.get(l.t) })

const cache = new Map()
function parse(col, fb) {
  if (!col) return fb
  if (cache.has(col)) return cache.get(col)
  let out = null
  let m = /^#([0-9a-f]{6})$/i.exec(col)
  if (m) { const x = parseInt(m[1], 16); out = [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255, 1] }
  if (!out) { m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(col); if (m) out = [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]] }
  if (!out) out = fb
  cache.set(col, out)
  return out
}
// mirrors graph-visual-grammar sizeForNode (core 5, hub cap 8, extracted layer at 0.8)
const sizeFor = (n) => n.kind === 'core' ? 5 : n.kind === 'folder' ? 3.5 : n.layer === 'product' ? Math.min(8, 2.4 + Math.sqrt(n.deg || 0) * 0.7) : (1.1 + Math.sqrt(n.deg || 0) * 0.35) * (n.layer === 'construction' ? 0.8 : 1)
const FIRE = new Set(['wiki', 'in', 'loose'])
const isLight = !!G.isLight
const nodeFb = isLight ? [0.35, 0.4, 0.45, 1] : [0.55, 0.6, 0.66, 1]
const linkFb = isLight ? [0.35, 0.39, 0.47, 0.24] : [0.55, 0.59, 0.66, 0.11]
const colors = new Float32Array(nodes.length * 4), sizes = new Float32Array(nodes.length)
nodes.forEach((n, i) => { const [r, g, b, a] = parse(n.c, nodeFb); colors.set([r, g, b, a], i * 4); sizes[i] = Math.max(2, sizeFor(n) * 2.2 * s) })
const lcolors = new Float32Array(links.length * 4), lwidths = new Float32Array(links.length)
links.forEach((l, i) => { const [r, g, b, a] = parse(l.c, linkFb); lcolors.set([r, g, b, a], i * 4); lwidths[i] = FIRE.has(l.type) ? 0.5 : 1 })

// grammar (mirrors src/duin/lib/graph-visual-grammar.ts)
const shapeFor = (k) => ({ core: 6, folder: 5, project: 4, track: 4, strategy: 4, move: 4, goal: 2, kr: 2, event: 3, milestone: 3, release: 3, org: 1, risk: 7, issue: 7, owed: 7 })[k] ?? 0
const DECL = new Set(['wiki', 'wikilink', 'link', 'refs', 'in', 'contains', 'anchors', 'indexes', 'domain', 'has_kr', 'builds_toward', 'guides'])
const UNDIR = new Set(['in', 'contains', 'anchors', 'indexes', 'domain', 'loose', 'synonym', 'related', 'similar'])
const shapes = new Float32Array(nodes.length); nodes.forEach((n, i) => { shapes[i] = shapeFor(n.kind) })
const stylesDotted = new Float32Array(links.length), stylesDashed = new Float32Array(links.length)
links.forEach((l, i) => { const inf = !DECL.has(l.type); stylesDotted[i] = inf ? 2 : 0; stylesDashed[i] = inf ? 1 : 0 })
const GREY = { dark: { point: 0.22, link: 0.27, pointColor: [0.35, 0.39, 0.47, 1] }, light: { point: 0.3, link: 0.38, pointColor: [0.59, 0.63, 0.69, 1] } }[isLight ? 'light' : 'dark']
const ACCENT = isLight ? [0.05, 0.43, 0.4, 0.95] : [0.37, 0.92, 0.83, 0.95]

const host = document.getElementById('host')
const g = new Graph(host, {
  enableSimulation: false, backgroundColor: isLight ? [0.98, 0.98, 0.98, 1] : [0.027, 0.027, 0.05, 1], pixelRatio: 1, spaceSize: SPACE,
  rescalePositions: false, fitViewOnInit: false, enableDrag: false, attribution: '', pointDefaultColor: [0.5, 0.55, 0.6, 1], pointOpacity: 1,
  scalePointsOnZoom: true, renderHoveredPointRing: true, renderLinks: true, linkDefaultWidth: 1, linkVisibilityMinTransparency: 1,
  scaleLinksOnZoom: false, curvedLinks: false, linkDefaultArrows: false, pointGreyoutOpacity: 0.12, linkGreyoutOpacity: 0.04,
})
await g.ready
g.setPointPositions(pos, true); g.setLinks(pairs); g.setPointColors(colors); g.setPointSizes(sizes); g.setLinkColors(lcolors); g.setLinkWidths(lwidths)
g.render(undefined, 0)
g.fitView(0, 0.14)

const lockIdx = idx.get(G.lockId) ?? 0
function focusOn(anchorIdx) {
  const nb = g.getNeighboringPointIndices(anchorIdx)
  const lit = new Set([anchorIdx, ...nb])
  const li = [], inc = new Set()
  for (let i = 0; i < links.length; i++) { const a = pairs[i * 2], b = pairs[i * 2 + 1]; if (lit.has(a) && lit.has(b)) { li.push(i); if (a === anchorIdx || b === anchorIdx) inc.add(i) } }
  const c = new Float32Array(lcolors)
  for (const i of li) { c.set([ACCENT[0], ACCENT[1], ACCENT[2], inc.has(i) ? 0.85 : 0.5], i * 4) }
  const arrows = new Array(links.length).fill(false); for (const i of li) arrows[i] = !UNDIR.has(links[i].type)
  g.setLinkColors(c); g.setLinkArrows(arrows)
  // In focus the lit links are a SOLID GRADIENT (source hue → target hue, alpha tiers from the
  // buffer above): mirrors cosmos-brain-canvas applyFocus after the 2026-09-03 verdict.
  g.setConfigPartial({ highlightedPointIndices: [...lit], highlightedLinkIndices: li, outlinedPointIndices: [anchorIdx], outlinedPointRingColor: ACCENT, pointGreyoutOpacity: GREY.point, pointGreyoutColor: GREY.pointColor, linkGreyoutOpacity: GREY.link, linkArrowsSizeScale: 0.6, linkColorInterpolateFromEndpoints: true })
  return { lit: lit.size, links: li.length }
}

window.__scenario = async (name) => {
  switch (name) {
    case 'idle-plain': break
    case 'idle-grammar': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6 }); break
    case 'idle-gradient': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6, linkColorInterpolateFromEndpoints: true }); break
    case 'zoom-plain': g.zoomToPointByIndex(lockIdx, 0, 5, false); break
    case 'zoom-grammar-dotted': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6 }); g.zoomToPointByIndex(lockIdx, 0, 5, false); break
    case 'zoom-grammar-dashed': g.setPointShapes(shapes); g.setLinkStyles(stylesDashed); g.setConfigPartial({ linkDashGap: 4, linkDashLength: 6 }); g.zoomToPointByIndex(lockIdx, 0, 5, false); break
    case 'zoom-gradient': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6, linkColorInterpolateFromEndpoints: true }); g.zoomToPointByIndex(lockIdx, 0, 5, false); break
    case 'zoom-focus': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6 }); g.zoomToPointByIndex(lockIdx, 0, 5, false); window.__focus = focusOn(lockIdx); break
    case 'overview-focus': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); window.__focus = focusOn(lockIdx); break
    // The shipped focus look since 2026-09-03: solid links everywhere, lit links a gradient.
    case 'zoom-focus-gradient': g.setPointShapes(shapes); g.zoomToPointByIndex(lockIdx, 0, 5, false); window.__focus = focusOn(lockIdx); break
    case 'overview-focus-gradient': g.setPointShapes(shapes); window.__focus = focusOn(lockIdx); break
    // Notes first + adaptive ink (graph-visual-grammar linkInkBoost / LAYER_WEIGHT), re-stamped
    // here because the dump carries the shell's stamped colours from before the change.
    case 'idle-weighted': case 'zoom-weighted': {
      const boost = Math.max(1, Math.min(1.8, Math.sqrt(16000 / Math.max(1, links.length))))
      const lc = new Float32Array(lcolors)
      const byId = new Map(nodes.map((n) => [n.id, n]))
      links.forEach((l, i) => {
        const a = byId.get(l.s), b = byId.get(l.t)
        const layerMul = a?.layer === 'construction' && b?.layer === 'construction' ? 0.75 : 1
        lc[i * 4 + 3] = Math.min(0.4, lcolors[i * 4 + 3] * boost * layerMul)
      })
      const pc = new Float32Array(colors)
      nodes.forEach((n, i) => { if (n.layer === 'construction') pc[i * 4 + 3] = colors[i * 4 + 3] * 0.72 })
      g.setPointShapes(shapes); g.setLinkColors(lc); g.setPointColors(pc)
      if (name === 'zoom-weighted') g.zoomToPointByIndex(lockIdx, 0, 3, false)
      window.__weighted = { boost: +boost.toFixed(3), links: links.length }
      break
    }
    // ── GPU simulation experiments (Phase A of the layout decision) ─────────────────
    case 'sim-current': case 'sim-random': case 'sim-clusters': case 'sim-spread': {
      if (name === 'sim-random') { const r = new Float32Array(pos.length); for (let i = 0; i < r.length; i++) r[i] = SPACE * 0.25 + Math.random() * SPACE * 0.5; g.setPointPositions(r, true) }
      if (name === 'sim-clusters') {
        // cluster force by vault FOLDER (declared structure); construction/product nodes unclustered
        const groups = new Map(); const cl = new Array(nodes.length).fill(undefined)
        nodes.forEach((n, i) => { if (n.layer === 'vault' && n.group) { if (!groups.has(n.group)) groups.set(n.group, groups.size); cl[i] = groups.get(n.group) } })
        g.setPointClusters(cl)
      }
      const hub = nodes.reduce((b, n, i) => ((n.deg || 0) > (nodes[b].deg || 0) ? i : b), 0)
      g.setPinnedPoints([hub])
      const t0 = performance.now(); let ended = false
      g.setConfigPartial({ enableSimulation: true, onSimulationEnd: () => { ended = true }, simulationCluster: name === 'sim-clusters' ? 0.4 : 0.1, simulationDecay: Number(window.__decay || 5000),
        ...(name === 'sim-spread' ? { simulationRepulsion: 1.6, simulationGravity: 0.12, simulationLinkDistance: 14 } : {}) })
      g.render(1, 0); g.start(1)
      while (!ended && performance.now() - t0 < 45000) await new Promise((r) => setTimeout(r, 100))
      g.pause(); g.fitView(0, 0.14); g.render(undefined, 0)
      await new Promise((r) => setTimeout(r, 300))
      // numbers: settle time, link length distribution on screen at fit
      const pp = g.getPointPositions(); const lens = []
      for (let i = 0; i < links.length; i++) { const a = pairs[i * 2], b = pairs[i * 2 + 1]; const [ax, ay] = g.spaceToScreenPosition([pp[a * 2], pp[a * 2 + 1]]); const [bx, by] = g.spaceToScreenPosition([pp[b * 2], pp[b * 2 + 1]]); lens.push(Math.hypot(ax - bx, ay - by)) }
      lens.sort((a, b) => a - b)
      window.__sim = { settleMs: Math.round(performance.now() - t0), ended, progress: Number(g.progress.toFixed(3)), linkPxMedian: Math.round(lens[lens.length >> 1]), linkPxP90: Math.round(lens[Math.floor(lens.length * 0.9)]) }
      break
    }
    case 'metrics': {
      // baseline numbers for the worker layout the dump carries (no simulation)
      const pp = g.getPointPositions(); const lens = []
      for (let i = 0; i < links.length; i++) { const a = pairs[i * 2], b = pairs[i * 2 + 1]; const [ax, ay] = g.spaceToScreenPosition([pp[a * 2], pp[a * 2 + 1]]); const [bx, by] = g.spaceToScreenPosition([pp[b * 2], pp[b * 2 + 1]]); lens.push(Math.hypot(ax - bx, ay - by)) }
      lens.sort((a, b) => a - b)
      window.__sim = { settleMs: 0, ended: true, progress: 1, linkPxMedian: Math.round(lens[lens.length >> 1]), linkPxP90: Math.round(lens[Math.floor(lens.length * 0.9)]) }
      break
    }
    case 'gpu-smoke': {
      // The exact call sequence cosmos-brain-canvas.tsx makes in layoutMode "gpu", so an API
      // misuse shows up here as a thrown error instead of a silent legacy fallback in the app.
      const log = []
      const step = (name, fn) => { try { const r = fn(); log.push([name, 'ok', r === undefined ? '' : String(r).slice(0, 60)]) } catch (e) { log.push([name, 'ERR', e.message]) } }
      const hub = nodes.reduce((b, n, i) => ((n.deg || 0) > (nodes[b].deg || 0) ? i : b), 0)
      step('setPinnedPoints', () => g.setPinnedPoints([hub]))
      const cl = new Array(nodes.length).fill(undefined); nodes.forEach((n, i) => { if (n.layer === 'vault') cl[i] = 0 })
      step('setPointClusters', () => g.setPointClusters(cl))
      step('setPointClusters(all undefined)', () => g.setPointClusters(new Array(nodes.length).fill(undefined)))
      step('setConfigPartial(sim params)', () => g.setConfigPartial({ enableSimulation: true, simulationRepulsion: 1, simulationLinkDistance: 10, simulationLinkSpring: 1, simulationGravity: 0.25, simulationCenter: 0, simulationFriction: 0.85, simulationDecay: 600, simulationCluster: 0.35, onSimulationEnd: () => { window.__ended = true }, onSimulationTick: () => { window.__ticks = (window.__ticks || 0) + 1 }, onDragEnd: () => {} }))
      step('render(1,0)', () => g.render(1, 0))
      step('start(1)', () => g.start(1))
      step('trackPointPositionsByIndices', () => g.trackPointPositionsByIndices([hub, 0, 1, 2]))
      await new Promise((r) => setTimeout(r, 800))
      step('getTrackedPointPositionsMap', () => { const mp = g.getTrackedPointPositionsMap(); const v = mp.get(hub); return `size=${mp.size} hub=${v ? v.map((x) => x.toFixed(1)).join(',') : 'none'}` })
      step('getPointPositions', () => { const pp = g.getPointPositions(); return `len=${pp.length}` })
      step('setConfigPartial(reheat)+start(0.25)', () => { g.setConfigPartial({ simulationRepulsion: 1.5 }); g.start(0.25) })
      step('render(0,0) static', () => g.render(0, 0))
      step('pause', () => g.pause())
      window.__sim = { log, ticks: window.__ticks || 0 }
      break
    }
    case 'sim-cost': {
      // Cost of ONE simulation tick on this GPU: step() submits the force passes, the position
      // readback forces the GPU to finish, so (t1 - t0) / steps is GPU + submission time per tick.
      // Run at the full dumped size and at the shipped LOD budget (2,500 nodes) by sub-sampling.
      const measure = async (count) => {
        const keepIdx = new Set(); for (let i = 0; i < nodes.length && keepIdx.size < count; i++) keepIdx.add(i)
        const remap = new Map(); const pos2 = []; let k = 0
        for (const i of keepIdx) { remap.set(i, k++); pos2.push(pos[i * 2], pos[i * 2 + 1]) }
        const pairs2 = []
        for (let i = 0; i < links.length; i++) { const a = remap.get(pairs[i * 2]), b = remap.get(pairs[i * 2 + 1]); if (a !== undefined && b !== undefined) pairs2.push(a, b) }
        g.setPointPositions(new Float32Array(pos2), true); g.setLinks(new Float32Array(pairs2))
        g.setPointColors(colors.slice(0, k * 4)); g.setPointSizes(sizes.slice(0, k))
        g.setConfigPartial({ enableSimulation: true, simulationDecay: 100000 })
        g.render(1, 0); g.start(1); g.pause()
        await new Promise((r) => setTimeout(r, 300))
        const runs = []
        for (let rep = 0; rep < 5; rep++) {
          const t0 = performance.now()
          for (let s = 0; s < 40; s++) g.step()
          g.getPointPositions()
          runs.push((performance.now() - t0) / 40)
        }
        runs.sort((a, b) => a - b)
        return { nodes: k, links: pairs2.length / 2, msPerTickMin: +runs[0].toFixed(2), msPerTickMedian: +runs[2].toFixed(2) }
      }
      const full = await measure(nodes.length)
      const budget = await measure(2500)
      window.__sim = { full, budget }
      break
    }
    case 'sprites': {
      // GPU point images: a synthetic badge (ring + accent dot, like the core mark) on the top hub,
      // sized at 1.15x the point, then zoom in. Also the rect-select call the lasso makes.
      const hub = nodes.reduce((b, n, i) => ((n.deg || 0) > (nodes[b].deg || 0) ? i : b), 0)
      const c = document.createElement('canvas'); c.width = 128; c.height = 128
      const x = c.getContext('2d')
      x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fillStyle = '#101013'; x.fill()
      x.lineWidth = 8; x.strokeStyle = '#F2F0EA'; x.beginPath(); x.arc(64, 64, 40, 0, Math.PI * 2); x.stroke()
      x.beginPath(); x.arc(64, 118, 8, 0, Math.PI * 2); x.fillStyle = '#d97757'; x.fill()
      const img = x.getImageData(0, 0, 128, 128)
      const idx = new Float32Array(nodes.length).fill(-1); idx[hub] = 0
      const isz = new Float32Array(nodes.length); isz[hub] = Math.max(2, sizeFor(nodes[hub]) * 2.2 * s) * 1.15
      g.setImageData([img]); g.setPointImageIndices(idx); g.setPointImageSizes(isz)
      g.zoomToPointByIndex(hub, 0, 6, false)
      g.render(undefined, 0)
      await new Promise((r) => setTimeout(r, 400))
      const inRect = g.findPointsInRect([[0, 0], [800, 500]])
      window.__sim = { hub: nodes[hub].label, rectSelected: inRect.length }
      break
    }
    case 'zoom-deep': g.setPointShapes(shapes); g.setLinkStyles(stylesDotted); g.setConfigPartial({ linkDashGap: 3, linkDashLength: 6 }); g.zoomToPointByIndex(lockIdx, 0, 14, false); break
  }
  g.render(undefined, 0)
  await new Promise((r) => setTimeout(r, 400))
  return { n: nodes.length, m: links.length, zoom: g.getZoomLevel(), focus: window.__focus || null, sim: window.__sim || null }
}
window.__ready = true

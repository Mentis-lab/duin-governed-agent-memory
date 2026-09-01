// Tier 3 of the graph-perf plan: the 2D brain map on a GPU renderer.
//
// @cosmos.gl/graph draws every point and link in shaders — the per-frame cost is a
// couple of draw calls over typed arrays, not an O(N+E) canvas replay, which is what
// removes force-graph 2D's ~7-10k-element ceiling for good. This component is a thin
// adapter that keeps the rest of the brain-shell architecture EXACTLY as it was:
//
//   · the layout worker stays the only physics — cosmos's own simulation is disabled
//     (`enableSimulation: false`) and positions are pushed in whenever the worker
//     writes a snapshot into the live node objects (the `version` prop ticks);
//   · node/link colors arrive pre-stamped (`__color`) by brain-shell's palette memos;
//     this file only converts them to the RGBA float arrays the GPU wants;
//   · zoom/pan feel carries over — cosmos's camera is itself built on d3-zoom;
//   · hover/click/lock/focus map onto cosmos's native hover ring, greyout and
//     outline facilities instead of hand-painted rings;
//   · labels are a pooled DOM overlay (anchors + selection + hover always; degree-top
//     zoom-revealed labels past the same 1.4 px-per-world threshold the canvas
//     painter used), reprojected on zoom and on position pushes.
//
// LIFECYCLE GUARD (learned the hard way): the Graph's device initializes ASYNC — its
// internal stores don't exist until `graph.ready` resolves, and a setter called before
// that throws from deep inside luma.gl ("Cannot set properties of undefined"). Every
// imperative call therefore goes through safeRun() and is gated on readyRef; a throw
// anywhere flips the shell back to the legacy canvas renderer instead of reaching the
// app-shell error boundary. Cosmos is an upgrade, never a wall.
//
// Deliberate v1 differences from the canvas renderer, both documented in the plan:
// node DRAG is off (it needed live main-thread physics; wire drag→worker-reheat later
// if missed), and the core logo is a DOM sprite (static, no pulse — matching the legacy
// renderer's operator-mandated still core) instead of a canvas-drawn mark.
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Graph } from "@cosmos.gl/graph";

/** Space is a fixed square; world coords (d3-force, origin-centered) map into it once
 *  per structural change. 8192 matches cosmos's default; the transform leaves margin. */
const SPACE = 8192;
const ZOOM_LABEL_PX_PER_WORLD = 1.4; // same reveal threshold the canvas painter used
const MAX_ZOOM_LABELS = 40;

export type CosmosAdapters = {
  sizeFor: (n: any) => number;          // world-ish radius, same formula the canvas used
  labelFor: (n: any) => string;
  isAnchor: (n: any) => boolean;        // always-labelled folder anchors
  alphaFor: (n: any) => number;         // recency fade multiplier (1 = full)
};

export type CosmosBrainCanvasHandle = {
  /** centerAt+zoom analogue for the shell's focusNode(). */
  focusNode: (id: string) => void;
};

type Props = {
  nodes: any[];                          // live objects; worker mutates x/y in place
  links: any[];                          // __color stamped; source/target ids or objects
  version: number;                       // ticks when fresh positions were written
  paletteVersion: number;                // ticks when stamped colors/widths changed
  width: number;
  height: number;
  isLight: boolean;
  showLabels: boolean;
  adapters: CosmosAdapters;
  focusSet: Set<string> | null;          // the LIT set (lens ∩ focus neighborhood); null = no dimming
  lockId: string | null;
  selectedId: string | null;             // the omnibox context chip's node
  coreMarkUrl: string | null;            // pre-rendered core logo (data URL)
  fireTypes: Set<string>;                // faint link families (thinner + fainter)
  onNodeClick: (n: any, ev: MouseEvent) => void;
  onNodeHover: (n: any | null) => void;
  onBackgroundClick: () => void;
  onFallback: () => void;                // WebGL/device init failed → use legacy canvas
};

// Small cached CSS-color → [r,g,b,a] (0..1) parser. Handles the two shapes the stamps
// produce (#rrggbb and rgba(r,g,b,a)); anything else goes through a 1×1 canvas once.
const colorCache = new Map<string, [number, number, number, number]>();
let probeCtx: CanvasRenderingContext2D | null = null;
function parseColor(col: string | undefined, fallback: [number, number, number, number]): [number, number, number, number] {
  if (!col) return fallback;
  const hit = colorCache.get(col);
  if (hit) return hit;
  let out: [number, number, number, number] | null = null;
  let m = /^#([0-9a-f]{6})$/i.exec(col);
  if (m) {
    const x = parseInt(m[1], 16);
    out = [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255, 1];
  }
  if (!out) {
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(col);
    if (m) out = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  }
  if (!out) {
    try {
      if (!probeCtx) probeCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (probeCtx) {
        probeCtx.fillStyle = "#000"; probeCtx.fillStyle = col;
        probeCtx.clearRect(0, 0, 1, 1); probeCtx.fillRect(0, 0, 1, 1);
        const d = probeCtx.getImageData(0, 0, 1, 1).data;
        out = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
      }
    } catch { /* fall through */ }
  }
  if (!out) out = fallback;
  colorCache.set(col, out);
  return out;
}

export const CosmosBrainCanvas = forwardRef<CosmosBrainCanvasHandle, Props>(function CosmosBrainCanvas(p, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const deadRef = useRef(false);   // failed → inert (shell already fell back to legacy)
  const readyRef = useRef(false);  // device init resolved — setters are safe from here on
  const pendingStructuralRef = useRef(false); // data arrived before ready → push on ready
  // world→space transform, recomputed per structural change so a growing layout never
  // walks off the space. screen px-per-world = spaceToScreenRadius(scale)·s.
  const xformRef = useRef({ s: 1, ox: SPACE / 2, oy: SPACE / 2 });
  const idxOfRef = useRef<Map<string, number>>(new Map());
  const hoverIdRef = useRef<string | null>(null);
  const labelPoolRef = useRef<HTMLDivElement[]>([]);
  const logoPoolRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const coreElRef = useRef<HTMLDivElement | null>(null);
  const syncQueuedRef = useRef(false);
  const didInitialFitRef = useRef(false);
  const settleSyncTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (settleSyncTimerRef.current != null) window.clearTimeout(settleSyncTimerRef.current); }, []);

  // Latest props for the imperative callbacks (cosmos config is set once; its handlers
  // must not close over stale renders).
  const pRef = useRef(p);
  pRef.current = p;

  const toSpace = (wx: number, wy: number): [number, number] => {
    const t = xformRef.current;
    return [wx * t.s + t.ox, wy * t.s + t.oy];
  };
  // World position with the PINNED fallback: the layout worker never writes x/y into a
  // pinned node (it skips fx/fy holders — the CORE), so `n.x` can stay undefined for the
  // most important node on the map. fx/fy are its authoritative coordinates.
  const wxOf = (n: any): number | null =>
    typeof n?.x === "number" ? n.x : typeof n?.fx === "number" ? n.fx : null;
  const wyOf = (n: any): number | null =>
    typeof n?.y === "number" ? n.y : typeof n?.fy === "number" ? n.fy : null;

  /** Run an imperative cosmos call; ANY throw retires this renderer for the session and
   *  flips the shell to the legacy canvas — never up to the app-shell error boundary. */
  const safeRun = (fn: () => void): void => {
    if (deadRef.current || !graphRef.current) return;
    try { fn(); } catch {
      deadRef.current = true;
      const g = graphRef.current;
      graphRef.current = null;
      try { g?.destroy(); } catch { /* device already gone */ }
      pRef.current.onFallback();
    }
  };

  // ── data pushes (defined as functions so both effects and the ready-gate share them) ──
  const pushStructural = (): void => safeRun(() => {
    const g = graphRef.current!;
    const { nodes, links } = pRef.current;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const x = wxOf(n) ?? 0, y = wyOf(n) ?? 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1; }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const s = Math.min(2, (SPACE * 0.55) / span); // leave ~45% margin for settle growth
    xformRef.current = {
      s,
      ox: SPACE / 2 - ((minX + maxX) / 2) * s,
      oy: SPACE / 2 - ((minY + maxY) / 2) * s,
    };
    const idx = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].id, i);
    idxOfRef.current = idx;

    const pos = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const [sx, sy] = toSpace(wxOf(nodes[i]) ?? 0, wyOf(nodes[i]) ?? 0);
      pos[i * 2] = sx; pos[i * 2 + 1] = sy;
    }
    const pairs: number[] = [];
    for (const l of links) {
      const sId = l.source && typeof l.source === "object" ? l.source.id : l.source;
      const tId = l.target && typeof l.target === "object" ? l.target.id : l.target;
      const a = idx.get(sId), b = idx.get(tId);
      if (a !== undefined && b !== undefined) pairs.push(a, b);
    }
    g.setPointPositions(pos, true);
    g.setLinks(Float32Array.from(pairs));
    applyPalette(g);
    applyFocus(g);
    g.render(undefined, 0);
    // One initial framing so the mount shows the graph, not an arbitrary corner of the
    // space. Once — never on refreshes (the old "no auto fit-to-screen" rule holds).
    if (!didInitialFitRef.current && nodes.length > 0) {
      didInitialFitRef.current = true;
      safeRun(() => graphRef.current!.fitView(0, 0.14));
    }
    queueOverlaySync();
  });

  const pushPositions = (): void => safeRun(() => {
    const g = graphRef.current!;
    const nodes = pRef.current.nodes;
    const pos = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const [sx, sy] = toSpace(wxOf(nodes[i]) ?? 0, wyOf(nodes[i]) ?? 0);
      pos[i * 2] = sx; pos[i * 2 + 1] = sy;
    }
    g.setPointPositions(pos, true);
    // A short transition per 120ms snapshot makes the settle read as one smooth motion —
    // something the canvas renderer (hard position snaps) never had.
    g.render(undefined, 110);
    // Light per snapshot; one full membership refresh shortly after the stream pauses.
    queueOverlaySync(false);
    if (settleSyncTimerRef.current != null) window.clearTimeout(settleSyncTimerRef.current);
    settleSyncTimerRef.current = window.setTimeout(() => { settleSyncTimerRef.current = null; queueOverlaySync(true); }, 260);
  });

  const applyPalette = (g: Graph): void => {
    const { nodes, links, adapters, isLight, fireTypes } = pRef.current;
    const s = xformRef.current.s;
    const nodeFallback: [number, number, number, number] = isLight ? [0.35, 0.4, 0.45, 1] : [0.55, 0.6, 0.66, 1];
    const colors = new Float32Array(nodes.length * 4);
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const [r, gg, b, a] = parseColor(n.__color, nodeFallback);
      colors[i * 4] = r; colors[i * 4 + 1] = gg; colors[i * 4 + 2] = b; colors[i * 4 + 3] = a * adapters.alphaFor(n);
      // canvas radii → cosmos diameters, in SPACE units (×s): under scalePointsOnZoom the
      // on-screen size is then size×k = radius×pxPerWorld — the canvas renderer's exact look.
      sizes[i] = Math.max(2, adapters.sizeFor(n) * 2.2 * s);
    }
    const linkFallback: [number, number, number, number] = isLight ? [0.35, 0.39, 0.47, 0.24] : [0.55, 0.59, 0.66, 0.11];
    const lcolors = new Float32Array(links.length * 4);
    const lwidths = new Float32Array(links.length);
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const [r, gg, b, a] = parseColor(l.__color, linkFallback);
      lcolors[i * 4] = r; lcolors[i * 4 + 1] = gg; lcolors[i * 4 + 2] = b; lcolors[i * 4 + 3] = a;
      lwidths[i] = fireTypes.has(l.type) ? 0.5 : 1;
    }
    g.setPointColors(colors);
    g.setPointSizes(sizes);
    g.setLinkColors(lcolors);
    g.setLinkWidths(lwidths);
  };

  const applyFocus = (g: Graph): void => {
    const { focusSet, lockId, selectedId, isLight } = pRef.current;
    const idx = idxOfRef.current;
    const accent: [number, number, number, number] = isLight ? [0.05, 0.43, 0.4, 0.95] : [0.37, 0.92, 0.83, 0.95];
    const highlighted = focusSet
      ? Array.from(focusSet, (id) => idx.get(id)).filter((i): i is number => i !== undefined)
      : undefined;
    const lockIdx = lockId != null ? idx.get(lockId) : undefined;
    const selIdx = selectedId != null ? idx.get(selectedId) : undefined;
    g.setConfigPartial({
      highlightedPointIndices: highlighted,
      outlinedPointIndices: lockIdx !== undefined ? [lockIdx] : undefined,
      outlinedPointRingColor: accent,
      hoveredPointRingColor: accent,
      focusedPointRingColor: accent,
      focusedPointIndex: selIdx,
    } as any);
  };

  // ── the one Graph instance ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let g: Graph | null = null;
    try {
      g = new Graph(host, {
        enableSimulation: false,
        backgroundColor: [0, 0, 0, 0],       // the wrapper's --app-bg shows through, as before
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        spaceSize: SPACE,
        rescalePositions: false,             // the transform above owns world→space
        fitViewOnInit: false,                // camera persistence: the initial fit is ours, once
        enableDrag: false,                   // v1: no point drag (needed live physics)
        attribution: "",
        pointDefaultColor: [0.5, 0.55, 0.6, 1],
        pointOpacity: 1,
        scalePointsOnZoom: true,
        renderHoveredPointRing: true,
        hoveredPointCursor: "pointer",
        renderLinks: true,
        linkDefaultWidth: 1,
        // THE reason links wash out when you zoom in, and it is cosmos's own feature, not ours.
        // From its link shader:
        //
        //   opacity = lineColor.a * linkOpacity
        //           * max(linkVisibilityMinTransparency,
        //                 map(linkDistPx, distanceRange.g, distanceRange.r, 0.0, 1.0))
        //
        // `linkDistPx` is the link's length in SCREEN pixels, so it grows as you zoom in. The
        // defaults are distanceRange [50, 150] and minTransparency 0.25, which means any link
        // longer than 150 screen px is multiplied down to a QUARTER of its alpha. These links are
        // stamped at 0.11 alpha in dark mode (brain-shell's linkColorByPrio — deliberately, "a
        // whisper of the node's hue"), so zoomed in they render at 0.11 x 0.25 = 0.0275. That is
        // invisible, which is exactly what the operator reported.
        //
        // Setting it to 1 removes the length penalty (max(1, x) == 1) and nothing else: the
        // stamped alpha, the 1px width and the crispness all stay as they were. Despite the name
        // this is a minimum OPACITY multiplier, not a transparency — 1 means "never fade", not
        // "fully transparent". Verified against the shader above rather than inferred from the
        // name, because reading it the other way would have made every link vanish.
        //
        // The zoomed-OUT view is untouched by construction: short links already scored ~1.0 on
        // that ramp, so the max() was never binding there. This only affects the case that was
        // broken.
        linkVisibilityMinTransparency: 1,
        // STAYS FALSE. Tried true on 2026-08-18 to fix links washing out when zoomed in; the
        // operator's verdict was "muddy and low res", which is worse than the problem it treated.
        //
        // Why widening backfires here: these links carry 0.11 alpha in dark mode (brain-shell's
        // linkColorByPrio, deliberately — "a whisper of the node's hue"). A GPU line's antialiased
        // edge falloff scales WITH its width, so a widened link is not a bolder 1px line, it is a
        // soft gradient several pixels across at 11% opacity. That is a smear, and a smear of a
        // faint color is exactly what "muddy and low res" describes. Crispness here comes from the
        // line staying one screen pixel wide.
        //
        // The real cause of the wash-out is unchanged and is about ALPHA, not width: at 0.11 a
        // SINGLE link is nearly invisible, and what makes the web readable zoomed out is OVERLAP —
        // several links crossing the same pixels composite toward ~0.4. Zooming in removes the
        // overlap, so you see the true 0.11. Any future attempt should raise the alpha (ideally as
        // a function of zoom, compensating for the overlap that is being lost) and leave the width
        // alone.
        scaleLinksOnZoom: false,
        curvedLinks: false,
        linkDefaultArrows: false,
        pointGreyoutOpacity: 0.12,           // focus dimming, matching the old faded look
        linkGreyoutOpacity: 0.04,
        onPointClick: (i: number, _pos: [number, number], ev: MouseEvent) => {
          const n = pRef.current.nodes[i];
          if (n) pRef.current.onNodeClick(n, ev);
        },
        onBackgroundClick: () => pRef.current.onBackgroundClick(),
        onPointMouseOver: (i: number) => {
          const n = pRef.current.nodes[i];
          const id = n?.id ?? null;
          if (id !== hoverIdRef.current) { hoverIdRef.current = id; pRef.current.onNodeHover(n ?? null); }
        },
        onPointMouseOut: () => {
          if (hoverIdRef.current != null) { hoverIdRef.current = null; pRef.current.onNodeHover(null); }
        },
        onZoom: () => queueOverlaySync(false),   // per-frame: reproject the chosen labels only
        onZoomEnd: () => queueOverlaySync(true), // gesture end: recompute label membership
      } as any);
    } catch {
      deadRef.current = true;
      pRef.current.onFallback();
      return;
    }
    graphRef.current = g;
    // Setters are unsafe until the async device init resolves (internal stores don't
    // exist yet). Gate everything on ready; a device that never comes up falls back.
    void g.ready.then(() => {
      if (deadRef.current || graphRef.current !== g) return;
      readyRef.current = true;
      if (pendingStructuralRef.current) { pendingStructuralRef.current = false; pushStructural(); }
    }).catch(() => {
      deadRef.current = true;
      pRef.current.onFallback();
    });
    return () => {
      readyRef.current = false;
      graphRef.current = null;
      try { g?.destroy(); } catch { /* device already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── structural pushes (node/link arrays swapped) ─────────────────────────────────
  useEffect(() => {
    if (deadRef.current) return;
    if (!readyRef.current) { pendingStructuralRef.current = true; return; }
    pushStructural();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.nodes, p.links]);

  // ── per-snapshot position pushes (worker settle) ─────────────────────────────────
  useEffect(() => {
    if (deadRef.current || !readyRef.current) return; // pre-ready positions arrive with the pending structural push
    pushPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.version]);

  // ── palette pushes (theme / scheme / cluster / recency changes) ──────────────────
  useEffect(() => {
    if (deadRef.current || !readyRef.current) return;
    safeRun(() => { const g = graphRef.current!; applyPalette(g); g.render(undefined, 0); });
    queueOverlaySync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paletteVersion]);

  // ── focus / selection → native greyout + rings ───────────────────────────────────
  useEffect(() => {
    if (deadRef.current || !readyRef.current) return;
    safeRun(() => { const g = graphRef.current!; applyFocus(g); g.render(undefined, 0); });
    queueOverlaySync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusSet, p.lockId, p.selectedId, p.isLight]);

  // ── label + core overlay (pooled DOM, reprojected on zoom/position changes) ──────
  // Two speeds, learned from a live probe (zoom p90 hit 50ms with one speed): choosing
  // WHICH nodes get labels is an O(N) projection pass — far too heavy per zoom frame at
  // 4k+ nodes — so membership recomputes only at gesture end / data ticks, while the
  // per-frame sync just reprojects the ≤~65 already-chosen labels to keep them glued.
  const labelSetRef = useRef<any[]>([]);
  const recomputeQueuedRef = useRef(false);
  // MEMBERSHIP STAYS AT GESTURE END. Tried a mid-gesture throttle on 2026-08-19 to stop labels
  // arriving as a batch; the operator's verdict was that DRAGGING started to lag, so it is out.
  //
  // Why it could not work, recorded so nobody re-derives it: cosmos is built on d3-zoom, whose
  // single `zoom` event covers translate as well as scale — there is no separate pan callback, so
  // `onZoom` fires on every frame of a DRAG too. The throttle therefore ran the O(N) membership
  // pass (two full walks of `nodes`, with a spaceToScreenPosition projection each) in the middle of
  // a sustained drag, where before it only reprojected the ≤65 already-chosen labels.
  //
  // The sizing mistake was mine and is worth naming: I gated the next pass at 3x its own measured
  // cost and wrote that it "occupies at most ~1/3 of the gesture" as if that were a safety
  // property. It is not. A 33% duty cycle means one frame in three is blown. Smooth dragging needs
  // ~16ms per frame, so a pass measured at a 50ms p90 cannot run mid-gesture on a large graph at
  // ANY cadence — the only fix would be making the pass itself cheap enough (a viewport index, or
  // re-filtering the existing pool instead of re-walking all nodes), which is real work and needs
  // measuring, not a constant. b66cf72's two-speed split was a measured decision and this
  // overrode it with an unmeasured one.
  const queueOverlaySync = (recompute = true): void => {
    if (recompute) recomputeQueuedRef.current = true;
    if (syncQueuedRef.current) return;
    syncQueuedRef.current = true;
    requestAnimationFrame(() => {
      syncQueuedRef.current = false;
      const full = recomputeQueuedRef.current;
      recomputeQueuedRef.current = false;
      syncOverlay(full);
    });
  };
  const syncOverlay = (recompute: boolean): void => {
    const g = graphRef.current, overlay = overlayRef.current;
    if (!g || deadRef.current || !readyRef.current || !overlay) return;
    const { nodes, adapters, showLabels, width, height, isLight, selectedId, coreMarkUrl } = pRef.current;
    const hoverId = hoverIdRef.current;
    try {
      // px per world unit — the zoom-reveal threshold lives in the old painter's units
      const pxPerWorld = g.spaceToScreenRadius(1) * xformRef.current.s;
      if (recompute && showLabels) {
        // MEMBERSHIP pass (O(N) projections) — gesture-end / data-tick only.
        const chosen: any[] = [];
        const seen = new Set<string>();
        for (const n of nodes) {
          if (n.kind === "core") continue;
          if (adapters.isAnchor(n) || n.id === selectedId || n.id === hoverId) { chosen.push(n); seen.add(n.id); }
        }
        if (pxPerWorld > ZOOM_LABEL_PX_PER_WORLD) {
          type Cand = { n: any; deg: number };
          const pool: Cand[] = [];
          for (const n of nodes) {
            if (seen.has(n.id) || n.kind === "core") continue;
            const nx = wxOf(n), ny = wyOf(n);
            if (nx == null || ny == null) continue;
            const [spx, spy] = toSpace(nx, ny);
            const [sx, sy] = g.spaceToScreenPosition([spx, spy]);
            if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
            pool.push({ n, deg: n.deg || 0 });
          }
          pool.sort((a, b) => b.deg - a.deg);
          for (let i = 0; i < pool.length && i < MAX_ZOOM_LABELS; i++) chosen.push(pool[i].n);
        }
        labelSetRef.current = chosen;
      } else if (recompute) {
        labelSetRef.current = [];
      }
      // PROJECTION pass — every sync, but only over the chosen set (≤ ~65 nodes).
      type Placed = { n: any; sx: number; sy: number };
      const cands: Placed[] = [];
      if (showLabels) {
        for (const n of labelSetRef.current) {
          const nx = wxOf(n), ny = wyOf(n);
          if (nx == null || ny == null) continue;
          const [spx, spy] = toSpace(nx, ny);
          const [sx, sy] = g.spaceToScreenPosition([spx, spy]);
          if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;
          cands.push({ n, sx, sy });
        }
      }
      // pooled label divs
      const pool = labelPoolRef.current;
      while (pool.length < cands.length) {
        const el = document.createElement("div");
        el.style.cssText = "position:absolute;transform:translate(-50%,0);pointer-events:none;font:9px ui-sans-serif,system-ui,sans-serif;white-space:nowrap;";
        overlay.appendChild(el);
        pool.push(el);
      }
      const ink = isLight ? "rgba(24,26,32,0.92)" : "rgba(225,228,240,0.92)";
      for (let i = 0; i < pool.length; i++) {
        const el = pool[i];
        if (i < cands.length) {
          const { n, sx, sy } = cands[i];
          const lbl = adapters.labelFor(n);
          if (el.textContent !== lbl) el.textContent = lbl;
          el.style.color = ink;
          const r = g.spaceToScreenRadius(Math.max(2, adapters.sizeFor(n) * 2.2 * xformRef.current.s) / 2);
          el.style.left = `${sx}px`;
          el.style.top = `${sy + r + 3}px`;
          el.style.display = "block";
        } else if (el.style.display !== "none") {
          el.style.display = "none";
        }
      }
      // Project-logo sprites — the canvas painter drew a project's uploaded logo IN PLACE
      // of its dot; here each becomes a pooled DOM sprite over its point (they number in
      // the single digits, so reprojecting all of them every sync is nothing).
      const logoPool = logoPoolRef.current;
      const liveLogoIds = new Set<string>();
      for (const n of nodes) {
        if (n.kind !== "project" || !n.logo) continue;
        const nx = wxOf(n), ny = wyOf(n);
        if (nx == null || ny == null) continue;
        const [spx, spy] = toSpace(nx, ny);
        const [sx, sy] = g.spaceToScreenPosition([spx, spy]);
        liveLogoIds.add(n.id);
        let el = logoPool.get(n.id);
        if (!el) {
          el = document.createElement("div");
          el.style.cssText = "position:absolute;transform:translate(-50%,-50%);pointer-events:none;background-size:contain;background-repeat:no-repeat;background-position:center;";
          el.style.backgroundImage = `url(${n.logo})`;
          overlay.appendChild(el);
          logoPool.set(n.id, el);
        }
        if (sx < -60 || sx > width + 60 || sy < -60 || sy > height + 60) { el.style.display = "none"; continue; }
        const px = Math.max(12, g.spaceToScreenRadius(adapters.sizeFor(n) * 5 * xformRef.current.s));
        el.style.left = `${sx}px`;
        el.style.top = `${sy}px`;
        el.style.width = `${px}px`;
        el.style.height = `${px}px`;
        el.style.display = "block";
      }
      for (const [id, el] of logoPool) if (!liveLogoIds.has(id)) { el.remove(); logoPool.delete(id); }
      // core logo sprite tracks its node whether or not labels are on
      const coreNode = nodes.find((n) => n.kind === "core");
      const coreX = coreNode ? wxOf(coreNode) : null, coreY = coreNode ? wyOf(coreNode) : null;
      if (coreNode && coreX != null && coreY != null && coreMarkUrl) {
        let el = coreElRef.current;
        if (!el) {
          el = document.createElement("div");
          el.className = "cosmos-core-mark";
          el.style.cssText = "position:absolute;transform:translate(-50%,-50%);pointer-events:none;background-size:contain;background-repeat:no-repeat;background-position:center;";
          el.style.backgroundImage = `url(${coreMarkUrl})`;
          overlay.appendChild(el);
          coreElRef.current = el;
        }
        const [spx, spy] = toSpace(coreX, coreY);
        const [sx, sy] = g.spaceToScreenPosition([spx, spy]);
        // spaceToScreenRadius(point size) ≈ the disc's on-screen DIAMETER already;
        // 1.15 lets the badge just cover its point. (First cut used ×2.6 — a huge medallion.)
        const px = Math.max(18, g.spaceToScreenRadius(11 * 2.2 * xformRef.current.s) * 1.15);
        el.style.left = `${sx}px`;
        el.style.top = `${sy}px`;
        el.style.width = `${px}px`;
        el.style.height = `${px}px`;
        el.style.display = "block";
      } else if (coreElRef.current) {
        coreElRef.current.style.display = "none";
      }
    } catch { /* projection during teardown — skip this frame */ }
  };
  // labels also follow toggle/theme/data/size changes (version ticks handled by the
  // light-sync-plus-trailing-refresh in pushPositions — a full pass per snapshot was
  // exactly the O(N)-per-frame cost the two-speed split exists to avoid)
  useEffect(() => { queueOverlaySync(true); }, [p.showLabels, p.isLight, p.nodes, p.width, p.height]);

  useImperativeHandle(ref, (): CosmosBrainCanvasHandle => ({
    focusNode: (id: string) => {
      if (deadRef.current || !readyRef.current) return;
      const i = idxOfRef.current.get(id);
      if (i !== undefined) safeRun(() => graphRef.current!.zoomToPointByIndex(i, 600, 6, false));
    },
  }), []);

  // The host div is what cosmos sizes its canvas to; the overlay shares its box.
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: p.width, height: p.height }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={overlayRef} aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }} />
      <style>{`
        /* The CORE mark does not breathe (operator call, 2026-08-17): a pulse on the one
           node that is always on screen reads as a distracting glow. The legacy canvas
           renderer draws it static; the cosmos sprite must match — no animation. */
        .cosmos-core-mark { opacity: 1; }
      `}</style>
    </div>
  );
});

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
// cosmos's own simulation is available as the physics (`layoutMode: "gpu"`, opt-in via
// `localStorage.brainLayout=gpu` since 2026-09-03): node drag with live neighbours, a cluster
// pull while Clusters is on, the core pinned, positions read back into the node objects at
// settle. The d3 worker (positions arriving through `version`) is the default.
//
// Deliberate v1 differences from the canvas renderer, both documented in the plan:
// node DRAG was off (it needed live main-thread physics; wire drag→worker-reheat later
// if missed), and the core logo is a DOM sprite (static, no pulse — matching the legacy
// renderer's operator-mandated still core) instead of a canvas-drawn mark.
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Graph } from "@cosmos.gl/graph";
import { t } from "@/lib/i18n";
import {
  FOCUS_ACCENT, GREYOUT, LIT_ARROW_SCALE, LIT_LINK_ALPHA, LINK_GRADIENT_AT_IDLE, LINK_GRADIENT_IN_FOCUS, MAX_FOCUS_LABELS,
  FOCUS_ZOOM, FIT_PADDING, frameIndices, labelBudget, estimateLabelWidth, placeLabels, type LabelCandidate,
  litLinks, linkProvenance,
} from "@/duin/lib/graph-visual-grammar";
import { START_ALPHA, settleShouldStop, type GpuSimParams } from "@/duin/lib/graph-gpu-layout";
import { imageToImageData } from "@/duin/lib/core-mark";

/** Space is a fixed square; world coords (d3-force, origin-centered) map into it once
 *  per structural change. 8192 matches cosmos's default; the transform leaves margin. */
const SPACE = 8192;
const ZOOM_LABEL_PX_PER_WORLD = 1.4; // same reveal threshold the canvas painter used
const MAX_ZOOM_LABELS = 40;
/** `localStorage.brainFps=1` shows cosmos's own WebGL frame monitor: the measured-not-guessed
 *  lever for anyone tuning this renderer, invisible to everyone else. Read once at construction. */
const fpsMonitorWanted = (): boolean => { try { return localStorage.getItem("brainFps") === "1"; } catch { return false; } };

export type CosmosAdapters = {
  sizeFor: (n: any) => number;          // world-ish radius, same formula the canvas used
  labelFor: (n: any) => string;
  isAnchor: (n: any) => boolean;        // always-labelled folder anchors
  alphaFor: (n: any) => number;         // recency fade multiplier (1 = full)
  shapeFor: (n: any) => number;         // cosmos PointShape by kind family (graph-visual-grammar)
  linkArrowFor: (l: any) => boolean;    // directed relation: arrowhead while the link is lit
  logoFor: (url: string) => HTMLImageElement | null; // a loaded project logo, or null until it loads
};

export type CosmosBrainCanvasHandle = {
  /** centerAt+zoom analogue for the shell's focusNode(). */
  focusNode: (id: string) => void;
  /** zoomToFit analogue — frame the map's body (frameAll). The shell's Recenter control
   *  routes here when this renderer is active, because `fgRef.zoomToFit` reaches only the
   *  legacy force-graph canvas and this is the DEFAULT renderer. `onlyIfUntouched` is for the
   *  shell's automatic re-frames (after a settle): they must never move a camera the operator
   *  has set by hand since the last frame; Recenter passes nothing and always frames. */
  fitView: (durationMs?: number, opts?: { onlyIfUntouched?: boolean }) => void;
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
  focusAnchorId: string | null;          // hover ?? lock: the node whose neighbourhood is lit
  layoutMode: "gpu" | "worker";          // gpu: cosmos's own simulation is the physics (drag, cluster pull, pinned core); worker: positions arrive via `version`
  simParams: GpuSimParams;               // cosmos simulation coefficients from the Layout sliders (graph-gpu-layout.ts)
  clusters: (number | undefined)[] | null; // dense cluster index per node while Clusters is on, else null
  clusterLabels?: { label: string; color: string; members: string[] }[] | null; // the largest communities, named at their centre of mass at overview
  onSettled?: () => void;                // gpu: the simulation cooled and positions were read back into the node objects
  selectedId: string | null;             // the omnibox context chip's node
  coreMarkUrl: string | null;            // pre-rendered core logo (data URL)
  fireTypes: Set<string>;                // faint link families (thinner + fainter)
  onNodeClick: (n: any, ev: MouseEvent) => void;
  onNodeHover: (n: any | null) => void;
  onBackgroundClick: () => void;
  onLinkClick: (link: any, far: any) => void;                  // a LIT link was clicked: walk to its far end
  onNodeContextMenu: (n: any | null, ev: MouseEvent) => void;  // right-click on a point (null = background)
  onLasso: (ids: string[]) => void;                             // shift-drag selected these points ([] = nothing inside)
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
  // cosmos-ordered link bookkeeping for the focus grammar: the flat [s,t,…] index pairs handed to
  // setLinks, the link objects in that same order (pushStructural skips a link whose endpoint is
  // not on the map, so this is NOT p.links), and the stamped colors so a focus recolors a copy.
  const pairsRef = useRef<Float32Array>(new Float32Array(0));
  const linkRefsRef = useRef<any[]>([]);
  const baseLinkColorsRef = useRef<Float32Array | null>(null);
  const litLinkSetRef = useRef<Set<number> | null>(null);   // lit link indices while a focus is active
  const focusLabelsRef = useRef<any[]>([]);                   // the lit neighbourhood's labelled nodes
  const linkTipRef = useRef<HTMLDivElement | null>(null);
  const mouseRef = useRef<[number, number]>([0, 0]);
  // GPU layout bookkeeping: whether cosmos owns the physics (decided at mount; the config is
  // set once), whether a settle is running, the node count of the last structural push (a
  // changed set earns a short re-heat, an unchanged one none: the refresh-storm lesson), the
  // cluster array last handed over, and the points whose GPU positions the overlay tracks.
  const gpuRef = useRef(p.layoutMode === "gpu");
  const simRunningRef = useRef(false);
  const firstLayoutRef = useRef(false);
  const lastCountRef = useRef(-1);
  const lastClustersRef = useRef<(number | undefined)[] | null>(null);
  const settledOnceRef = useRef(false);
  const trackedRef = useRef<Set<number>>(new Set());
  const simStartedAtRef = useRef(0);
  const tickCountRef = useRef(0);
  const focusWasActiveRef = useRef(false);
  /** True once the operator has zoomed or panned by hand since the last programmatic frame.
   *  The shell's automatic re-frames (after a settle) check it; Recenter does not. */
  const userTouchedRef = useRef(false);
  // GPU point images: which logo urls made it into the atlas. A key present here has a sprite
  // on the GPU and no DOM sprite; absent keys keep the DOM fallback. (The core mark is always
  // the DOM sprite: see applyImages.)
  const imagesRef = useRef<Set<string>>(new Set());
  const imagesDirtyRef = useRef(false);
  const lassoRef = useRef<{ x0: number; y0: number; el: HTMLDivElement | null } | null>(null);
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

  /** GPU layout: pull the simulated positions back into the node objects (world coords), so
   *  refreshes seed from them, a renderer swap can take over, and anything reading n.x/n.y
   *  (the shell's carry, the fallback projection) sees the settled map. One O(N) readback at
   *  simulation end and after a drag, never per frame. */
  const readBackPositions = (g: Graph): void => {
    const nodes = pRef.current.nodes;
    const pp = g.getPointPositions();
    const t = xformRef.current;
    if (!pp || pp.length < nodes.length * 2 || !t.s) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (typeof n.fx === "number") continue; // the pinned core keeps its authoritative fx/fy
      n.x = (pp[i * 2] - t.ox) / t.s;
      n.y = (pp[i * 2 + 1] - t.oy) / t.s;
    }
  };
  /** Frame the map's BODY: the points inside the 2..98% quantile box (graph-visual-grammar
   *  frameIndices). cosmos's own fitView takes the bounding box of every point, so a handful of
   *  strays shrank the body to a third of the viewport (the 2026-09-03 verdict). */
  const frameAll = (g: Graph, durationMs: number): void => {
    const nodes = pRef.current.nodes;
    const xs: number[] = [], ys: number[] = [], at: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const x = wxOf(nodes[i]), y = wyOf(nodes[i]);
      if (x == null || y == null) continue;
      xs.push(x); ys.push(y); at.push(i);
    }
    const keep = frameIndices(xs, ys).map((k) => at[k]);
    if (keep.length >= 2 && keep.length < nodes.length) g.fitViewByPointIndices(keep, durationMs, FIT_PADDING);
    else g.fitView(durationMs, FIT_PADDING);
    userTouchedRef.current = false; // the camera is where we put it, until the operator moves it
  };
  /** Which points the DOM overlay needs live GPU positions for: the chosen labels, the lit
   *  neighbourhood's labels, the hovered node, the core mark and the project logos. A tracked
   *  readback is a handful of texels per frame; reading every point would be a stall. */
  const refreshTracked = (): void => {
    if (!gpuRef.current) return;
    const g = graphRef.current;
    if (!g || deadRef.current || !readyRef.current) return;
    const idx = idxOfRef.current;
    const set = new Set<number>();
    const add = (n: any): void => { const i = n ? idx.get(n.id) : undefined; if (i !== undefined) set.add(i); };
    for (const n of labelSetRef.current) add(n);
    for (const n of focusLabelsRef.current) add(n);
    if (hoverIdRef.current != null) { const i = idx.get(hoverIdRef.current); if (i !== undefined) set.add(i); }
    for (const n of pRef.current.nodes) if (n.kind === "core" || (n.kind === "project" && n.logo)) add(n);
    trackedRef.current = set;
    safeRun(() => g.trackPointPositionsByIndices(Array.from(set)));
  };
  /** Start or re-heat the simulation, stamping the wall clock for the settle cap. */
  const startSim = (g: Graph, alpha: number): void => {
    simStartedAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    tickCountRef.current = 0;
    g.start(alpha);
    simRunningRef.current = true;
  };
  /** The end of a settle, whether the simulation cooled or the wall-clock cap stopped it. */
  const finishSettle = (): void => {
    simRunningRef.current = false;
    safeRun(() => readBackPositions(graphRef.current!));
    // Frame the SETTLED map once (GPU mode): the mount fit framed the seed positions, and the
    // first settle is where the map takes its shape. After that only the shell re-frames, and
    // only when a settle changed the drawn set and the camera is untouched; Recenter is the way.
    if (!settledOnceRef.current) { settledOnceRef.current = true; if (!userTouchedRef.current) safeRun(() => frameAll(graphRef.current!, 600)); }
    pRef.current.onSettled?.();
    queueOverlaySync(true);
  };
  /** GPU point images: the core mark and the project logos as cosmos sprites, in place of
   *  pooled DOM divs that had to be reprojected on every sync. One atlas, one index per point.
   *  A logo that has not loaded yet (or taints the canvas) keeps its DOM sprite; the next
   *  overlay sync that finds it loaded rebuilds the atlas. */
  const applyImages = (g: Graph): void => {
    const { nodes, adapters } = pRef.current;
    const images: ImageData[] = [];
    const keys = new Map<string, number>();
    // The core mark stays a DOM sprite on purpose: a GPU point image scales with zoom, and at
    // the small core size the map now carries (NODE_SIZE.core) it would be a 3 px smudge at
    // overview. The DOM sprite has an 18 px floor and grows as you zoom in.
    for (const n of nodes) {
      if (n.kind !== "project" || !n.logo || keys.has(n.logo)) continue;
      const im = adapters.logoFor(n.logo);
      const data = im ? imageToImageData(im, 128) : null;
      if (data) { keys.set(n.logo, images.length); images.push(data); }
    }
    const idx = new Float32Array(nodes.length).fill(-1);
    const sizes = new Float32Array(nodes.length);
    const sc = xformRef.current.s;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const key = n.kind === "project" && n.logo ? n.logo : null;
      const k = key ? keys.get(key) : undefined;
      if (k === undefined) continue;
      idx[i] = k;
      // The DOM sprite covered a logo's point at ×~2.3 of its diameter.
      sizes[i] = Math.max(2, adapters.sizeFor(n) * 2.2 * sc) * 2.3;
    }
    imagesRef.current = new Set(keys.keys());
    imagesDirtyRef.current = false;
    if (images.length > 0) g.setImageData(images);
    g.setPointImageIndices(idx);
    g.setPointImageSizes(sizes);
  };

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
    const linkRefs: any[] = [];
    for (const l of links) {
      const sId = l.source && typeof l.source === "object" ? l.source.id : l.source;
      const tId = l.target && typeof l.target === "object" ? l.target.id : l.target;
      const a = idx.get(sId), b = idx.get(tId);
      if (a !== undefined && b !== undefined) { pairs.push(a, b); linkRefs.push(l); }
    }
    const pairArr = Float32Array.from(pairs);
    pairsRef.current = pairArr;
    linkRefsRef.current = linkRefs;
    g.setPointPositions(pos, true);
    g.setLinks(pairArr);
    applyPalette(g);
    applyImages(g);
    applyFocus(g);
    if (gpuRef.current) {
      // cosmos owns the physics: pin the core where the shell pinned it, hand over cluster
      // membership, and give this push only the energy it deserves. The first layout gets a
      // full settle; a refresh that changed the node set seats the newcomers; an unchanged
      // set moves nothing (a brain:updated every few seconds must not re-lay the map).
      const coreIdx = nodes.findIndex((n) => n.kind === "core" || typeof n.fx === "number");
      g.setPinnedPoints(coreIdx >= 0 ? [coreIdx] : null);
      const clusters = pRef.current.clusters;
      g.setPointClusters(clusters ?? new Array(nodes.length).fill(undefined));
      lastClustersRef.current = clusters;
      const alpha = !firstLayoutRef.current ? START_ALPHA.initial : nodes.length !== lastCountRef.current ? START_ALPHA.structural : 0;
      firstLayoutRef.current = true;
      lastCountRef.current = nodes.length;
      g.render(alpha, 0);
      if (alpha > 0) startSim(g, alpha);
    } else {
      g.render(undefined, 0);
    }
    // One initial framing so the mount shows the graph, not an arbitrary corner of the
    // space. Once — never on refreshes (the old "no auto fit-to-screen" rule holds).
    if (!didInitialFitRef.current && nodes.length > 0) {
      didInitialFitRef.current = true;
      safeRun(() => frameAll(graphRef.current!, 0));
    }
    refreshTracked();
    queueOverlaySync();
  });

  const pushPositions = (): void => safeRun(() => {
    if (gpuRef.current) return; // the GPU owns positions; `version` never ticks in this mode
    const g = graphRef.current!;
    const nodes = pRef.current.nodes;
    const pos = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const [sx, sy] = toSpace(wxOf(nodes[i]) ?? 0, wyOf(nodes[i]) ?? 0);
      pos[i * 2] = sx; pos[i * 2 + 1] = sy;
    }
    g.setPointPositions(pos, true);
    // A short transition per snapshot makes the settle read as one smooth motion — something
    // the canvas renderer (hard position snaps) never had. The worker streams every 60 ms
    // (use-graph-layout SNAPSHOT_MS); the tween runs a little longer than that so motion never
    // parks between two snapshots, and a new snapshot simply retargets it.
    g.render(undefined, 70);
    // Light per snapshot (the community names follow the moving map from the fresh node
    // positions); one full membership refresh shortly after the stream pauses.
    refreshClusterCentroids(g, false);
    queueOverlaySync(false);
    if (settleSyncTimerRef.current != null) window.clearTimeout(settleSyncTimerRef.current);
    settleSyncTimerRef.current = window.setTimeout(() => { settleSyncTimerRef.current = null; queueOverlaySync(true); }, 260);
  });

  const applyPalette = (g: Graph): void => {
    const { nodes, adapters, isLight, fireTypes } = pRef.current;
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
    // Iterate the COSMOS-ordered links (pushStructural), not p.links: a link whose endpoint is
    // off the map is skipped there, and colors indexed by p.links would drift after the first
    // skip.
    const linkRefs = linkRefsRef.current;
    const lcolors = new Float32Array(linkRefs.length * 4);
    const lwidths = new Float32Array(linkRefs.length);
    for (let i = 0; i < linkRefs.length; i++) {
      const l = linkRefs[i];
      const [r, gg, b, a] = parseColor(l.__color, linkFallback);
      lcolors[i * 4] = r; lcolors[i * 4 + 1] = gg; lcolors[i * 4 + 2] = b; lcolors[i * 4 + 3] = a;
      lwidths[i] = fireTypes.has(l.type) ? 0.5 : 1;
    }
    // Shape by kind family (graph-visual-grammar). Free at overview zoom, where every mark is a
    // dot regardless; reads the moment you zoom in. Links are always solid: provenance lives in
    // the link tooltip (the dotted lit stroke was withdrawn on the operator's verdict).
    const shapes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) shapes[i] = adapters.shapeFor(nodes[i]);
    baseLinkColorsRef.current = lcolors;
    g.setPointColors(colors);
    g.setPointSizes(sizes);
    g.setPointShapes(shapes);
    g.setLinkColors(lcolors);
    g.setLinkWidths(lwidths);
  };

  // ── link tooltip + walking, LIT links only ────────────────────────────────────────
  const hideLinkTip = (): void => {
    const el = linkTipRef.current;
    if (el && el.style.display !== "none") el.style.display = "none";
  };
  const linkEndpoints = (i: number): { link: any; source: any; target: any } | null => {
    const pairs = pairsRef.current, nodes = pRef.current.nodes, link = linkRefsRef.current[i];
    if (!link) return null;
    const src = nodes[pairs[i * 2]], dst = nodes[pairs[i * 2 + 1]];
    return src && dst ? { link, source: src, target: dst } : null;
  };
  /** The link label the map never had: who connects to whom, which way, and whether the
   *  operator wrote it or the brain inferred it. Shown for a lit link under the pointer. */
  const showLinkTip = (i: number): void => {
    const lit = litLinkSetRef.current;
    if (!lit || !lit.has(i)) { hideLinkTip(); return; }
    const overlay = overlayRef.current;
    const ep = linkEndpoints(i);
    if (!overlay || !ep) return;
    let el = linkTipRef.current;
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = "position:absolute;pointer-events:none;max-width:280px;padding:5px 8px;border-radius:6px;font:11px/1.35 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      overlay.appendChild(el);
      linkTipRef.current = el;
    }
    const { adapters, isLight, width } = pRef.current;
    const directed = adapters.linkArrowFor(ep.link);
    const prov = linkProvenance(ep.link.type);
    el.textContent = "";
    const line1 = document.createElement("div");
    line1.textContent = `${adapters.labelFor(ep.source)} ${directed ? "→" : "·"} ${adapters.labelFor(ep.target)}`;
    const line2 = document.createElement("div");
    line2.style.opacity = "0.7";
    line2.textContent = `${String(ep.link.type || "")} · ${prov === "declared" ? t("declared in a note") : t("inferred by the brain")}`;
    el.appendChild(line1);
    el.appendChild(line2);
    el.style.background = isLight ? "rgba(255,255,255,0.94)" : "rgba(18,19,28,0.94)";
    el.style.color = isLight ? "rgba(24,26,32,0.95)" : "rgba(228,231,240,0.95)";
    el.style.border = isLight ? "1px solid rgba(0,0,0,0.12)" : "1px solid rgba(255,255,255,0.12)";
    const [mx, my] = mouseRef.current;
    el.style.left = `${Math.max(0, Math.min(mx + 14, width - 290))}px`;
    el.style.top = `${my + 14}px`;
    el.style.display = "block";
  };
  /** Clicking a lit connection walks the lock to the node at its far end. */
  const walkLink = (i: number): void => {
    const lit = litLinkSetRef.current;
    if (!lit || !lit.has(i)) return;
    const ep = linkEndpoints(i);
    if (!ep) return;
    const anchor = pRef.current.focusAnchorId;
    const far = ep.source.id === anchor ? ep.target : ep.source;
    hideLinkTip();
    pRef.current.onLinkClick(ep.link, far);
  };

  const applyFocus = (g: Graph): void => {
    const { focusSet, lockId, selectedId, isLight, focusAnchorId, nodes, adapters } = pRef.current;
    const idx = idxOfRef.current;
    const theme = isLight ? "light" : "dark";
    const accent = FOCUS_ACCENT[theme];
    const grey = GREYOUT[theme];
    // A lit set covering every node is no focus at all: pass undefined so cosmos keeps its
    // occlusion-culled fast path, which it leaves whenever highlightedPointIndices is set.
    const focusActive = focusSet != null && focusSet.size < nodes.length;
    const highlighted = focusActive
      ? Array.from(focusSet!, (id) => idx.get(id)).filter((i): i is number => i !== undefined)
      : undefined;
    const lockIdx = lockId != null ? idx.get(lockId) : undefined;
    const selIdx = selectedId != null ? idx.get(selectedId) : undefined;
    const anchorIdx = focusAnchorId != null ? idx.get(focusAnchorId) : undefined;
    const linkRefs = linkRefsRef.current;
    const base = baseLinkColorsRef.current;
    // THE fix for "the cluster lights up but its connections don't". cosmos greys links only
    // through highlightedLinkIndices, which is independent of point highlighting, and this
    // adapter never set it; the map's ink is mostly links, so dimming points alone changed
    // nothing the eye could see (probed live 2026-09-02: a locked 7-point set rendered
    // identically to idle). A link is lit when both endpoints are; the anchor's own links
    // take the brighter tier; a lit directed link gets an arrowhead; everything else recedes
    // to the greyout multipliers the grammar sets.
    //
    // A lit link is a SOLID GRADIENT: with `linkColorInterpolateFromEndpoints` on for the focus,
    // cosmos blends each link's RGB from its source point's colour to its target's along the
    // line and takes only the alpha from the link colour buffer, so the two tiers below are
    // alphas and the hue runs from the hovered node into each neighbour. (The dotted
    // provenance stroke and the flat accent were withdrawn on the operator's verdict of
    // 2026-09-03: "not dotted line but a gradient solid line".)
    let litLinkIdx: number[] | undefined;
    const wasActive = focusWasActiveRef.current;
    if (highlighted && base) {
      const arrows: boolean[] = new Array(linkRefs.length).fill(false);
      const { indices, incident } = litLinks(pairsRef.current, new Set(highlighted), anchorIdx);
      const inc = new Set(incident);
      const colors = new Float32Array(base);
      for (const i of indices) {
        if (!LINK_GRADIENT_IN_FOCUS) { colors[i * 4] = accent[0]; colors[i * 4 + 1] = accent[1]; colors[i * 4 + 2] = accent[2]; }
        colors[i * 4 + 3] = inc.has(i) ? LIT_LINK_ALPHA.incident : LIT_LINK_ALPHA.neighbourhood;
        if (adapters.linkArrowFor(linkRefs[i])) arrows[i] = true;
      }
      g.setLinkColors(colors);
      g.setLinkArrows(arrows);
      litLinkIdx = indices;
      litLinkSetRef.current = new Set(indices);
    } else if (wasActive) {
      // Leaving a focus: restore the two link buffers once. An idle→idle change (a selection
      // ring, a theme flip) uploads nothing for the links; that used to be three O(E) buffers
      // per call.
      if (base) g.setLinkColors(base);
      g.setLinkArrows(new Array(linkRefs.length).fill(false));
      litLinkSetRef.current = null;
    }
    focusWasActiveRef.current = !!highlighted;
    // Labels for the neighbourhood you asked about: the anchor, then its most connected
    // members, capped so a hub's lit set never carpets the view in text. O(lit), so the
    // overlay needs no membership pass over all nodes for a hover.
    if (highlighted) {
      const anchorNode = anchorIdx !== undefined ? nodes[anchorIdx] : null;
      const rest = highlighted.filter((i) => i !== anchorIdx).map((i) => nodes[i]).filter((n) => n && n.kind !== "core");
      rest.sort((a, b) => (b.deg || 0) - (a.deg || 0));
      focusLabelsRef.current = (anchorNode ? [anchorNode] : []).concat(rest.slice(0, MAX_FOCUS_LABELS));
    } else {
      focusLabelsRef.current = [];
    }
    hideLinkTip();
    g.setConfigPartial({
      highlightedPointIndices: highlighted,
      highlightedLinkIndices: litLinkIdx,
      outlinedPointIndices: lockIdx !== undefined ? [lockIdx] : undefined,
      outlinedPointRingColor: accent,
      hoveredPointRingColor: accent,
      focusedPointRingColor: accent,
      focusedPointIndex: selIdx,
      pointGreyoutOpacity: grey.point,
      pointGreyoutColor: grey.pointColor,
      linkGreyoutOpacity: grey.link,
      linkArrowsSizeScale: LIT_ARROW_SCALE,
      // Link hover means something only inside a lit neighbourhood (read a connection, click
      // to walk it); at idle ten thousand whisper links would flicker under the pointer.
      hoveredLinkColor: focusActive ? accent : undefined,
      hoveredLinkWidthIncrease: focusActive ? 1 : 0,
      hoveredLinkCursor: focusActive ? "pointer" : "auto",
      // In focus the lit links run as a solid gradient from the anchor's hue into each
      // neighbour's (the grammar's LINK_GRADIENT_IN_FOCUS); at idle the "higher-priority
      // endpoint's hue" rule stays unless LINK_GRADIENT_AT_IDLE says otherwise.
      linkColorInterpolateFromEndpoints: focusActive ? LINK_GRADIENT_IN_FOCUS : LINK_GRADIENT_AT_IDLE,
    } as any);
  };

  // ── the one Graph instance ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let g: Graph | null = null;
    try {
      g = new Graph(host, {
        enableSimulation: gpuRef.current,
        backgroundColor: [0, 0, 0, 0],       // the wrapper's --app-bg shows through, as before
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        spaceSize: SPACE,
        rescalePositions: false,             // the transform above owns world→space
        fitViewOnInit: false,                // camera persistence: the initial fit is ours, once
        enableDrag: gpuRef.current,          // drag with live physics: the worker path had none
        ...(gpuRef.current ? pRef.current.simParams : {}),
        onSimulationEnd: () => { if (simRunningRef.current) finishSettle(); },
        onSimulationTick: () => {
          // Labels ride the moving points (tracked positions), at half the tick rate: a 30 Hz
          // label is imperceptible, a per-tick readback on a slow GPU is not. Community names
          // re-centre every 30th tick from one full position readback (about twice a second).
          const tick = ++tickCountRef.current;
          if (tick % 30 === 0 && pRef.current.clusterLabels?.length) safeRun(() => refreshClusterCentroids(graphRef.current!, true));
          if ((tick & 1) === 0) queueOverlaySync(false);
          // Wall-clock cap. The decay is a tick count, so a GPU running the same ticks at a
          // third of the frame rate would settle for half a minute, which reads as a hang.
          // Take the layout as it stands; positions are carried, so nothing is lost.
          if (simRunningRef.current && settleShouldStop(simStartedAtRef.current, typeof performance !== "undefined" ? performance.now() : Date.now())) {
            safeRun(() => graphRef.current!.pause());
            finishSettle();
          }
        },
        onDragEnd: () => { safeRun(() => readBackPositions(graphRef.current!)); queueOverlaySync(true); },
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
        onPointContextMenu: (i: number, _pos: [number, number], ev: MouseEvent) => {
          ev.preventDefault();
          const n = pRef.current.nodes[i];
          if (n) pRef.current.onNodeContextMenu(n, ev);
        },
        onBackgroundContextMenu: (ev: MouseEvent) => { ev.preventDefault(); pRef.current.onNodeContextMenu(null, ev); },
        // Registering these is what makes cosmos pick links at all; each acts on LIT links only.
        onLinkMouseOver: (i: number) => showLinkTip(i),
        onLinkMouseOut: () => hideLinkTip(),
        onLinkClick: (i: number) => walkLink(i),
        hoveredLinkWidthIncrease: 0,
        showFPSMonitor: fpsMonitorWanted(),
        onPointMouseOver: (i: number) => {
          const n = pRef.current.nodes[i];
          const id = n?.id ?? null;
          if (id !== hoverIdRef.current) { hoverIdRef.current = id; pRef.current.onNodeHover(n ?? null); }
        },
        onPointMouseOut: () => {
          if (hoverIdRef.current != null) { hoverIdRef.current = null; pRef.current.onNodeHover(null); }
        },
        // per-frame: reproject the chosen labels only. `userDriven` is cosmos's own flag (a
        // wheel, drag or pinch, as opposed to a programmatic fit or zoomToPoint).
        onZoom: (_e: unknown, userDriven: boolean) => { if (userDriven) userTouchedRef.current = true; hideLinkTip(); queueOverlaySync(false); },
        onZoomEnd: () => queueOverlaySync(true), // gesture end: recompute label membership
      } as any);
    } catch {
      deadRef.current = true;
      pRef.current.onFallback();
      return;
    }
    graphRef.current = g;
    // The link tooltip anchors to the pointer; cosmos hands over a link index, not a position.
    const onMove = (e: MouseEvent): void => {
      const r = host.getBoundingClientRect();
      mouseRef.current = [e.clientX - r.left, e.clientY - r.top];
    };
    host.addEventListener("mousemove", onMove);
    // Lasso: shift + drag draws a rectangle and selects the points inside it. Captured on the
    // host BEFORE cosmos's d3-zoom/drag see the press (they listen for mousedown on the canvas),
    // so a shift-drag never pans. Move/up ride on the window, so leaving the map still finishes.
    const lassoPoint = (e: MouseEvent): [number, number] => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const onLassoMove = (e: MouseEvent): void => {
      const l = lassoRef.current; if (!l || !l.el) return;
      const [x, y] = lassoPoint(e);
      l.el.style.left = `${Math.min(l.x0, x)}px`; l.el.style.top = `${Math.min(l.y0, y)}px`;
      l.el.style.width = `${Math.abs(x - l.x0)}px`; l.el.style.height = `${Math.abs(y - l.y0)}px`;
    };
    const onLassoUp = (e: MouseEvent): void => {
      window.removeEventListener("mousemove", onLassoMove, true);
      window.removeEventListener("mouseup", onLassoUp, true);
      const l = lassoRef.current; if (!l) return;
      lassoRef.current = null;
      l.el?.remove();
      const [x, y] = lassoPoint(e);
      const rect: [[number, number], [number, number]] = [[Math.min(l.x0, x), Math.min(l.y0, y)], [Math.max(l.x0, x), Math.max(l.y0, y)]];
      if (rect[1][0] - rect[0][0] < 4 && rect[1][1] - rect[0][1] < 4) return; // a shift-click, not a lasso
      let ids: string[] = [];
      safeRun(() => {
        const idxs = graphRef.current!.findPointsInRect(rect);
        ids = idxs.map((i) => pRef.current.nodes[i]?.id).filter((id): id is string => typeof id === "string");
      });
      pRef.current.onLasso(ids);
    };
    const onLassoDown = (e: MouseEvent): void => {
      if (!e.shiftKey || e.button !== 0 || !readyRef.current) return;
      e.preventDefault(); e.stopPropagation();
      const [x0, y0] = lassoPoint(e);
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;pointer-events:none;border:1px solid rgba(94,234,212,0.9);background:rgba(94,234,212,0.08);border-radius:2px;";
      overlayRef.current?.appendChild(el);
      lassoRef.current = { x0, y0, el };
      window.addEventListener("mousemove", onLassoMove, true);
      window.addEventListener("mouseup", onLassoUp, true);
    };
    host.addEventListener("mousedown", onLassoDown, true);
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
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mousedown", onLassoDown, true);
      window.removeEventListener("mousemove", onLassoMove, true);
      window.removeEventListener("mouseup", onLassoUp, true);
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
    safeRun(() => { const g = graphRef.current!; applyPalette(g); applyImages(g); applyFocus(g); g.render(undefined, 0); });
    queueOverlaySync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paletteVersion]);

  // ── GPU layout: sliders re-tune the running forces; Clusters hands over membership ───────
  useEffect(() => {
    if (!gpuRef.current || deadRef.current || !readyRef.current || !firstLayoutRef.current) return;
    safeRun(() => { const g = graphRef.current!; g.setConfigPartial(p.simParams as any); startSim(g, START_ALPHA.reheat); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.simParams]);
  useEffect(() => {
    if (!gpuRef.current || deadRef.current || !readyRef.current || !firstLayoutRef.current) return;
    // Re-heat only when membership actually changed. The array is rebuilt per graph refresh,
    // and a refresh must not re-lay the map (the refresh-storm lesson).
    const next = p.clusters, prev = lastClustersRef.current;
    const same = next === prev || (!!next && !!prev && next.length === prev.length && next.every((v, i) => v === prev[i]));
    if (same) return;
    lastClustersRef.current = next;
    safeRun(() => { const g = graphRef.current!; g.setPointClusters(next ?? new Array(p.nodes.length).fill(undefined)); g.render(undefined, 0); startSim(g, START_ALPHA.reheat); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.clusters]);

  // ── focus / selection → native greyout + rings ───────────────────────────────────
  useEffect(() => {
    if (deadRef.current || !readyRef.current) return;
    safeRun(() => { const g = graphRef.current!; applyFocus(g); g.render(undefined, 0); });
    refreshTracked();
    // Projection only. This used to request the full membership recompute (the O(N) projection
    // walk measured at p90 50ms) on EVERY hover enter and leave, because focusSet is a fresh
    // Set per hover. The lit neighbourhood's labels now come from focusLabelsRef, filled by
    // applyFocus in O(lit), so nothing here needs a pass over every node.
    queueOverlaySync(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusSet, p.lockId, p.selectedId, p.isLight, p.focusAnchorId]);

  // ── label + core overlay (pooled DOM, reprojected on zoom/position changes) ──────
  // Two speeds, learned from a live probe (zoom p90 hit 50ms with one speed): choosing
  // WHICH nodes get labels is an O(N) projection pass — far too heavy per zoom frame at
  // 4k+ nodes — so membership recomputes only at gesture end / data ticks, while the
  // per-frame sync just reprojects the ≤~65 already-chosen labels to keep them glued.
  const labelSetRef = useRef<any[]>([]);
  /** Community names for the overview: centre of mass of each named community's drawn members,
   *  in WORLD units (computed in the membership pass, projected per sync). */
  const clusterCentroidsRef = useRef<{ label: string; color: string; x: number; y: number; size: number }[]>([]);
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
  /**
   * Community-name centroids in WORLD units, from the freshest positions there are: the GPU's
   * own (one O(N) readback) while cosmos's simulation is moving the points, else the node
   * objects (fresh per worker snapshot, and after a GPU settle's readback). Empty when Clusters
   * is off or the view is zoomed past the overview, where node labels take over. Cheap enough to
   * run per worker snapshot and every ~30th GPU tick, so the names ride the moving map instead
   * of sitting where the communities were when the settle began.
   */
  const refreshClusterCentroids = (g: Graph, liveGpu: boolean): void => {
    const cl = pRef.current.clusterLabels;
    const nodes = pRef.current.nodes;
    const out: { label: string; color: string; x: number; y: number; size: number }[] = [];
    if (cl && cl.length) {
      const pxPerWorld = g.spaceToScreenRadius(1) * xformRef.current.s;
      if (pxPerWorld <= ZOOM_LABEL_PX_PER_WORLD) {
        const idx = idxOfRef.current;
        const t = xformRef.current;
        const pp = liveGpu && gpuRef.current ? g.getPointPositions() : null;
        const usePp = !!pp && pp.length >= nodes.length * 2 && t.s > 0;
        for (const c of cl) {
          let sx = 0, sy = 0, k = 0;
          for (const id of c.members) {
            const i = idx.get(id); if (i === undefined) continue;
            let nx: number | null, ny: number | null;
            if (usePp) { nx = (pp![i * 2] - t.ox) / t.s; ny = (pp![i * 2 + 1] - t.oy) / t.s; }
            else { nx = wxOf(nodes[i]); ny = wyOf(nodes[i]); }
            if (nx == null || ny == null || !Number.isFinite(nx) || !Number.isFinite(ny)) continue;
            sx += nx; sy += ny; k++;
          }
          if (k >= 5) out.push({ label: c.label, color: c.color, x: sx / k, y: sy / k, size: k });
        }
      }
    }
    clusterCentroidsRef.current = out;
  };
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
      // Space position of a node: the GPU's own (tracked) while the simulation owns the
      // physics, else the node object's world coords through the transform.
      const tracked = gpuRef.current ? g.getTrackedPointPositionsMap() : null;
      const spaceOf = (n: any): [number, number] | null => {
        if (tracked) {
          const i = idxOfRef.current.get(n.id);
          const tp = i !== undefined ? tracked.get(i) : undefined;
          if (tp) return [tp[0], tp[1]];
        }
        const nx = wxOf(n), ny = wyOf(n);
        return nx == null || ny == null ? null : toSpace(nx, ny);
      };
      if (recompute && showLabels) {
        // MEMBERSHIP pass (O(N) projections) — gesture-end / data-tick only. It gathers
        // CANDIDATES; the projection pass below places them against a viewport budget with
        // overlap culling (the 40 zoom labels plus every anchor used to pile onto the centre
        // of a 900 px window).
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
          // Twice the label cap: the culling below needs alternatives when the top ones collide.
          for (let i = 0; i < pool.length && i < MAX_ZOOM_LABELS * 2; i++) chosen.push(pool[i].n);
        }
        labelSetRef.current = chosen;
        // Community names at OVERVIEW (Clusters on): each named community's centre of mass over
        // its drawn members (refreshClusterCentroids; live GPU positions while a simulation runs).
        refreshClusterCentroids(g, simRunningRef.current);
      } else if (recompute) {
        labelSetRef.current = [];
        clusterCentroidsRef.current = [];
      }
      if (recompute) refreshTracked();
      // PROJECTION pass — every sync, over the candidates only (≤ ~150), then greedy placement
      // (graph-visual-grammar placeLabels): no two labels overlap, the important ones win, and
      // the count never exceeds what the viewport can hold (labelBudget).
      type Placed = { key: string; text: string; sx: number; top: number; w: number; h: number; font: string; color: string; priority: number };
      const ink = isLight ? "rgba(24,26,32,0.92)" : "rgba(225,228,240,0.92)";
      const cands: Placed[] = [];
      if (showLabels) {
        // The zoom/anchor membership plus the lit neighbourhood (applyFocus) and the hovered
        // node, deduped by id. Neither extra needs the O(N) membership pass.
        const focusIds = new Set<string>(focusLabelsRef.current.map((n: any) => n.id));
        const anchorId = focusLabelsRef.current[0]?.id;
        const seenIds = new Set<string>();
        const merged: any[] = [];
        const take = (n: any): void => { if (n && !seenIds.has(n.id)) { seenIds.add(n.id); merged.push(n); } };
        for (const n of focusLabelsRef.current) take(n);
        if (hoverId != null) { const hi = idxOfRef.current.get(hoverId); if (hi !== undefined) take(nodes[hi]); }
        for (const n of labelSetRef.current) take(n);
        for (const n of merged) {
          const sp = spaceOf(n);
          if (!sp) continue;
          const [sx, sy] = g.spaceToScreenPosition(sp);
          if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;
          const text = adapters.labelFor(n);
          const r = g.spaceToScreenRadius(Math.max(2, adapters.sizeFor(n) * 2.2 * xformRef.current.s) / 2);
          const priority = n.id === selectedId || n.id === hoverId ? 5 : n.id === anchorId ? 4.5 : focusIds.has(n.id) ? 4 : adapters.isAnchor(n) ? 3 : 1 + Math.min(1, (n.deg || 0) / 1000);
          cands.push({ key: n.id, text, sx, top: sy + r + 3, w: estimateLabelWidth(text, 9), h: 12, font: "9px ui-sans-serif, system-ui, sans-serif", color: ink, priority });
        }
        for (const c of clusterCentroidsRef.current) {
          const [sx, sy] = g.spaceToScreenPosition(toSpace(c.x, c.y));
          if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;
          cands.push({ key: `cluster:${c.label}`, text: c.label, sx, top: sy - 7, w: estimateLabelWidth(c.label, 11), h: 14, font: "600 11px ui-sans-serif, system-ui, sans-serif", color: c.color, priority: 3.5 });
        }
      }
      const budget = labelBudget(width, height, MAX_ZOOM_LABELS + MAX_FOCUS_LABELS);
      const chosenBoxes = placeLabels(cands.map((c): LabelCandidate => ({ id: c.key, x: c.sx, y: c.top, w: c.w, h: c.h, priority: c.priority })), budget);
      const byKey = new Map(cands.map((c) => [c.key, c]));
      const placed = chosenBoxes.map((b) => byKey.get(b.id)).filter((c): c is Placed => !!c);
      // pooled label divs
      const pool = labelPoolRef.current;
      while (pool.length < placed.length) {
        const el = document.createElement("div");
        el.style.cssText = "position:absolute;transform:translate(-50%,0);pointer-events:none;white-space:nowrap;";
        overlay.appendChild(el);
        pool.push(el);
      }
      for (let i = 0; i < pool.length; i++) {
        const el = pool[i];
        if (i < placed.length) {
          const c = placed[i];
          if (el.textContent !== c.text) el.textContent = c.text;
          if (el.style.font !== c.font) el.style.font = c.font;
          el.style.color = c.color;
          el.style.left = `${c.sx}px`;
          el.style.top = `${c.top}px`;
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
        if (imagesRef.current.has(n.logo)) continue; // drawn by the GPU atlas; no DOM sprite
        if (!imagesDirtyRef.current && adapters.logoFor(n.logo)) imagesDirtyRef.current = true; // loaded since the last atlas: rebuild below
        const sp = spaceOf(n);
        if (!sp) continue;
        const [sx, sy] = g.spaceToScreenPosition(sp);
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
      if (imagesDirtyRef.current) safeRun(() => { const gg = graphRef.current!; applyImages(gg); gg.render(undefined, 0); });
      // core logo sprite tracks its node whether or not labels are on (always the DOM sprite,
      // so it keeps an 18 px floor at overview; see applyImages)
      const coreNode = nodes.find((n) => n.kind === "core");
      const coreSp = coreNode ? spaceOf(coreNode) : null;
      if (coreNode && coreSp && coreMarkUrl) {
        let el = coreElRef.current;
        if (!el) {
          el = document.createElement("div");
          el.className = "cosmos-core-mark";
          el.style.cssText = "position:absolute;transform:translate(-50%,-50%);pointer-events:none;background-size:contain;background-repeat:no-repeat;background-position:center;";
          el.style.backgroundImage = `url(${coreMarkUrl})`;
          overlay.appendChild(el);
          coreElRef.current = el;
        }
        const [sx, sy] = g.spaceToScreenPosition(coreSp);
        // spaceToScreenRadius(point size) ≈ the disc's on-screen DIAMETER already;
        // 1.15 lets the badge just cover its point. (First cut used ×2.6 — a huge medallion.)
        // 18 px floor: the mark stays legible at overview now that the core point is small.
        const px = Math.max(18, g.spaceToScreenRadius(adapters.sizeFor(coreNode) * 2.2 * xformRef.current.s) * 1.15);
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
  useEffect(() => { queueOverlaySync(true); }, [p.showLabels, p.isLight, p.nodes, p.width, p.height, p.clusterLabels]);

  useImperativeHandle(ref, (): CosmosBrainCanvasHandle => ({
    focusNode: (id: string) => {
      if (deadRef.current || !readyRef.current) return;
      const i = idxOfRef.current.get(id);
      if (i !== undefined) safeRun(() => graphRef.current!.zoomToPointByIndex(i, 600, FOCUS_ZOOM, false));
    },
    fitView: (durationMs = 600, opts) => {
      if (deadRef.current || !readyRef.current) return;
      if (opts?.onlyIfUntouched && userTouchedRef.current) return; // the operator set this camera
      safeRun(() => frameAll(graphRef.current!, durationMs));
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

/// <reference lib="webworker" />
// Off-main-thread force layout for the brain graph.
//
// WHY: react-force-graph runs d3-force on the main thread, one tick per animation
// frame. Measured on the live brain (6,226 nodes / 17,217 links) a single tick costs
// ~67ms, so the 60-tick settle that fires on every graph change pinned the whole app
// at ~8.5fps for four seconds. The arithmetic is irreducible — forceManyBody is
// O(n log n) and rebuilds a quadtree per tick — so the only real fix is to stop doing
// it where it blocks painting.
//
// The worker runs the identical force configuration to `brain-shell.tsx` and streams
// position snapshots back every `snapshotMs`. The UI applies each snapshot with
// cooldownTicks=0, so the graph visibly settles at 60fps while the maths happens here.
//
// TWO MESSAGES, not one. A `layout` request is structural: it carries the node list,
// seed positions and links, and starts a fresh settle. A `params` update is a slider in
// hand: it re-tunes the forces of the run already here and re-heats it in place. The
// second used to be expressed as the first — every pixel of slider travel serialised the
// whole graph and restarted from alpha 1, so the graph jumped and the thumb stuttered.
import { applyForceParams, buildSimulation, type ForceParams, type SimEdge, type SimNode } from "./graph-layout-sim";
import { REHEAT_ALPHA } from "./graph-layout-forces";
import type { Simulation } from "d3-force";

export type LayoutRequest = ForceParams & {
  kind?: "layout";
  token: number;
  /** Node ids, in the order positions are returned. */
  ids: string[];
  /** Seed positions; NaN means "no known position, let d3 place it". */
  x: Float32Array;
  y: Float32Array;
  /** 1 = pin at the seed position (the CORE anchor). */
  pinned: Uint8Array;
  /** Flat [srcIdx, dstIdx, ...] pairs. */
  links: Uint32Array;
  /** Each node's drawn radius (world units). Present = collision on: nodes keep clear of each other. */
  radius?: Float32Array;
  /** Starting energy (graph-layout-forces `seedAlpha`): 1 for an unseeded run, less when most nodes already sit somewhere. */
  alpha?: number;
  maxTicks: number;
  snapshotMs: number;
};

/**
 * Re-tune the forces of the run identified by `token` and re-heat it. Ignored for any
 * token but the current one; acknowledged with a `done` response if that run has no
 * simulation to re-heat (an empty graph), so the UI never waits on a reply that is not
 * coming. `alpha` is the energy to re-heat to (graph-layout-forces `reheatAlphaFor`:
 * proportional to how far the slider travelled); absent = the 0.3 ceiling.
 */
export type LayoutParamsUpdate = ForceParams & { kind: "params"; token: number; alpha?: number };

export type LayoutMessage = LayoutRequest | LayoutParamsUpdate;

export type LayoutResponse = {
  token: number;
  done: boolean;
  ticks: number;
  /** Flat [x0, y0, x1, y1, ...] matching `ids` order. */
  pos: Float32Array;
};

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Token of the most recent request; older runs abandon themselves mid-flight. */
let currentToken = -1;

/** The run in flight (or just finished — it stays re-heatable until a new layout replaces it). */
type Run = {
  token: number;
  sim: Simulation<SimNode, SimEdge>;
  nodes: SimNode[];
  deg: Uint32Array;
  ticks: number;
  maxTicks: number;
  snapshotMs: number;
  lastPost: number;
  /** True while a `step` chain is scheduled; a re-heat on a finished run restarts it. */
  stepping: boolean;
};
let run: Run | null = null;

function snapshot(nodes: SimNode[]): Float32Array {
  const pos = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    pos[i * 2] = nodes[i].x ?? 0;
    pos[i * 2 + 1] = nodes[i].y ?? 0;
  }
  return pos;
}

function post(token: number, done: boolean, ticks: number, nodes: SimNode[]): void {
  const pos = snapshot(nodes);
  const msg: LayoutResponse = { token, done, ticks, pos };
  ctx.postMessage(msg, [pos.buffer]);
}

// Chunked so a superseding request can cancel a long settle instead of queueing
// behind it. setTimeout(0) yields to the message queue between chunks — which is
// also what lets a `params` update land mid-settle.
function step(r: Run): void {
  if (r !== run) { r.stepping = false; return; } // superseded — drop this run
  const chunkEnd = Date.now() + 24;
  while (r.ticks < r.maxTicks && r.sim.alpha() > r.sim.alphaMin() && Date.now() < chunkEnd) {
    r.sim.tick();
    r.ticks++;
  }
  // A non-finite alpha would make both comparisons false forever: the run would never tick,
  // never finish, and post an unchanged snapshot every cycle. Treat it as finished.
  const finished = r.ticks >= r.maxTicks || r.sim.alpha() <= r.sim.alphaMin() || !Number.isFinite(r.sim.alpha());
  const now = Date.now();
  if (finished) {
    r.stepping = false;
    post(r.token, true, r.ticks, r.nodes);
    return;
  }
  if (now - r.lastPost >= r.snapshotMs) {
    r.lastPost = now;
    post(r.token, false, r.ticks, r.nodes);
  }
  setTimeout(() => step(r), 0);
}

function startRun(req: LayoutRequest): void {
  const { ids, x, y, pinned, links, radius, maxTicks, snapshotMs, token } = req;
  const n = ids.length;
  if (n === 0) {
    run = null;
    post(token, true, 0, []);
    return;
  }

  const nodes: SimNode[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const node: SimNode = { idx: i };
    // NaN seeds are left undefined so d3's phyllotaxis placement handles them.
    if (Number.isFinite(x[i])) node.x = x[i];
    if (Number.isFinite(y[i])) node.y = y[i];
    if (pinned[i] === 1) { node.fx = node.x ?? 0; node.fy = node.y ?? 0; }
    nodes[i] = node;
  }

  const linkCount = links.length >> 1;
  const edges: SimEdge[] = new Array(linkCount);
  const deg = new Uint32Array(n);
  for (let i = 0; i < linkCount; i++) {
    const s = links[i * 2], t = links[i * 2 + 1];
    edges[i] = { source: nodes[s], target: nodes[t] };
    deg[s]++; deg[t]++;
  }

  const sim = buildSimulation(nodes, edges, deg, req, radius);
  if (typeof req.alpha === "number" && req.alpha > 0 && req.alpha < 1) sim.alpha(req.alpha);
  run = { token, sim, nodes, deg, ticks: 0, maxTicks, snapshotMs, lastPost: Date.now(), stepping: true };
  step(run);
}

/** Re-tune the run's forces and give it the energy to re-settle — from where it is, not from scratch. */
function reheat(r: Run, p: LayoutParamsUpdate): void {
  applyForceParams(r.sim, r.deg, p);
  // Only ever UP to the requested energy: a run still hot from a bigger move keeps its heat.
  // A missing or non-finite alpha means the ceiling (NaN would wedge the run, see step()).
  const wanted = typeof p.alpha === "number" && Number.isFinite(p.alpha) ? p.alpha : REHEAT_ALPHA.max;
  r.sim.alpha(Math.max(r.sim.alpha(), Math.min(REHEAT_ALPHA.max, Math.max(REHEAT_ALPHA.min, wanted))));
  r.ticks = 0; // a fresh tick budget for the new settle
  if (!r.stepping) {
    r.stepping = true;
    r.lastPost = Date.now();
    step(r);
  }
}

ctx.onmessage = (e: MessageEvent<LayoutMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg.token !== "number") return;
  if (msg.kind === "params") {
    if (msg.token !== currentToken) return; // for a run the UI has already abandoned
    if (run && run.token === msg.token) reheat(run, msg);
    else post(msg.token, true, 0, []); // nothing to re-heat (empty graph) — say so
    return;
  }
  currentToken = msg.token;
  try {
    startRun(msg);
  } catch {
    // A layout failure must never take the graph down — the UI keeps whatever
    // positions it already had and falls back to settling on the main thread.
    ctx.postMessage({ token: msg.token, done: true, ticks: 0, pos: new Float32Array(0) } as LayoutResponse);
  }
};

import { useEffect, useRef, useState } from "react";
import type { LayoutParamsUpdate, LayoutRequest, LayoutResponse } from "./graph-layout.worker";

/** d3's own stopping point; a settle that reaches it is genuinely converged. */
const MAX_TICKS = 400;
/** How often the worker streams intermediate positions back (ms). */
const SNAPSHOT_MS = 120;

export type GraphLayoutParams = {
  /** The live node objects the renderer draws — positions are written back into these. */
  nodes: any[];
  links: any[];
  /** Changes to this string trigger a fresh layout; force changes re-tune the one in flight. */
  signature: string;
  charge: number;
  linkDistance: number;
  /** < 0 selects d3's adaptive default (1 / min degree). */
  linkStrength: number;
  centerStrength: number;
  velocityDecay: number;
  /** False parks the worker (e.g. graph not loaded yet). */
  enabled: boolean;
};

export type GraphLayoutState = {
  /** Bumps whenever fresh positions have been written into `nodes`. */
  version: number;
  /** True while a layout is in flight. */
  computing: boolean;
  /** False when the worker could not be constructed — caller must settle on the main thread. */
  available: boolean;
};

/**
 * Computes the force layout in a worker and writes the results straight into the
 * live node objects, so the renderer can run with cooldownTicks=0 and never block
 * on d3-force. Falls back to `available: false` if the worker cannot start, which
 * lets the caller restore the original main-thread settle.
 *
 * Two kinds of change reach the worker, and they are deliberately not the same message:
 *   · a STRUCTURAL change (`signature`, `enabled`) serialises nodes + links and starts a
 *     fresh settle;
 *   · a FORCE change (the four sliders) re-tunes the run already there and re-heats it
 *     in place. It used to be sent as a structural change — every pixel of slider travel
 *     re-serialised 15k nodes and restarted from alpha 1, which is why the graph jumped
 *     and the thumb stuttered while dragging.
 */
export function useGraphLayout(p: GraphLayoutParams): GraphLayoutState {
  const workerRef = useRef<Worker | null>(null);
  const tokenRef = useRef(0);
  const nodesRef = useRef<any[]>(p.nodes);
  const linksRef = useRef<any[]>(p.links);
  /**
   * The node ids sent with the in-flight request, in the order the worker returns positions.
   * Written together with `tokenRef`, so a response that passes the token check is guaranteed
   * to be describing exactly these ids — which is what makes an id-keyed apply safe.
   */
  const reqIdsRef = useRef<string[]>([]);
  const [available, setAvailable] = useState(true);
  const [computing, setComputing] = useState(false);
  const [version, setVersion] = useState(0);

  nodesRef.current = p.nodes;
  linksRef.current = p.links;
  // The forces, readable by the structural post without sitting in its deps: a fresh
  // layout must carry the CURRENT slider values, but must not be re-triggered by them.
  const forcesRef = useRef({ charge: p.charge, linkDistance: p.linkDistance, linkStrength: p.linkStrength, centerStrength: p.centerStrength, velocityDecay: p.velocityDecay });
  forcesRef.current = { charge: p.charge, linkDistance: p.linkDistance, linkStrength: p.linkStrength, centerStrength: p.centerStrength, velocityDecay: p.velocityDecay };

  // Spawn once. A construction failure (bundling, CSP, unsupported runtime) is not
  // fatal — it just returns the component to the pre-worker behaviour.
  useEffect(() => {
    let w: Worker | null = null;
    try {
      w = new Worker(new URL("./graph-layout.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setAvailable(false);
      return;
    }
    workerRef.current = w;
    w.onerror = () => { setAvailable(false); setComputing(false); };
    w.onmessage = (e: MessageEvent<LayoutResponse>) => {
      const r = e.data;
      if (!r || r.token !== tokenRef.current) return; // stale run
      // Apply BY ID, not by array position. `nodesRef.current` is reassigned on every render,
      // so the array this response is applied to is not necessarily the array it was computed
      // from — the LOD cull, a lens change or a cluster filter can swap it while a run is in
      // flight. The token only proves "same request"; it says nothing about the node array
      // having kept its order. Writing positionally across a reordered array teleports nodes
      // onto each other's coordinates, which reads exactly like a layout bug.
      const ids = reqIdsRef.current;
      const nodes = nodesRef.current;
      const byId = new Map<string, any>();
      for (const n of nodes) byId.set(n.id, n);
      const count = Math.min(ids.length, r.pos.length >> 1);
      let applied = 0;
      for (let i = 0; i < count; i++) {
        const n = byId.get(ids[i]);
        if (!n) continue; // node left the drawn set between request and response
        // Never fight a pinned node (the CORE anchor) or one the user is dragging.
        if (typeof n.fx === "number" || typeof n.fy === "number") continue;
        n.x = r.pos[i * 2];
        n.y = r.pos[i * 2 + 1];
        n.vx = 0; n.vy = 0;
        applied++;
      }
      if (applied > 0) setVersion((v) => v + 1);
      if (r.done) setComputing(false);
    };
    return () => { w?.terminate(); workerRef.current = null; };
  }, []);

  // STRUCTURAL: re-layout on a change to the drawn set — never on a hover, a camera move,
  // a re-render, or a slider.
  useEffect(() => {
    if (!available || !p.enabled) return;
    const w = workerRef.current;
    const nodes = nodesRef.current;
    if (!w || nodes.length === 0) return;

    const idx = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].id, i);

    const n = nodes.length;
    const x = new Float32Array(n), y = new Float32Array(n), pinned = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      // NaN tells the worker "no seed" so d3 places it; a known position keeps the
      // layout stable across refreshes instead of re-scattering the whole graph.
      x[i] = typeof nd.fx === "number" ? nd.fx : (typeof nd.x === "number" ? nd.x : NaN);
      y[i] = typeof nd.fy === "number" ? nd.fy : (typeof nd.y === "number" ? nd.y : NaN);
      if (typeof nd.fx === "number" || typeof nd.fy === "number") pinned[i] = 1;
    }

    const pairs: number[] = [];
    for (const l of linksRef.current) {
      // force-graph rewrites source/target from id to node object once it has run.
      const s = idx.get(typeof l.source === "object" && l.source ? l.source.id : l.source);
      const t = idx.get(typeof l.target === "object" && l.target ? l.target.id : l.target);
      if (s !== undefined && t !== undefined) pairs.push(s, t);
    }

    const ids = nodes.map((nd) => nd.id as string);
    // Bump the token and record the ids it describes in the same breath — the response
    // handler pairs them to apply positions by id instead of by array position.
    const token = ++tokenRef.current;
    reqIdsRef.current = ids;
    const req: LayoutRequest = {
      kind: "layout", token, ids, x, y, pinned,
      links: Uint32Array.from(pairs),
      ...forcesRef.current,
      maxTicks: MAX_TICKS, snapshotMs: SNAPSHOT_MS,
    };
    setComputing(true);
    w.postMessage(req, [x.buffer, y.buffer, pinned.buffer, req.links.buffer]);
    // Nodes, links and forces are read through refs on purpose — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.signature, available, p.enabled]);

  // FORCES: a slider moved. Re-tune the run in flight; the worker re-heats it from where
  // it is. The first run is skipped — the structural post above already carried these
  // values — and so is any change before a layout exists to re-tune.
  const forcesSeen = useRef(false);
  useEffect(() => {
    if (!forcesSeen.current) { forcesSeen.current = true; return; }
    const w = workerRef.current;
    if (!w || !available || !p.enabled || tokenRef.current === 0) return;
    const msg: LayoutParamsUpdate = { kind: "params", token: tokenRef.current, ...forcesRef.current };
    setComputing(true);
    w.postMessage(msg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.charge, p.linkDistance, p.linkStrength, p.centerStrength, p.velocityDecay]);

  return { version, computing, available };
}

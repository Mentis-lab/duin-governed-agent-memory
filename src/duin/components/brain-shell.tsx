"use client";
import { t } from '@/lib/i18n'
/* eslint-disable @typescript-eslint/no-explicit-any */

// BrainMap — the MAP face of the workspace: the CORE-centered neuron graph. The lens bar focuses the
// graph (All · Notes · Projects); the inner-left rail is the file tree (All/Notes) or the project→tracks
// tier list (Projects, mirroring the Projects page). Picking a node sets it as the omnibox CONTEXT (the
// chip), and for the things that have a real detail — a Project (→ the same ProjectDetailInner bubble as
// the Projects page) or a note (→ DocView) — opens a generous slide-over. The omnibox is centered along
// the bottom of the whole workspace and hands off to the chat popup.

import dynamic from "@/duin/lib/dynamic";
import SpriteText from "three-spritetext"; // persistent text labels for the 3D graph
import * as THREE from "three"; // image sprites for project/core node logos (billboarded in 3D)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark, CalendarClock, Check, ChevronDown, ChevronRight, FileText, Folder, FolderKanban, Hash, Layers,
  Loader2, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, Target, Upload, X,
} from "lucide-react";
import {
  fetchBrainGraph, fetchEventPrep, fetchFutures, fetchProjects, fetchTracks, uploadToRaw,
  type BrainGraph, type BrainNode, type EventPrep, type Project, type Stream, type Track,
} from "@/duin/lib/state";
import { forceX, forceY } from "d3-force"; // per-node inward pull; forceCenter cannot compact
import { runAgent } from "@/duin/lib/agui-client";
import { useGraphLayout } from "@/duin/lib/use-graph-layout";
import { positionalStrength } from "@/duin/lib/graph-layout-forces";
import { cullForLod, focusNeighbourhood } from "@/duin/lib/graph-lod";
import { LayoutSlider } from "@/duin/components/layout-slider";
import { getGraphColors, resolveColor } from "@/duin/lib/graph-colors";
import { DEFAULT_KIND_COLOR, getSchemeColors, getSchemePalette } from "@/duin/lib/graph-schemes";
import { forLight } from "@/duin/lib/light-color";
import { fetchSpaces, type Space } from "@/duin/lib/state";
import { useSettingsStore } from "@/stores/settings-store";
import { KIND_META } from "@/duin/components/views/node-panel";
import { ProjectDetailInner } from "@/duin/components/views/project-workspace";
import { DocView } from "@/duin/components/views/doc-view";
import { Sheet, SheetContent } from "@/duin/components/ui/sheet";
import type { View } from "@/duin/components/app-sidebar";
import { graphSignature } from '@/duin/lib/graph-signature'
import { useBrainStore } from "@/stores/brain-store"; // shared seam → lamprey-native Brain Explorer
import { useUiStore } from "@/stores/ui-store"; // open the Explorer panel to show node detail
import { markOnboarded } from "@/lib/brain-seed"; // CTA converts the demo → a real vault
import { CosmosBrainCanvas, type CosmosBrainCanvasHandle } from "@/duin/components/cosmos-brain-canvas"; // Tier 3: GPU 2D renderer

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false }); // 3D brain toggle (reversible — default off)
const AGUI_URL = (): string =>
  ((typeof window !== "undefined" && (window as any).__DUIN_BASE) || "http://127.0.0.1:8799") + "/agui";
const km = (k: string) => KIND_META[k] || { color: "#94a3b8", label: k };

// Default kind→color map. Sourced from graph-schemes' DEFAULT_KIND_COLOR so the
// canonical "default" scheme and this static fallback can never drift. The live
// graph reads the ACTIVE scheme (settings.brainGraphScheme) inside the
// component; this remains the fallback for any module-scope use.
const KIND_COLOR: Record<string, string> = DEFAULT_KIND_COLOR;
const FIRE = new Set(["wiki", "in", "loose"]);
const ROADMAP_KINDS = new Set(["event", "milestone", "release"]); // anchor-derived dated nodes — treated as one roadmap family
// "Memory" node = a file-backed vault document (a note/card/decision .md you can open). Everything else
// — people, orgs, topics, and the derived roadmap/OKR structure — is a "brain" node (extracted by the
// construction pass, with no .md to open). Mirrors isVaultNote in BrainExplorerPanel.
const isMemoryNode = (n: any): boolean => !!n && (n.layer === "vault" || /\.md$/i.test(String(n.id ?? "")));
// Map a node's file last-modified (ms) → opacity multiplier for the Recent fade:
// full for the last week, easing to a 0.3 floor by ~90 days old. `now` is passed
// so every node in a frame uses the same clock.
function recencyMul(mtime: number, now: number): number {
  const days = (now - mtime) / 86400000;
  if (days <= 7) return 1;
  return Math.max(0.3, Math.min(1, 1 - ((days - 7) / 83) * 0.7));
}
// Link coloring by node priority: a link takes the colour of its HIGHER-priority endpoint.
const KIND_PRIO: Record<string, number> = { core: 100, goal: 95, event: 90, milestone: 90, release: 90, strategy: 85, track: 80, kr: 78, project: 72, move: 64, folder: 56, org: 40, person: 36 };
const prio = (n: any): number => (n ? (KIND_PRIO[n.kind] ?? (n.layer === "product" ? 50 : 0)) + Math.min(20, n.deg || 0) : 0);
// Cornerstone / structural nodes — the map's skeleton (core, folders, and the
// product-layer roadmap: projects, tracks, goals, KRs, strategy, milestones).
// These carry ALWAYS-ON labels; everything else reveals on zoom / proximity.
// Keyed on KIND, not degree — a busy-but-mundane hub shouldn't out-label a
// meaningful low-degree node (that degree heuristic read as arbitrary).
// LAYER-GATED: the roadmap-family kinds only count as skeleton in the PRODUCT
// layer. LLM-extracted CONSTRUCTION entities are frequently kinded project/event
// too (e.g. a passing "Blue Protocol"/"afk-claude2" mention) — labelling those
// permanently, while sibling extracted org/topic/person entities stay unlabelled,
// is the arbitrary-looking pop-in the user sees. Construction entities reveal on
// zoom like any other extracted node; only the deliberate roadmap is always-on.
const ROADMAP_FAMILY_KINDS = new Set(["project", "track", "strategy", "goal", "kr", ...ROADMAP_KINDS]);
const isCornerstone = (n: any): boolean =>
  !!n && (
    n.kind === "core" || n.kind === "folder" ||
    (n.layer === "product" && ROADMAP_FAMILY_KINDS.has(n.kind))
  );
// The ONLY always-on anchor labels: the vault's real top-level FOLDERS act as the
// map's region legend ("where am I"). Folders are objective, stable structure —
// never LLM-extracted — so this stays immune to the arbitrary-label problem that
// sank the old kind-based rule. Machine/dot + archive (_-prefixed) folders are
// excluded as noise.
const isAnchorLabel = (n: any): boolean =>
  !!n && n.kind === "folder" && typeof n.label === "string" &&
  !n.label.startsWith(".") && !n.label.startsWith("_");
// Stable per-id integer, for jitter that stays put across refreshes (Math.random would
// make a node hop every time the graph reloaded).
const hashId = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
};
const withAlpha = (col: string, a: number): string => { const m = /^#([0-9a-f]{6})$/i.exec(col || ""); if (!m) return col; const x = parseInt(m[1], 16); return `rgba(${(x >> 16) & 255},${(x >> 8) & 255},${x & 255},${a})`; };
// forLight (node/link hue darkening for the light theme) now lives in
// @/duin/lib/light-color so the tool panels share the exact same adaptation.
// Recall-style graph layout controls. Each force axis is a 0..100 slider whose
// MIDPOINT (50) reproduces the exact d3-force default the graph ships with, so an
// untouched graph is pixel-identical; connectionDepth is the N-hop focus radius.
type GraphLayout = { nodeSpacing: number; linkLength: number; linkForce: number; centerForce: number; connectionDepth: number };
/** The four slider-driven axes — everything in GraphLayout that moves a node. */
type ForceAxis = "nodeSpacing" | "linkLength" | "linkForce" | "centerForce";
const DEFAULT_GRAPH_LAYOUT: GraphLayout = { nodeSpacing: 50, linkLength: 50, linkForce: 50, centerForce: 50, connectionDepth: 2 };
// Map a 0..100 slider (50 = the graph's current value) to a physics value via two
// linear ramps that meet at the mid anchor, so 50 lands EXACTLY on `atMid`. Values
// are clamped to sane endpoints; the CORE stays pinned (fx/fy=0) regardless, so no
// setting can eject it.
function rampFrom50(v: number, atLow: number, atMid: number, atHigh: number): number {
  const t = Math.max(0, Math.min(100, v));
  return t <= 50 ? atLow + (atMid - atLow) * (t / 50) : atMid + (atHigh - atMid) * ((t - 50) / 50);
}
const D_PATH = "M28 16 H52 C72 16 84 28 84 50 C84 72 72 84 52 84 H28 Z M44 30 H51 C61 30 68 39 68 50 C68 61 61 70 51 70 H44 Z";
let _dLogo: Path2D | null = null;
const dLogo = (): Path2D | null => { if (typeof Path2D === "undefined") return null; if (!_dLogo) _dLogo = new Path2D(D_PATH); return _dLogo; };
// Per-project node logos — PNGs uploaded via the Projects menu, served from /project-logos/<slug>.png.
// A project node whose graph data carries `logo` renders AS the image (2D draw + 3D billboard sprite).
const _logoCache: Record<string, HTMLImageElement> = {};
function logoFor(url: string): HTMLImageElement | null {
  if (typeof window === "undefined" || !url) return null;
  let img = _logoCache[url];
  if (!img) { img = new Image(); img.src = url; _logoCache[url] = img; }
  return img.complete && img.naturalWidth ? img : null;
}
// The DUIN CORE mark (the 2D vector logo) rasterised once to a texture, so 3D can show the core as a
// screen-facing billboard sprite (THREE.Sprite always faces the camera and never rotates).
let _coreTex: THREE.CanvasTexture | null = null;
// Cache key = theme mode + accent; the rasterised core must rebuild when either
// changes, else 3D keeps a stale dark badge / old accent dot after a theme switch.
let _coreTexKey = "";
// The DUIN core mark: brain-wave lines within a ring on the dark brand ground,
// drawn in a 100×100 box. Shared by the 3D billboard sprite and the 2D core node
// so the graph core matches the titlebar logo + app icon.
let _corePath: Path2D | null = null;
const corePath = (): Path2D | null => {
  if (typeof Path2D === "undefined") return null;
  if (!_corePath) _corePath = new Path2D("M50 96 C29 93 18 74 25 55 C29 43 41 37 51 41 C51 29 67 21 81 27 C87 17 105 19 111 31 C125 32 133 50 126 65 C120 82 107 93 89 90 C69 87 57 73 64 59 C69 49 84 47 93 55");
  return _corePath;
};
function drawCoreMark(ctx: CanvasRenderingContext2D, accentOverride?: string): void {
  const light = typeof document !== "undefined" && document.documentElement.dataset.themeMode === "light";
  ctx.save();
  // Brand badge — light paper on the light theme, near-black brand ground on dark.
  ctx.beginPath(); ctx.arc(50, 50, 49, 0, 2 * Math.PI);
  ctx.fillStyle = light ? "#EEF0F3" : "#101013"; ctx.fill();
  // Single continuous-line brain mark (150×120 viewBox), fitted into the badge;
  // content centres ~ (74,58). Matches the titlebar logo + app icon.
  const p = corePath();
  if (p) {
    ctx.save();
    ctx.translate(50, 53); ctx.scale(0.52, 0.52); ctx.translate(-74, -58);
    // Ink strokes on light paper; off-white strokes on the dark badge.
    ctx.strokeStyle = light ? "#191A1E" : "#F2F0EA"; ctx.lineWidth = 6.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.stroke(p);
    // Accent node — use the caller-hoisted value if given (the 2D draw passes one
    // read once per render, not per frame); else read live (cached-texture path).
    const accent = accentOverride || ((typeof document !== "undefined"
      ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
      : "") || "#d97757");
    ctx.beginPath(); ctx.arc(50, 96, 6.4, 0, 2 * Math.PI); ctx.fillStyle = accent; ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function coreLogoTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return _coreTex;
  const mode = document.documentElement.dataset.themeMode || "dark";
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const key = mode + "|" + accent;
  if (_coreTex && _coreTexKey === key) return _coreTex;
  const c = document.createElement("canvas"); c.width = 256; c.height = 256;
  const ctx = c.getContext("2d"); if (!ctx) return _coreTex;
  ctx.save(); ctx.translate(128, 128); ctx.scale(2.3, 2.3); ctx.translate(-50, -50); // centre the 100×100 mark
  drawCoreMark(ctx, accent);
  ctx.restore();
  _coreTex?.dispose?.();
  _coreTex = new THREE.CanvasTexture(c); _coreTex.needsUpdate = true;
  _coreTexKey = key;
  return _coreTex;
}

// `layers` mirrors the Explorer's three tiers (BrainExplorerPanel TIER_LAYERS). Both surfaces read
// the SAME `lens` off brain-store, so a lens the graph does not know falls through to LENSES[0] =
// "All" and dims nothing — the list filters and the canvas silently does not. That was already
// true of 8 of the 14 chips before the Explorer was re-tiered; adding the tier lenses here is what
// keeps the two halves saying the same thing.
type Lens = { id: string; label: string; icon: React.ComponentType<{ className?: string }>; kinds: Set<string> | null; layers?: Set<string>; tags?: string[]; group?: string };
const VAULT_LAYERS = new Set(["vault", "folder", "core", "product"]);
const LENSES: Lens[] = [
  { id: "all", label: "All", icon: Layers, kinds: null },
  { id: "notes", label: "Notes", icon: FileText, kinds: new Set(["note", "card"]), layers: VAULT_LAYERS },
  { id: "sessions", label: "Sessions", icon: FileText, kinds: null, layers: VAULT_LAYERS },
  { id: "tags", label: "Tags", icon: Hash, kinds: null },
  // Brain nodes — everything the extractor derived.
  { id: "brain-all", label: "Brain", icon: Layers, kinds: null, layers: new Set(["construction"]) },
  { id: "entities", label: "Entities", icon: Layers, kinds: null, layers: new Set(["construction"]) },
  { id: "brain-tags", label: "Tags", icon: Hash, kinds: null, layers: new Set(["construction"]) },
  // Work — the operator's committed structure. A LENS under Memory files, not a tier: authored
  // structure sits on the authored side of the one line the tiers actually draw.
  { id: "work", label: "Work", icon: FolderKanban, kinds: new Set(["card", "kr", "move", "track", "goal"]), layers: VAULT_LAYERS },
];
const PROJ_HUES = ["bg-violet-500", "bg-sky-500", "bg-amber-500", "bg-emerald-500"];

// Stable signature of the graph (node ids + links) — lets a live refresh skip re-rendering when the
// data is unchanged, so the force layout only moves when something was actually added/removed/relinked.
// Order-insensitive SUM of per-entry FNV hashes: the old form sorted every id and link key into two
// giant strings, an O(N log N) main-thread stall paid on EVERY window focus (the fetch fires on
// focus/visibility even when nothing changed). Summing 32-bit hashes into two lanes is order-free,
// allocation-free, and collision-safe enough for a "did my own vault change" check.
// _graphSig now lives in @/duin/lib/graph-signature as a pure, TESTED function. It was
// wrong three times in a row while it sat inline here, where no test could reach it.
const _graphSig = graphSignature

export function BrainMap({
  onAsk, onChat, onOpenView, chromeless = false,
}: {
  onAsk: (text: string) => void;
  onChat: (prefill: string) => void;
  onOpenView: (v: View) => void;
  chromeless?: boolean; // hide DUIN's own lens bar + file rail (rebuilt lamprey-native); keep graph + omnibox
}) {
  const [data, setData] = useState<BrainGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  // Lens is shared state — the native Brain Explorer panel drives it too.
  const lensId = useBrainStore((s) => s.lens);
  const setLensId = useBrainStore((s) => s.setLens);
  const focusToken = useBrainStore((s) => s.focusToken);
  const [areas, setAreas] = useState<{ name: string; tags: string[] }[]>([]); // saved multi-tag lenses (Areas), persisted
  const [areaEdit, setAreaEdit] = useState<{ name: string; tags: string[] } | null>(null);
  const [tagQuery, setTagQuery] = useState(""); // filter box for the (large) Tags rail
  useEffect(() => { try { const s = localStorage.getItem("brainAreas"); if (s) setAreas(JSON.parse(s)); } catch { /* ignore */ } }, []);
  const saveAreas = (next: { name: string; tags: string[] }[]) => { setAreas(next); try { localStorage.setItem("brainAreas", JSON.stringify(next)); } catch { /* ignore */ } };
  // Topic SPACES — the user's real arenas (top-level domain folders), discovered by
  // the engine (/state/spaces) with a cross-type rollup. Each is a one-click lens
  // that focuses the graph on that arena's notes (by folder group).
  const [spaces, setSpaces] = useState<Space[]>([]);
  useEffect(() => {
    const c = new AbortController();
    fetchSpaces(c.signal).then(setSpaces).catch(() => { /* brain offline → no spaces */ });
    return () => c.abort();
  }, [data]); // re-pull when the graph (vault) changes
  const [navOpen, setNavOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [omni, setOmni] = useState("");
  const [node, setNode] = useState<BrainNode | null>(null); // the picked context (chip on the omnibox)
  const [detailOpen, setDetailOpen] = useState(false);      // generous detail slide-over (project/note only)
  const [eventPrep, setEventPrep] = useState<EventPrep | null>(null); // prep list for a selected event milestone
  const wrapRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  // Pin the canvas holder to the WINDOW's origin: translate away the wrapper's own
  // viewport offset, so the canvas coordinate space never moves when the panels
  // around it do. Imperative DOM write, no React state — it runs per-frame while a
  // side panel is dragged (see the geometry comment on the effect below).
  const pinHolder = useCallback(() => {
    const h = holderRef.current, el = wrapRef.current;
    if (!h || !el) return;
    const r = el.getBoundingClientRect();
    h.style.transform = `translate(${-Math.round(r.left)}px, ${-Math.round(r.top)}px)`;
  }, []);
  // The wrapper's ResizeObserver can't pin a holder that mounts AFTER it last fired
  // (graph data arriving, the 2D↔3D switch swapping holders) — so pin on attach too.
  const holderMountRef = useCallback((el: HTMLDivElement | null) => {
    holderRef.current = el;
    if (el) pinHolder();
  }, [pinHolder]);
  const fgRef = useRef<any>(null);
  // ── Framing: show the WHOLE brain, and come back to it when left alone ──────────
  // The graph opened at whatever zoom the simulation happened to settle on, which on a
  // large vault is deep inside the cloud — you land on a handful of nodes with no idea
  // the rest exists. zoomToFit frames every node instead.
  const didInitialFitRef = useRef(false);
  const idleFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const IDLE_REFIT_MS = 60_000;

  /** Frame the whole graph. Safe on both 2D and 3D — both expose zoomToFit. */
  const fitGraph = useCallback((durationMs = 600) => {
    const fg = fgRef.current;
    if (!fg || typeof fg.zoomToFit !== "function") return;
    try {
      // 60px padding so edge labels are not clipped against the canvas border.
      fg.zoomToFit(durationMs, 60);
    } catch {
      /* the graph can unmount mid-animation; framing is never worth throwing over */
    }
  }, []);

  /** Any deliberate interaction resets the idle clock. Re-framing under someone's
   *  hands would yank the view away mid-inspection, which is worse than not doing it. */
  const markGraphInteraction = useCallback(() => {
    if (idleFitTimerRef.current) clearTimeout(idleFitTimerRef.current);
    idleFitTimerRef.current = setTimeout(() => fitGraph(900), IDLE_REFIT_MS);
  }, [fitGraph]);

  useEffect(() => {
    return () => {
      if (idleFitTimerRef.current) clearTimeout(idleFitTimerRef.current);
    };
  }, []);
  const omniRef = useRef<HTMLTextAreaElement>(null);
  // ── viewport culling (2D) ───────────────────────────────────────────────────────────────
  // force-graph repaints EVERY node and link on every redraw — it has no frustum culling of
  // its own (canvas-force-graph paints the full arrays), so at typical zoom levels most of
  // the per-frame work was off-screen. The current world-space view rect is derived from
  // d3-zoom's transform (onZoom) and consulted first thing in the node painters; links
  // trivial-reject when both endpoints sit beyond the same padded edge. The pad covers a
  // node disc plus one label's screen extent so nothing pops at the viewport edge. A null
  // rect (before the first zoom event) means "draw everything" — cull off, never wrong.
  const viewRectRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const zoomTransformRef = useRef<{ k: number; x: number; y: number } | null>(null);
  const frameNowRef = useRef(typeof performance !== "undefined" ? performance.now() : 0);
  // Zoom-revealed labels drawn per frame are capped: past the 1.4× reveal threshold with most
  // of the graph still in view, an uncapped pass issues one fillText PER DRAWN NODE — the
  // single most expensive frame component. Anchors and the selection never count against it.
  const labelBudgetRef = useRef(250);
  const dimRef = useRef({ w: 0, h: 0 });
  const updateViewRect = useCallback((t: { k: number; x: number; y: number } | null) => {
    if (!t || !t.k) { viewRectRef.current = null; return; }
    zoomTransformRef.current = t;
    const pad = 14 + 160 / t.k;
    viewRectRef.current = {
      x0: (0 - t.x) / t.k - pad,
      y0: (0 - t.y) / t.k - pad,
      x1: (dimRef.current.w - t.x) / t.k + pad,
      y1: (dimRef.current.h - t.y) / t.k + pad,
    };
  }, []);
  // No auto fit-to-screen (2D or 3D) — the graph always keeps the user's current camera. Click-to-focus still works.
  const sigRef = useRef("");                              // last-applied graph signature (skip no-op refreshes)
  const prevNodes = useRef<Map<string, any>>(new Map());  // id -> live node, carries force-sim x/y so refresh doesn't jump
  const listSig = useRef({ p: "", t: "", s: "" });        // skip no-op list updates (avoid re-render churn)
  const [dim, setDim] = useState(() => ({ w: window.innerWidth, h: window.innerHeight })); // canvas = window size; the wrapper only clips (see the geometry effect below)
  dimRef.current = dim; // the view-rect math reads the canvas size without re-subscribing
  // 3D brain toggle — default OFF, but the user's choice persists (like Lite/Labels).
  // FORCE_3D_WITHDRAWN — the 2D/3D control was removed from the Display menu on the
  // operator's call (2026-08-26): 3D is laggy on a graph this dense, and they want to
  // revisit it themselves rather than have it half-fixed underneath them.
  //
  // Pinned to false rather than deleted, deliberately. Every 3D branch below — the
  // ForceGraph3D holder, the SpriteText labels, the billboard textures, the
  // worker-suppression rule that exists BECAUSE 3D evolves its own third dimension —
  // stays compiled and reachable, so returning to it is restoring one control rather
  // than reconstructing a view. Deleting them would make "I will work on it in the
  // future" mean rewriting it.
  //
  // A previously-stored `brain3d: "1"` is deliberately IGNORED rather than migrated: an
  // operator who left it on last session would otherwise land in the laggy view with no
  // control to leave it by. The key is left in localStorage untouched, so flipping this
  // back to the stored read restores their choice exactly.
  const is3d = false;
  // Tier 3: the 2D map renders on cosmos.gl (GPU points/links — no per-element canvas
  // replay, no practical node ceiling) by default. `localStorage.brainRenderer=legacy`
  // is the operator escape hatch back to the canvas renderer, and a WebGL/device init
  // failure at runtime flips the same switch automatically for the session.
  const [use2dGpu, setUse2dGpu] = useState(() => { try { return localStorage.getItem("brainRenderer") !== "legacy"; } catch { return true; } });
  const cosmosRef = useRef<CosmosBrainCanvasHandle>(null);
  // How many ticks the ON-SCREEN engine may run after a graphData change.
  //
  // force-graph's update() hard-codes `.alpha(1)` and restarts the countdown on EVERY graphData
  // change (canvas-force-graph.js:498), so a brain that gained fourteen nodes re-settled all six
  // thousand — four seconds at 8.5fps, on every window focus. cooldownTicks is the only lever
  // that gates it (triggerUpdate:false, so writing it never itself causes a restart). 0 means the
  // engine stops before its first tick: nodes render exactly where the layout worker put them.
  // It is raised deliberately — for a node drag, or a force-slider change — and for the whole
  // session if the worker is unavailable.
  const [simTicks, setSimTicks] = useState(0);
  // Neighborhood focus (anti-hairball): a node + its direct neighbors stay lit;
  // everything else dims. Hover PREVIEWS a neighborhood; a single click LOCKS one
  // so you can study it hands-free. Hover wins while active; releasing returns to
  // the lock. Clicking empty space clears the lock. Null/null = full graph.
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [lockId, setLockId] = useState<string | null>(null);
  // Recency fade: when on, nodes fade by file age (newest full → old dim) so
  // "what's alive now" reads at a glance. Uses node.mtime; persisted like the rest.
  const [showRecent, setShowRecent] = useState(() => { try { return localStorage.getItem("brainRecent") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("brainRecent", showRecent ? "1" : "0"); } catch { /* ignore */ } }, [showRecent]);
  // Escape hatch for the level-of-detail cull below. The cull removes the majority of the
  // graph on a large vault (measured: 7,487 nodes → 2,408 drawn) and until now said nothing,
  // so "where did my notes go?" had no answer and no remedy in the UI. Off by default — the
  // cull exists because the full graph is genuinely slow — but the operator can see the
  // numbers and overrule them.
  const [lodOverride, setLodOverride] = useState(() => { try { return localStorage.getItem("brainLodOff") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("brainLodOff", lodOverride ? "1" : "0"); } catch { /* ignore */ } }, [lodOverride]);
  // "Brain nodes" toggle — show/hide DERIVED nodes (people, orgs, topics, roadmap/OKR structure — no
  // .md to open). Default ON (full graph); OFF leaves only MEMORY nodes (file-backed vault docs).
  // Persisted like the other display toggles.
  const [showBrain, setShowBrain] = useState(() => { try { return localStorage.getItem("brainShowDerived") !== "0"; } catch { return true; } });
  const toggleBrain = (): void => setShowBrain((v) => { const nv = !v; try { localStorage.setItem("brainShowDerived", nv ? "1" : "0"); } catch { /* ignore */ } return nv; });
  // All the graph display toggles live behind ONE "Display" button (a popover) so
  // the graph surface stays clean instead of showing 5 chips + a legend row.
  const [displayOpen, setDisplayOpen] = useState(false);
  // Escape closes the Display popover (outside-click already does via its backdrop).
  useEffect(() => {
    if (!displayOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDisplayOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayOpen]);
  const filesRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [ingest, setIngest] = useState<"idle" | "running" | "done">("idle");

  // Active lens — built-in (kind-based) or a dynamic tag lens ("tag:<tag>"), which slices the brain by
  // a #tag (this is how Areas / Audits work without new note types).
  const lens: Lens = (() => {
    if (lensId.startsWith("tag:")) { const t = lensId.slice(4); return { id: lensId, label: `#${t}`, icon: Hash, kinds: null, tags: [t] }; }
    if (lensId.startsWith("area:")) { const a = areas.find((x) => `area:${x.name}` === lensId); if (a) return { id: lensId, label: a.name, icon: Bookmark, kinds: null, tags: a.tags }; }
    if (lensId.startsWith("space:")) { const nm = lensId.slice("space:".length); return { id: lensId, label: nm, icon: Layers, kinds: null, group: nm }; }
    return LENSES.find((l) => l.id === lensId) ?? LENSES[0];
  })();
  const showFiles = lensId === "all" || lensId === "notes";
  const showProjects = lensId === "projects";
  const showEvents = lensId === "events";
  const showGoals = lensId === "goals";
  const goalList = ((data?.nodes ?? []) as any[]).filter((n) => n.kind === "goal"); // strategic goals + OKR objectives
  const krList = ((data?.nodes ?? []) as any[]).filter((n) => n.kind === "kr");      // key results (nested under objectives)
  const showTags = lensId === "tags" || lensId.startsWith("tag:"); // Tags lens → rail lists tags (folder-style)
  // is this node inside the active lens? tag lens → matches by tag; built-in → by kind (null = everything).
  const inLens = (n: any): boolean => {
    // Layer first, so a tier lens dims the canvas to the same set the Explorer lists.
    if (lens.layers && !lens.layers.has(String(n.layer ?? "vault"))) return false;
    if (lens.group) {
      return n.group === lens.group || (typeof n.id === "string" && n.id.split(/[\\/]/)[0] === lens.group);
    }
    if (lens.tags) return Array.isArray(n.tags) && n.tags.some((t: string) => lens.tags!.includes(t));
    return !lens.kinds || lens.kinds.has(n.kind);
  };
  // every tag across the brain (noise-filtered, by frequency) → the Tags rail; the top slice feeds the Area editor.
  const allTags = useMemo(() => {
    const count: Record<string, number> = {};
    for (const n of (data?.nodes ?? [])) for (const t of ((n as any).tags ?? [])) count[t] = (count[t] || 0) + 1;
    const NOISE = new Set(["tag", "context-tag", "example", "xxx", "todo", "-", "name", "slug", "foo", "bar", "baz",
      "path", "null", "undefined", "daily-note", "原始转录"]);
    const junk = (t: string) =>
      !t || t.length > 32 ||
      /^\d+$/.test(t) ||                 // pure numbers
      /^[0-9a-f]{6}$/.test(t) ||         // hex colors (#ffd800)
      /[{}<>]/.test(t) ||                // template placeholders {date} <slug>
      /^\d{4}([-/]|$)/.test(t) ||        // date/week tokens 2026-w23, 2026/q2/…
      /^yyyy|^mm-dd|www$/.test(t) ||     // YYYY-MM-DD / YYYY-Www template literals
      NOISE.has(t);
    return Object.entries(count)
      .filter(([t, c]) => c >= 1 && !junk(t))
      .sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ t, c }));
  }, [data]);
  const tagLenses = useMemo(() => allTags.slice(0, 20).map((x) => x.t), [allTags]); // Area-editor building blocks
  // milestones for the Events rail — roadmap order (by date), carrying date + prep count.
  const eventList = useMemo(() => ((data?.nodes ?? []) as any[]).filter((n) => ROADMAP_KINDS.has(n.kind))
    .sort((a, b) => String(a.date || "zzzz").localeCompare(String(b.date || "zzzz"))), [data]);
  // selecting an event milestone → fetch its prep (bound tasks from the full corpus + feeding moves).
  useEffect(() => {
    if (!node || !ROADMAP_KINDS.has(node.kind)) { setEventPrep(null); return; }
    const c = new AbortController();
    fetchEventPrep(node.id, c.signal).then(setEventPrep).catch(() => {});
    return () => c.abort();
  }, [node?.id, node?.kind]);

  useEffect(() => {
    setOverrides(getGraphColors());
    let alive = true;
    // Live sync — the GRAPH (which owns the camera) only refreshes when you return to the tab, never on a
    // background timer, so it can't yank/refit the 3D view mid-look. Only swaps when the node/link set
    // actually changed (positions preserved in the memo). The lists have no camera, so they poll quietly.
    // Show the REAL graph — the only graph there is. The bundled demo brain
    // ("Maya Chen" vault + "Alex Rivera" renderer fallback) was removed 2026-08-22
    // on operator order (and per DUIN-COLD-START-REBUILD-SPEC P0-B "kill the
    // fiction"): an empty vault now renders an honestly empty canvas, and an
    // unreachable brain shows the error state below — never fictional nodes
    // presented as operator state. Signature check preserves the force layout
    // across unchanged refreshes.
    const applyReal = (g: BrainGraph) => {
      setErr(null);
      const sig = _graphSig(g);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setData(g);
        useBrainStore.getState().setData(g as any);
      }
    };
    let lastGraphLoad = 0; // wall-clock of the last fetch, for the focus soft-guard below
    const loadGraph = async () => {
      try {
        lastGraphLoad = Date.now();
        const g = await fetchBrainGraph();
        if (!alive) return;
        applyReal(g);
      } catch {
        // Brain unreachable (server still booting / offline). Show the honest
        // error state — the refresh interval below keeps retrying, and
        // BrainStatusPanel carries the health detail. Never overwrite a real
        // graph that already loaded.
        if (alive && !sigRef.current) setErr("unreachable");
      }
    };
    const loadLists = () => {
      fetchProjects().then((p) => { if (alive) { const j = JSON.stringify(p); if (j !== listSig.current.p) { listSig.current.p = j; setProjects(p); } } }).catch(() => {});
      fetchTracks().then((t) => { if (alive) { const j = JSON.stringify(t); if (j !== listSig.current.t) { listSig.current.t = j; setTracks(t); } } }).catch(() => {});
      fetchFutures().then((r) => { if (alive) { const j = JSON.stringify(r.streams); if (j !== listSig.current.s) { listSig.current.s = j; setStreams(r.streams); } } }).catch(() => {});
    };
    // Focus/visibility refreshes are SOFT: every alt-tab back into the app used to pay a
    // full graph fetch + 1.5MB JSON.parse + signature pass even when nothing changed. A
    // 15s floor keeps the window snappy to return to; `brain:updated` (a real change
    // signal) still refreshes immediately via the hard loadGraph below.
    const loadGraphSoft = () => { if (Date.now() - lastGraphLoad >= 15_000) loadGraph(); };
    loadGraph(); loadLists();
    // Skip the 3-call poll while the window is hidden; the focus + brain:updated
    // refreshes below cover foregrounding, so nothing goes stale.
    // 30s, not 8s: /debug/stalls (first day of the stall instrument, 2026-08-21)
    // showed http:/state/futures blocking main >100ms on EVERY poll — a steady
    // all-day drip. Projects/tracks/futures are day-grained; brain:updated still
    // refreshes immediately on real change, so the poll is only a drift net.
    const iv = setInterval(() => { if (document.visibilityState === "visible") loadLists(); }, 30_000);
    const onVis = () => { if (document.visibilityState === "visible") { loadGraphSoft(); loadLists(); } };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", loadGraphSoft);
    // Refresh when the brain is rebuilt ("Build my brain", reindex, extraction) so the
    // constructed graph appears immediately — not only on refocus. The _graphSig check
    // preserves the camera/positions when the node/link set is unchanged.
    const offUpdated = (window as any).api?.brain?.onUpdated?.(() => { loadGraph(); loadLists(); });
    return () => { alive = false; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", loadGraphSoft); if (typeof offUpdated === "function") offUpdated(); };
  }, []);
  // A canvas resize moves the view rect's far edge; the zoom transform itself is unchanged.
  useEffect(() => { updateViewRect(zoomTransformRef.current); }, [dim, updateViewRect]);
  // Graph canvas geometry. The canvas is sized to the WINDOW and pinned to the window's
  // origin — the holder div translates by minus the wrapper's viewport offset (pinHolder),
  // and the wrapper, the flex remainder between the side panels, merely CLIPS it
  // (overflow-hidden). That one invariant is what makes panel drags read right:
  //
  // 1. A side-panel (or shell-nav) drag never resizes or moves the canvas — it only
  //    changes how much of an already-painted, window-sized field the wrapper reveals,
  //    so BOTH panels slide OVER a stationary graph. When the canvas was sized to the
  //    wrapper instead, a right-panel drag exposed the wrapper's black background
  //    wherever the stale-sized canvas ended (the "blackout" band), and a left drag
  //    moved the canvas origin — the whole graph translated with the sidebar, then
  //    rebuilt on release. A drag now costs one transform write per frame and no
  //    canvas work at all (a 2k-node canvas rebuild per drag frame was the old freeze).
  // 2. setDim still COALESCES to one write per frame and SKIPS no-op sizes — it
  //    re-renders the force graph, and a window resize/maximize fires many times per
  //    gesture. And the effect must NOT depend on `data` (it once did: observer
  //    teardown/re-create churn on a hot path, missing resizes landing in the gap).
  //
  // The wrapper's ResizeObserver only re-pins the holder — a cheap transform write.
  // It runs post-layout pre-paint, so the compensation lands in the same frame as the
  // panel's width change (no drag jitter). Holders that mount later (graph data
  // arriving, the 2D↔3D switch) are pinned by holderMountRef, since the RO won't fire.
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    let raf: number | null = null;
    let lastW = -1, lastH = -1;
    const measure = () => {
      raf = null;
      const w = window.innerWidth, h = window.innerHeight;
      if (w <= 0 || (w === lastW && h === lastH)) return;
      lastW = w; lastH = h;
      setDim({ w, h });
      pinHolder();
    };
    const onResize = () => { if (raf == null) raf = requestAnimationFrame(measure); };
    window.addEventListener("resize", onResize);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pinHolder);
    ro?.observe(el);
    return () => { window.removeEventListener("resize", onResize); ro?.disconnect(); if (raf != null) cancelAnimationFrame(raf); };
  }, [pinHolder]);

  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as any[], links: [] as any[] };
    const deg: Record<string, number> = {};
    for (const l of data.links) { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1; }
    // CORE pinned at centre; everything else (incl. people, who are now merged into their connected
    // vault notes) uses default forces and settles by its real wikilink connections.
    const prev = prevNodes.current;
    let nodes = data.nodes.map((n) => {
      const p = prev.get(n.id); // carry the live force-sim position so an unchanged node doesn't jump on refresh
      return { ...n, deg: deg[n.id] || 0,
        ...(p ? { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz } : {}),
        ...(n.id === data.core ? { fx: 0, fy: 0 } : {}) };
    });
    // A node with no carried position is NEW. d3 would place it on a phyllotaxis spiral around
    // the origin — invisible back when a full four-second settle dragged it home, very visible
    // now that the settle is gone. Seed it on the centroid of its already-placed neighbours so
    // it appears where it belongs immediately; the layout worker refines it a moment later.
    const placedAt = (n: any): { x: number; y: number } | null =>
      typeof n.x === "number" ? { x: n.x, y: n.y }
        : typeof n.fx === "number" ? { x: n.fx, y: n.fy ?? 0 }
        : null;
    const fresh = nodes.filter((n: any) => placedAt(n) == null);
    if (fresh.length) {
      const placed = new Map<string, { x: number; y: number }>();
      for (const n of nodes as any[]) { const p = placedAt(n); if (p) placed.set(n.id, p); }
      if (placed.size) {
        const adj = new Map<string, string[]>();
        const push = (a: string, b: string): void => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
        for (const l of data.links) { push(l.source, l.target); push(l.target, l.source); }
        for (const n of fresh as any[]) {
          let sx = 0, sy = 0, c = 0;
          for (const nb of (adj.get(n.id) ?? [])) {
            const p = placed.get(nb);
            if (p) { sx += p.x; sy += p.y; if (++c >= 8) break; }
          }
          if (c > 0) {
            // Deterministic jitter so siblings sharing one neighbour don't stack exactly.
            const h = hashId(n.id);
            n.x = sx / c + ((h % 41) - 20);
            n.y = sy / c + (((h >> 6) % 41) - 20);
          }
        }
      }
    }
    let links = data.links.map((l) => ({ ...l }));
    // "Brain nodes" toggle OFF → keep only MEMORY (file-backed) nodes + the CORE (so the graph still
    // centers), and drop any link touching a hidden node. Additive + reversible; default ON is the full graph.
    if (!showBrain) {
      const keep = new Set(nodes.filter((n: any) => isMemoryNode(n) || n.id === data.core).map((n: any) => n.id));
      nodes = nodes.filter((n: any) => keep.has(n.id));
      links = links.filter((l: any) => keep.has(l.source) && keep.has(l.target));
    }
    prevNodes.current = new Map(nodes.map((n: any) => [n.id, n])); // force-graph mutates these with x/y each tick
    return { nodes, links };
  }, [data, showBrain]);

  // Graph always renders in the lightweight "Lite" profile: no link particles, fewer label
  // sprites, lower sphere detail, faster settle. (The Lite/Full performance toggle was removed.)
  const lite = true;
  // ── level-of-detail ─────────────────────────────────────────────────────────────────────
  // Lite already cut particles, sprites and sphere resolution, and it is NOT enough: in three.js
  // every node is a Mesh and every link a Line, so the frame cost is a DRAW-CALL count, not a
  // pixel count. Measured 2026-08-03 on the live install (6,163 nodes / 16,927 links ≈ 23k draw
  // calls): 3D fell to 15 fps (median 67ms, p90 83ms). WebGL is comfortable around 1–3k draw calls.
  //
  // That measurement was taken on a SETTLED graph, and concluded "2D is fine". Re-measured
  // 2026-08-03 with the force simulation actually running: 2D holds 60fps at rest but drops to
  // 8.5 fps (mean 118ms/frame, p90 167ms) for the whole four-second settle, and ~55% of that is
  // d3-force's charge/quadtree — not painting. So the cull is worth far more than the draw calls
  // it saves: culling the DATA (not just its visibility) is what shrinks the simulation. On the
  // live brain it takes 6,226 → 2,689 nodes and 17,217 → 5,433 links, halving the tick cost from
  // 67ms to 32ms.
  //
  // It culls the two highest-count, lowest-signal link families and the degree-0/1 leaves, only
  // above a threshold, and never structure the operator navigates by (core, hubs, roadmap kinds).
  const LOD_NODE_FLOOR = 2500; // below this the graph is comfortable; leave it whole
  // `mentions` (7.6k) + `synonym` (3.9k) are ~54% of all edges and are the least informative
  // at overview zoom — synonym edges in particular are the entity auto-merge's bookkeeping.
  const LOD_BULK_LINKS = useMemo(() => new Set(["mentions", "synonym"]), []);
  const [showLabels, setShowLabels] = useState(true); // node-title labels on/off (clean view)
  // Color nodes by DETECTED CLUSTER (graph-insight community detection) instead of
  // by folder. Off by default (folder coloring unchanged). Map fetched lazily on
  // first enable via brain:graphCommunities; falls back to folder colors on error.
  const [colorByCommunity, setColorByCommunity] = useState(() => { try { return localStorage.getItem("brainClusters") === "1"; } catch { return false; } });
  // Full per-node community assignments ({id, community, label, color}) — drives
  // BOTH cluster coloring and the click-to-filter legend below.
  const [communityRows, setCommunityRows] = useState<{ id: string; community: number; label: string; color: string }[]>([]);
  // clusterFilter: when set, the graph is FILTERED down to just that community.
  const [clusterFilter, setClusterFilter] = useState<number | null>(null);
  useEffect(() => {
    // Only fetch once the brain graph is actually loaded. On a cold launch with
    // Clusters persisted ON, the toggle used to fire before the brain index was
    // ready → the IPC returned empty → the effect never retried (it only re-ran on
    // toggle), so Clusters silently failed until toggled off/on. Gating on `data`
    // and storing only NON-empty rows makes it retry on the next graph refresh.
    if (!colorByCommunity || communityRows.length || !data) return;
    let alive = true;
    void (async () => {
      try {
        const r = await window.api?.brain?.graphCommunities?.();
        const rows = r?.success ? (r.data as { id: string; community: number; label: string; color: string }[]) : [];
        if (alive && Array.isArray(rows) && rows.length) setCommunityRows(rows);
      } catch {
        /* transient (brain not ready yet) — retry on the next data change */
      }
    })();
    return () => {
      alive = false;
    };
  }, [colorByCommunity, communityRows, data]);
  // Turning Clusters off drops any active isolation so the full graph returns.
  useEffect(() => { if (!colorByCommunity) setClusterFilter(null); }, [colorByCommunity]);
  const communityColors = useMemo(() => { const m: Record<string, string> = {}; for (const r of communityRows) m[r.id] = r.color; return m; }, [communityRows]);
  const communityOf = useMemo(() => new Map(communityRows.map((r) => [r.id, r.community])), [communityRows]);
  // Named clusters for the legend/filter: group by community, drop isolated
  // (community < 0) and singletons, biggest first.
  const clusterList = useMemo(() => {
    const g = new Map<number, { community: number; label: string; color: string; size: number }>();
    for (const r of communityRows) {
      if (r.community < 0) continue;
      const e = g.get(r.community);
      if (e) e.size++; else g.set(r.community, { community: r.community, label: r.label, color: r.color, size: 1 });
    }
    return [...g.values()].filter((c) => c.size >= 2).sort((a, b) => b.size - a.size);
  }, [communityRows]);
  // The graph actually rendered: filtered to one cluster when clusterFilter is set.
  const displayGraph = useMemo(() => {
    if (clusterFilter == null) return graphData;
    const keep = new Set(graphData.nodes.filter((n: any) => communityOf.get(n.id) === clusterFilter).map((n: any) => n.id));
    return {
      nodes: graphData.nodes.filter((n: any) => keep.has(n.id)),
      links: graphData.links.filter((l: any) => { const s = l.source?.id ?? l.source; const t = l.target?.id ?? l.target; return keep.has(s) && keep.has(t); })
    };
  }, [graphData, clusterFilter, communityOf]);
  // The graph actually SIMULATED and drawn: `displayGraph` with the level-of-detail cull
  // applied above LOD_NODE_FLOOR. Deliberately independent of hover/focus/lens — those
  // change many times a second, and making the node set depend on them would rebuild the
  // simulation on every mouse move. What survives here is stable structure.
  const lodActive = displayGraph.nodes.length > LOD_NODE_FLOOR && !lodOverride;
  const lodGraph = useMemo(() => {
    if (!lodActive) return displayGraph;
    // The cull itself is pure graph maths and lives in graph-lod.ts (with tests). Only the
    // domain judgement — which link families are bulk, what counts as structure worth keeping
    // however sparsely linked — belongs here.
    return cullForLod(displayGraph.nodes as any[], displayGraph.links as any[], {
      bulkLinkTypes: LOD_BULK_LINKS,
      isRoleKept: (n: any) => isCornerstone(n) || ROADMAP_KINDS.has(n.kind),
    });
  }, [displayGraph, lodActive, LOD_BULK_LINKS]);
  // Structural identity of what is being laid out. Node ids + link count is enough to tell
  // "the brain changed" from "React re-rendered", and it is what gates the layout worker.
  const lodSig = useMemo(
    () => `${lodGraph.nodes.length}:${lodGraph.links.length}:${lodGraph.nodes.map((n: any) => n.id).join("")}`,
    [lodGraph]
  );
  useEffect(() => { try { const s = localStorage.getItem("brainLabels"); if (s != null) setShowLabels(s === "1"); } catch { /* ignore */ } }, []);
  const toggleLabels = () => setShowLabels((v) => { const nv = !v; try { localStorage.setItem("brainLabels", nv ? "1" : "0"); } catch { /* ignore */ } return nv; });
  // The `brain3d` write is GONE while the control is withdrawn (FORCE_3D_WITHDRAWN).
  // With `is3d` pinned false it would have written "0" on every mount and quietly
  // destroyed a stored "1" — erasing the operator's own choice on the way to restoring
  // it, which is the opposite of leaving the key untouched. Restore this line together
  // with the control and the stored read.
  // Persist the Clusters choice (match Lite/Labels) — write on any change.
  useEffect(() => { try { localStorage.setItem("brainClusters", colorByCommunity ? "1" : "0"); } catch { /* ignore */ } }, [colorByCommunity]);

  // 3D labels: every node label (the core anchor aside) appears at the SAME camera
  // distance ("zoom in to read"), mirroring the 2D scale gate — so no labels render
  // from farther than others. Per-frame distance cull against the live camera.
  useEffect(() => {
    if (!is3d) return;
    const LABEL_DIST = 150; // world-units; tune for how close you must be before note labels appear
    let raf = 0;
    let lastX = NaN, lastY = NaN, lastZ = NaN, lastRun = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const fg = fgRef.current;
      if (!fg || typeof fg.camera !== "function") return;
      const cam = fg.camera();
      if (!cam?.position) return;
      const { x: cx, y: cy, z: cz } = cam.position;
      // Don't recompute distances at 60Hz over every node. When the camera is
      // static, refresh at ~4Hz (enough to catch a settling layout at near-zero
      // idle cost); while it's moving, throttle to ~15Hz (imperceptible for
      // label pop-in).
      const moved = cx !== lastX || cy !== lastY || cz !== lastZ;
      if (moved ? t - lastRun < 66 : t - lastRun < 250) return;
      lastRun = t; lastX = cx; lastY = cy; lastZ = cz;
      for (const n of graphData.nodes as any[]) {
        const s = n.__label;
        if (!s) continue;
        if (!showLabels) { s.visible = false; continue; } // labels toggled off → hide every label
        if (isAnchorLabel(n)) { s.visible = true; continue; } // top-level folder anchors stay on (the region legend)
        // Everything else reveals only when the camera is close, so nothing else
        // labels from afar (uniform proximity pop-in).
        const dx = (n.x || 0) - cx, dy = (n.y || 0) - cy, dz = (n.z || 0) - cz;
        s.visible = dx * dx + dy * dy + dz * dz < LABEL_DIST * LABEL_DIST;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [is3d, graphData, lite, showLabels]);

  // Active kind→color map, driven by the persisted Brain graph scheme. Falls
  // back to the default palette for unknown / unset ids — so the graph recolors
  // live the moment the user picks a scheme in Settings → Appearance, and the
  // out-of-box look stays identical to before (default scheme === KIND_COLOR).
  const schemeId = useSettingsStore((s) => s.settings.brainGraphScheme);
  const kindColor = useMemo(() => getSchemeColors(schemeId), [schemeId]);
  // Persisted Recall-style force + depth controls (settings.brainGraphLayout),
  // read/written exactly like brainGraphScheme above. `layoutDraft` is what the layout
  // WORKER previews: a slider in hand feeds it once per animation frame (LayoutSlider owns
  // the in-hand value and the readout, so the thumb never waits on this component's
  // render), and the persisted value is committed on release (pointer-up / key-up /
  // stepper click).
  //
  // NB: the reheat is driven by the DRAFT, not the committed value. Each draft change is a
  // parameter update on the worker's run in flight (useGraphLayout → "params"), not a fresh
  // serialisation of the graph — that per-pixel re-post was what made the sliders stutter
  // and the graph jump while dragging.
  const persistedLayout = useSettingsStore((s) => s.settings.brainGraphLayout);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const layout = persistedLayout ?? DEFAULT_GRAPH_LAYOUT;
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState<GraphLayout>(layout);
  useEffect(() => { if (persistedLayout) setLayoutDraft(persistedLayout); }, [persistedLayout]);
  const commitLayout = (next: GraphLayout) => { setLayoutDraft(next); void updateSettings({ brainGraphLayout: next }); };
  const layoutDraftRef = useRef(layoutDraft); layoutDraftRef.current = layoutDraft;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  // One axis at a time, from LayoutSlider. `liveAxis` is the per-frame preview; `commitAxis`
  // is the release, and it writes settings only when the axis actually moved — a keyboard
  // release on an untouched slider costs nothing.
  const liveAxis = useCallback((key: ForceAxis, v: number) => setLayoutDraft((d) => (d[key] === v ? d : { ...d, [key]: v })), []);
  const commitAxis = useCallback((key: ForceAxis, v: number) => {
    const next = { ...layoutDraftRef.current, [key]: v };
    setLayoutDraft(next);
    if (layoutRef.current[key] !== v) void updateSettings({ brainGraphLayout: next });
  }, [updateSettings]);
  // The active scheme's FOLDER palette — colors the bulk of the graph (vault notes
  // are colored by folder, not by kind), so switching schemes recolors everything.
  const schemePalette = useMemo(() => getSchemePalette(schemeId), [schemeId]);
  // The graph paints onto a transparent canvas over --app-bg; every hue below is
  // tuned for the dark field, so on the light theme they wash out. Subscribe to
  // the mode (re-renders on toggle) and darken hues / flip neutrals when light.
  const isLight = useSettingsStore((s) => s.settings.themeMode) === "light";
  // Read the accent ONCE per render (not per frame): the 2D core draw runs every
  // frame and reading --accent there forces a style recalc each time. Stable
  // during pan/zoom (no re-render); refreshed on the next render after a theme change.
  const coreAccent = (typeof document !== "undefined"
    ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
    : "") || "#d97757";

  const colorOf = (n: any): string => {
    let c: string;
    if (n.kind === "core") c = kindColor.core;
    else if (colorByCommunity && communityColors[n.id]) c = communityColors[n.id]; // color by detected cluster
    else if (ROADMAP_KINDS.has(n.kind) && n.passed) c = "#7a6a2f"; // passed milestone → faded gold (auto-fade)
    else if (n.kind === "person" || n.kind === "org") c = kindColor[n.kind]; // distinct even though they're vault notes
    else if (n.layer === "product") c = kindColor[n.kind] || "#94a3b8";
    else c = resolveColor(n.group || "", overrides, schemePalette);
    return isLight ? forLight(c) : c;
  };

  // Precompute each node's base color ONCE per data/theme/scheme change and stamp
  // it on the node. react-force-graph runs a continuous rAF draw loop, so the 2D
  // nodeCanvasObject (per node) and the link-color accessors (per link) fire every
  // frame; reading n.__color instead of calling colorOf()/the per-char folder hash
  // there removes the dominant per-frame cost at 1000+ nodes.
  useMemo(() => {
    for (const n of graphData.nodes as any[]) {
      n.__color = colorOf(n);
    }
    // colorOf closes over these; listing the primitives keeps the stamp fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, isLight, schemePalette, overrides, colorByCommunity, communityColors, kindColor]);

  // colour each link by its higher-priority endpoint (used by both 2D + 3D)
  const nodesById = useMemo(() => new Map(graphData.nodes.map((n: any) => [n.id, n])), [graphData]);
  const linkColorByPrio = (l: any): string => {
    const a = l.source && typeof l.source === "object" ? l.source : nodesById.get(l.source);
    const b = l.target && typeof l.target === "object" ? l.target : nodesById.get(l.target);
    const hi = prio(a) >= prio(b) ? a : b;
    // Links are SUBTLE structure — the graph should read as colorful NODES joined
    // by faint connections, not a colorful web. Keep only a whisper of the node's
    // hue at very low alpha (was 0.5 → far too vivid); fire links fainter still.
    // Light mode needs a darker neutral and a higher alpha floor — the dark-field
    // whisper alphas (0.05/0.11) are invisible over near-white paper.
    if (!hi)
      return isLight
        ? (FIRE.has(l.type) ? "rgba(90,100,120,0.14)" : "rgba(90,100,120,0.24)")
        : (FIRE.has(l.type) ? "rgba(140,150,170,0.05)" : "rgba(140,150,170,0.11)");
    const linkA = isLight ? (FIRE.has(l.type) ? 0.14 : 0.26) : (FIRE.has(l.type) ? 0.05 : 0.11);
    return withAlpha(hi.__color || colorOf(hi) || (isLight ? "#0f766e" : "#5eead4"), linkA);
  };
  // Links get their color STAMPED once per data/theme change, like nodes above. The accessor
  // used to run per link per painted frame — a regex + rgba string build ×~16k links, 60×/s —
  // and, worse, every call built a fresh string so force-graph's stroke batching (it groups
  // consecutive strokes by exact color value) never coalesced. Stamped values come from a
  // small palette of identical strings, so thousands of strokes collapse into a few batches.
  // Depends on the same inputs as the node stamp and must run after it (source order does).
  useMemo(() => {
    for (const l of graphData.links as any[]) l.__color = linkColorByPrio(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, isLight, schemePalette, overrides, colorByCommunity, communityColors, kindColor]);
  // ── cosmos (GPU 2D) glue ────────────────────────────────────────────────────────────────
  // The GPU renderer consumes typed arrays, so it needs a tick when the STAMPED colors (or
  // the recency fade) change — the stamps above mutate in place and change no identity.
  const paletteCounter = useRef(0);
  const paletteVersion = useMemo(
    () => ++paletteCounter.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphData, isLight, schemePalette, overrides, colorByCommunity, communityColors, kindColor, showRecent]
  );
  const showRecentRef = useRef(showRecent);
  showRecentRef.current = showRecent;
  // Stable adapter object — cosmos re-reads through refs, so hover/toggle churn never
  // rebuilds its arrays. Size/label formulas mirror the canvas painter exactly.
  const cosmosAdapters = useMemo(() => ({
    sizeFor: (n: any): number =>
      n.kind === "core" ? 11 : n.kind === "folder" ? 3.5 : n.layer === "product" ? 2.4 + Math.sqrt(n.deg || 0) * 0.7 : 1.1 + Math.sqrt(n.deg || 0) * 0.35,
    labelFor: (n: any): string => {
      const lbl = ROADMAP_KINDS.has(n.kind)
        ? `${n.label}${n.date ? " · " + n.date : ""}${n.prep ? " · " + n.prep + "▸" : ""}`
        : String(n.label || n.id);
      return lbl.length > 30 ? lbl.slice(0, 28) + "…" : lbl;
    },
    isAnchor: (n: any): boolean => isAnchorLabel(n),
    alphaFor: (n: any): number => (showRecentRef.current && n.mtime ? recencyMul(n.mtime, Date.now()) : 1),
  }), []);
  // The core's canvas-drawn mark, rendered once to a data URL for the DOM sprite.
  const coreMarkUrl = useMemo(() => {
    try {
      const c = document.createElement("canvas"); c.width = 128; c.height = 128;
      const ctx = c.getContext("2d"); if (!ctx) return null;
      ctx.scale(1.28, 1.28);
      drawCoreMark(ctx, coreAccent);
      return c.toDataURL("image/png");
    } catch { return null; }
  }, [coreAccent]);

  const tree = useMemo(() => {
    if (!data) return [] as { folder: string; notes: { id: string; label: string }[] }[];
    const m: Record<string, { id: string; label: string }[]> = {};
    for (const n of data.nodes) { if (n.layer !== "vault") continue; (m[n.group || "(root)"] ||= []).push({ id: n.id, label: n.label }); }
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([folder, notes]) => ({ folder, notes: notes.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [data]);

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  // Adjacency (id → set of directly-linked ids), built from the RAW links before
  // the force layout mutates source/target into node refs. Drives neighborhood focus.
  const neighborMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string): void => { let s = m.get(a); if (!s) { s = new Set(); m.set(a, s); } s.add(b); };
    for (const l of (data?.links ?? [])) {
      const s = l.source && typeof l.source === "object" ? (l.source as any).id : (l.source as any);
      const t = l.target && typeof l.target === "object" ? (l.target as any).id : (l.target as any);
      if (s && t) { add(s, t); add(t, s); }
    }
    return m;
  }, [data]);
  // The active focus anchor: a live hover previews (wins), else the locked node.
  const focusId = hoverId ?? lockId;
  // Connection depth (Recall) — how many hops out from the anchor stay lit. depth 1
  // reproduces the original 1-hop neighborhood (anchor + direct neighbors); each further
  // hop expands the frontier through a BUDGET of each node's most specific neighbours
  // (focusNeighbourhood, graph-lod.ts) — so every step lights more, and none floods
  // through a hub. No reheat — this only dims/undims, it never moves a node.
  const focusDepth = Math.max(1, layout.connectionDepth || 2);
  const focusSet = useMemo(() => {
    if (focusId == null) return null;
    return focusNeighbourhood(focusId, neighborMap, { depth: focusDepth, maxLit: 400 });
  }, [focusId, neighborMap, focusDepth]);
  // The GPU renderer can't paint per-node dimming the way nodeCanvasObject does, so its
  // one greyout facility gets the COMBINED lit set: a node stays lit only if it passes
  // the active nav LENS (tag/kind/space slice — the canvas dims non-members) AND, when a
  // hover/lock focus is active, sits inside the N-hop neighborhood. Null = nothing dims.
  const lensRestricts = !!(lens.layers || lens.group || lens.tags || lens.kinds);
  const litSet = useMemo(() => {
    if (focusSet == null && !lensRestricts) return null;
    const s = new Set<string>();
    for (const n of graphData.nodes as any[]) {
      const lensOk = !lensRestricts || n.kind === "core" || inLens(n);
      const focusOk = focusSet == null || focusSet.has(n.id);
      if (lensOk && focusOk) s.add(n.id);
    }
    return s;
    // inLens closes over `lens`, itself derived from lensId + areas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSet, graphData, lensId, areas, lensRestricts]);
  // A node is "in focus" when there's no anchor, or it's within the N-hop set.
  // A link is in focus when BOTH its endpoints are in the set (the neighborhood's
  // own edges), which at depth 1 keeps the anchor's incident links lit.
  const inFocus = (id: string): boolean => focusSet == null || focusSet.has(id);
  const linkIncidentToFocus = (l: any): boolean => {
    if (focusSet == null) return true;
    const s = l.source && typeof l.source === "object" ? l.source.id : l.source;
    const t = l.target && typeof l.target === "object" ? l.target.id : l.target;
    return focusSet.has(s) && focusSet.has(t);
  };
  // The level-of-detail cull used to run here, as per-object visibility predicates in 3D only.
  // It now happens in `lodGraph` above, on the DATA, for both views — which additionally takes
  // the culled objects out of the force simulation instead of merely hiding them.
  const linkColorFocused = (l: any): string => {
    if (focusId == null) return l.__color || linkColorByPrio(l); // stamped above; compute only for a link born between stamps
    if (!linkIncidentToFocus(l)) return isLight ? "rgba(80,90,110,0.1)" : "rgba(120,130,150,0.03)"; // non-neighborhood: nearly gone
    return isLight ? "rgba(13,110,102,0.6)" : "rgba(94,234,212,0.5)"; // the focused node's own links pop
  };
  function nodeForProject(name: string): BrainNode {
    return (data?.nodes ?? []).find((n) => n.kind === "project" && (n.label === name || n.id === name)) ?? { id: name, kind: "project", label: name, layer: "product", declared: 1 };
  }
  function nodeForTrack(t: Track): BrainNode {
    return (data?.nodes ?? []).find((n) => n.kind === "track" && n.label === t.label) ?? { id: t.id, kind: "track", label: t.label, layer: "product", declared: 1 };
  }
  const selProject = node?.kind === "project" ? (projects.find((p) => p.name === node.label || p.name === node.id) ?? { name: node.label, desc: "", tracks: tracks.filter((t) => t.project === node.label).length }) : null;

  function focusNode(id: string) {
    if (!is3d && use2dGpu) { cosmosRef.current?.focusNode(id); return; }
    const gn = graphData.nodes.find((n: any) => n.id === id);
    if (!gn || !fgRef.current || typeof gn.x !== "number") return;
    if (typeof fgRef.current.centerAt === "function") { fgRef.current.centerAt(gn.x, gn.y, 600); fgRef.current.zoom(2.6, 600); }
    else if (typeof fgRef.current.cameraPosition === "function") { const r = Math.hypot(gn.x, gn.y, gn.z || 0) || 1; const k = 1 + 160 / r; fgRef.current.cameraPosition({ x: gn.x * k, y: gn.y * k, z: (gn.z || 0) * k }, gn, 800); }
  }
  // The native Brain Explorer (right panel) focuses a node by bumping focusToken.
  useEffect(() => { const id = useBrainStore.getState().focusId; if (id) focusNode(id); }, [focusToken]);
  // ── the layout, off the main thread ─────────────────────────────────────────────────────
  // d3-force costs ~67ms/tick on the live brain and react-force-graph ticks it inside the
  // animation frame, so the settle and the painting compete for the same thread. The worker
  // runs the identical force config and streams positions back; the on-screen engine then
  // renders them with simTicks=0 and never blocks. If the worker can't start we restore the
  // original behaviour (settle on the main thread) rather than shipping a frozen layout.
  const layoutState = useGraphLayout({
    nodes: lodGraph.nodes,
    links: lodGraph.links,
    signature: lodSig,
    charge: rampFrom50(layoutDraft.nodeSpacing, -8, -30, -400),
    linkDistance: rampFrom50(layoutDraft.linkLength, 10, 30, 120),
    linkStrength: layoutDraft.linkForce === 50 ? -1 : 0.05 + (Math.max(0, Math.min(100, layoutDraft.linkForce)) / 100) * 0.95,
    centerStrength: rampFrom50(layoutDraft.centerForce, 0.05, 0.5, 1),
    velocityDecay: 0.3,
    // THE WORKER IS 2D. graph-layout.worker.ts runs plain d3-force and returns an [x,y] pair per
    // node — there is no `z` anywhere in it. react-force-graph-3d runs d3-force-3d, where `z` is a
    // real dimension the on-screen engine evolves. So in 3D the worker must not run at all: its
    // snapshots would write x/y and leave z untouched at its seed, collapsing the whole graph onto
    // a plane. (That is exactly what happened when the "one settler at a time" rule was first
    // added and applied unconditionally — 3D rendered flat.)
    enabled: !!data && !is3d,
  });
  /** True when the worker is both available AND applicable — i.e. it owns the settle and the
   *  on-screen engine must stay parked. In 3D it never owns it, because it cannot compute z. */
  const workerOwnsLayout = layoutState.available && !is3d;
  useEffect(() => {
    if (!workerOwnsLayout) setSimTicks(lite ? 60 : 200);
  }, [workerOwnsLayout, lite]);
  // Dragging a node is the one interaction that WANTS live physics — the neighbourhood should
  // give way as you pull. force-graph calls resetCountdown() itself while dragging (without
  // re-heating alpha), so the engine ticks as long as we allow it a budget. The guard keeps this
  // to one state write per drag rather than one per pointer event.
  const draggingRef = useRef(false);
  const dragIdleRef = useRef<number | null>(null);
  const onNodeDragTick = useCallback(() => {
    if (draggingRef.current) return;
    draggingRef.current = true;
    if (dragIdleRef.current != null) { window.clearTimeout(dragIdleRef.current); dragIdleRef.current = null; }
    setSimTicks((t) => (t > 0 ? t : 120));
  }, []);
  const onNodeDragDone = useCallback(() => {
    draggingRef.current = false;
    if (!workerOwnsLayout) return; // no worker (or 3D) → the on-screen engine stays in charge
    // Let the release settle briefly, then hand the layout back to the worker.
    if (dragIdleRef.current != null) window.clearTimeout(dragIdleRef.current);
    dragIdleRef.current = window.setTimeout(() => setSimTicks(0), 1500);
  }, [workerOwnsLayout]);
  useEffect(() => () => { if (dragIdleRef.current != null) window.clearTimeout(dragIdleRef.current); }, []);

  // ── keeping hit-testing alive while the engine is parked ────────────────────────────────
  // force-graph hit-tests by reading one pixel out of an off-screen SHADOW canvas, and it only
  // repaints that canvas inside the redraw loop (force-graph.js:647, `doRedraw && refresh...`),
  // throttled to 800ms. With the simulation parked, the redraw loop stops the moment a camera
  // move ends — which can leave the shadow canvas painted at the PREVIOUS transform, so nodes
  // silently stop being hoverable, clickable and draggable after a zoom.
  //
  // So the redraw loop is held open for a beat after anything that moves the picture. That is
  // long enough to outlast the 800ms throttle and guarantee one shadow repaint at the final
  // transform, and it lets the hub pulse animate during interaction — then it parks again and
  // costs nothing.
  const [liveRedraw, setLiveRedraw] = useState(true);
  const redrawIdleRef = useRef<number | null>(null);
  const nudgeRedraw = useCallback(() => {
    setLiveRedraw(true);
    if (redrawIdleRef.current != null) window.clearTimeout(redrawIdleRef.current);
    redrawIdleRef.current = window.setTimeout(() => setLiveRedraw(false), 1400);
  }, []);
  useEffect(() => () => { if (redrawIdleRef.current != null) window.clearTimeout(redrawIdleRef.current); }, []);
  // Park the render loop entirely while the window is hidden: even fully idle, force-graph's
  // rAF loop scans every link for photons and reads the hover pixel 60×/s. Hidden, that buys
  // nothing; resume re-nudges so the first visible frame repaints both canvases fresh.
  useEffect(() => {
    const onVis = () => {
      const fg = fgRef.current;
      if (!fg) return;
      if (document.visibilityState === "hidden") fg.pauseAnimation?.();
      else { fg.resumeAnimation?.(); nudgeRedraw(); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [nudgeRedraw]);
  // A structural change swaps the node/link arrays — the shadow canvas has to follow.
  useEffect(() => { nudgeRedraw(); }, [lodGraph, nudgeRedraw]);
  // The settle's LAST positions need one shadow repaint too, or hover/click targets stay
  // where the graph was mid-flight. Edge-triggered on computing→false, NOT per snapshot.
  const prevComputingRef = useRef(false);
  useEffect(() => {
    if (prevComputingRef.current && !layoutState.computing) nudgeRedraw();
    prevComputingRef.current = layoutState.computing;
  }, [layoutState.computing, nudgeRedraw]);
  // THE REFRESH STORM FIX. Worker positions are written straight into the live node objects,
  // and this identity must NOT change per snapshot. It used to (`[lodGraph, layoutState.version]`),
  // which made every 120ms snapshot hand force-graph a "new" graphData → a full update() on BOTH
  // canvases (hexIndex rescan, d3-force re-init over all nodes+links, colorTracker re-register)
  // ~8×/sec — while the per-version nudgeRedraw above held autoPauseRedraw off, so the loop also
  // painted full O(N+E) frames at 60fps for the whole ~10s settle, redrawing IDENTICAL positions
  // 7 of every 8 frames. What a snapshot actually needs is ONE repaint: the setVersion bump
  // re-renders this component, react-kapsule re-applies the inline accessor props, and their
  // onChange marks needsRedraw — exactly one painted frame per snapshot, no rebind, no re-init.
  const renderGraph = useMemo(
    () => ({ nodes: lodGraph.nodes, links: lodGraph.links }),
    [lodGraph]
  );

  // Degree counts for the adaptive link strength, computed ONCE per graph. This used to be
  // rebuilt inside the slider effect, so a single drag across a 100-step range rebuilt a
  // 17,000-entry Map a hundred times over.
  const linkDegree = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const l of (lodGraph.links as any[])) {
      const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
      cnt.set(s, (cnt.get(s) || 0) + 1); cnt.set(t, (cnt.get(t) || 0) + 1);
    }
    return cnt;
  }, [lodGraph]);

  // Recall-style FORCE controls → live d3-force simulation, updated in REAL TIME as the
  // slider drags. 50 == the shipped default (charge -30, link distance 30, link strength
  // 1/min(deg)). CENTER strength is capped at 1.0: d3's forceCenter OVERSHOOTS and blows the
  // graph apart above 1, so the ramp tops out there (0.05 spread .. 0.5 default .. 1.0 tight).
  //
  // Setting force parameters is cheap; RE-SETTLING on them is not. This effect therefore only
  // writes the parameters — the reheat is debounced separately below. It used to do both, on
  // the draft value, so every pixel of slider travel kicked off a full four-second settle.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || typeof fg.d3Force !== "function") return;
    const charge = fg.d3Force("charge");
    if (charge?.strength) charge.strength(rampFrom50(layoutDraft.nodeSpacing, -8, -30, -400));
    const link = fg.d3Force("link");
    if (link?.distance) link.distance(rampFrom50(layoutDraft.linkLength, 10, 30, 120));
    if (link?.strength) {
      if (layoutDraft.linkForce === 50) {
        // Reproduce d3's adaptive default EXACTLY: strength = 1/min(deg(a),deg(b)).
        link.strength((l: any) => {
          const s = l.source?.id ?? l.source, t = l.target?.id ?? l.target;
          return 1 / Math.min(linkDegree.get(s) || 1, linkDegree.get(t) || 1);
        });
      } else {
        link.strength(0.05 + (Math.max(0, Math.min(100, layoutDraft.linkForce)) / 100) * 0.95); // 0.05..1
      }
    }
    const centerStrength = rampFrom50(layoutDraft.centerForce, 0.05, 0.5, 1);
    const center = fg.d3Force("center");
    if (center?.strength) center.strength(centerStrength);
    // forceCenter only TRANSLATES the system so its centroid sits at the origin — it applies
    // no per-node attraction, so it cannot pull an outlier in no matter how high it goes. A
    // node the charge force pushed away (a degree-0 node especially, which the LOD cull can
    // create by removing all of its neighbours) had nothing acting on it in the inward
    // direction at all. forceX/forceY supply that, off the same slider, so "Center force"
    // does what its label says. Installed here rather than at graph construction because
    // react-force-graph builds the simulation itself; d3Force(name, force) is the seam.
    const positional = positionalStrength(centerStrength);
    const fx = fg.d3Force("x");
    if (fx?.strength) fx.strength(positional);
    else fg.d3Force("x", forceX(0).strength(positional));
    const fy = fg.d3Force("y");
    if (fy?.strength) fy.strength(positional);
    else fg.d3Force("y", forceY(0).strength(positional));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutDraft.nodeSpacing, layoutDraft.linkLength, layoutDraft.linkForce, layoutDraft.centerForce, is3d, lodGraph, linkDegree]);

  // The reheat, debounced. A deliberate force change SHOULD re-settle the graph — but once,
  // after the operator stops moving the slider, not on every input event. connectionDepth is
  // absent because depth only dims and undims; it never moves a node.
  const forceAxes = `${layoutDraft.nodeSpacing}:${layoutDraft.linkLength}:${layoutDraft.linkForce}:${layoutDraft.centerForce}`;
  const firstForceApply = useRef(true);
  useEffect(() => {
    // Don't reheat on mount — the initial layout is the layout worker's job.
    if (firstForceApply.current) { firstForceApply.current = false; return; }
    // ONE SETTLER AT A TIME. When the worker is available it already owns this: useGraphLayout
    // re-posts on every force-parameter change and streams position snapshots that the renderer
    // applies at 60fps with simTicks=0 — that IS the animated re-settle. Reheating the on-screen
    // engine as well put two simulations on the same node objects: every worker snapshot
    // hard-wrote x/y and zeroed velocity underneath the running main-thread sim, which then
    // drifted away again until the next snapshot. The graph visibly jumped once per snapshot —
    // several times per slider adjustment — before finally settling on the worker's answer.
    if (workerOwnsLayout) return;
    const id = window.setTimeout(() => {
      const fg = fgRef.current;
      if (fg && typeof fg.d3ReheatSimulation === "function") {
        // No worker: the main thread is the only engine there is, so it does the settle.
        setSimTicks(lite ? 60 : 200);
        fg.d3ReheatSimulation();
      }
    }, 180);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceAxes, workerOwnsLayout]);
  // pick = set context (omnibox chip) + open the detail. In chromeless mode the
  // detail renders NATIVELY in lamprey's Brain Explorer (via the store), not
  // DUIN's Sheet slide-over.
  function pickNode(n: BrainNode) {
    setNode(n); focusNode(n.id);
    if (chromeless) {
      const store = useBrainStore.getState();
      store.setDetail(n as any);
      store.setChatContext({ id: n.id, label: n.label, kind: n.kind }); // scope the chat to this node
      useUiStore.getState().setActiveTool("brain"); // surface the native detail in the Explorer panel
    } else setDetailOpen(true);
  }
  // A `page` node is a built HTML surface — open its RAW html in the artifact
  // workbench (render/edit) rather than the note detail. Falls back to the detail
  // view if the file can't be read.
  async function openPageInWorkbench(n: BrainNode) {
    try {
      const r = await window.api?.artifact?.readVaultFile?.(n.id);
      const raw = r && (r as { success: boolean; data?: string }).success ? (r as { data?: string }).data : null;
      const opener = (window as unknown as { __openArtifact?: (t: string, s: string) => void }).__openArtifact;
      if (raw && typeof opener === "function") { opener("html", raw); return; }
    } catch { /* fall through to detail */ }
    pickNode(n);
  }
  // Graph clicks: single = simple SELECT (set as chat context chip, no sidebar) · double = OPEN (focus + sidebar).
  const clickRef = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  function handleNodeClick(n: any) {
    if (n.kind === "core") return;
    const now = Date.now();
    const dbl = clickRef.current.id === n.id && now - clickRef.current.t < 320;
    if (dbl) {
      // double → OPEN the detail. Route through pickNode so the DEPLOYED (chromeless)
      // app surfaces it NATIVELY in lamprey's Brain Explorer right-panel (store.setDetail
      // + setActiveTool — pops in like the rest of the lamprey UI); only the standalone
      // (non-chromeless) build falls back to DUIN's Sheet slide-over.
      clickRef.current = { id: "", t: 0 };
      if (n.kind === "page") { void openPageInWorkbench(n); return; }
      pickNode(n);
    } else {
      // single → SELECT for context (the chat's "asking in context" chip) + jump
      // camera + LOCK its neighborhood so you can study its connections hands-free.
      setNode(n);
      focusNode(n.id);
      setLockId(n.id);
      useBrainStore.getState().setChatContext({ id: n.id, label: n.label, kind: n.kind });
      clickRef.current = { id: n.id, t: now };
    }
  }
  void pickNode; // retained for the Explorer focus path; node clicks use the single/double split above
  function growOmni() { const ta = omniRef.current; if (!ta) return; ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; }
  function askOmni() {
    const v = omni.trim(); if (!v) return;
    // The "About the …" context prefix is applied centrally in
    // chat-store.sendMessage (reads brain-store.chatContext, pinned per
    // conversation). Send RAW text — prefixing here too would double it.
    onAsk(v); setOmni("");
    if (omniRef.current) omniRef.current.style.height = "auto";
  }
  const hasDetail = !!node;
  const selTrack = node?.kind === "track" ? (tracks.find((t) => t.label === node.label) ?? null) : null;
  const selStream = node?.kind === "move" ? (streams.find((s) => s.title === node.label || s.id === node.id) ?? null) : null;

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const names: string[] = [];
    for (const f of Array.from(files)) { try { const r = await uploadToRaw(f); names.push(r.stored); } catch { /* skip */ } }
    setUploaded((u) => [...u, ...names]); setUploading(false);
  }
  async function runIngest() {
    setIngest("running");
    try {
      await runAgent({ url: AGUI_URL(), threadId: "ingest-raw", runId: crypto.randomUUID(),
        messages: [{ role: "user", content: `Ingest the newly uploaded files now in 00 Raw (${uploaded.join(", ")}). Triage and file them into the vault per the inbox-process / source-ingest workflow.` }], onEvent: () => {} });
      setIngest("done"); setUploaded([]); setTimeout(() => setIngest("idle"), 4000);
    } catch { setIngest("idle"); }
  }

  // "Make this my brain →" — the demo overlay CTA. This IS onboarding step 1
  // (the folder pick): it runs the exact flow OnboardingFlow's step 1 uses —
  // window.api.brain.pickFolder → settings.set({ localBrainNotesDir }) →
  // brain.reindex — over the shared preload API. The reindex broadcasts
  // brain:updated, which our onUpdated listener (in the effect above) turns into
  // a loadGraph; the now-non-empty fetch replaces the demo with the real graph.
  return (
    <div className="relative flex h-full flex-col">
      <input ref={filesRef} type="file" multiple className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />

      {/* lens bar — focuses the brain (the surfaces themselves live in the sidebar) */}
      <div className={`flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2 ${chromeless ? "hidden" : ""}`}>
        {LENSES.map((l) => {
          const on = l.id === lensId;
          return (
            <button key={l.id} onClick={() => setLensId(l.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${on ? "border-brand/50 bg-brand/10 text-[var(--text-primary)]" : "border-border/60 text-[var(--text-secondary)] hover:border-brand/40 hover:text-[var(--text-primary)]"}`}>
              <l.icon className="size-3.5" /> {l.label}
            </button>
          );
        })}
        {/* Saved Areas — named multi-tag lenses you pin (persisted). Click to focus, again to clear; hover for ×. */}
        {areas.length > 0 && <span className="mx-1 h-4 w-px shrink-0 bg-border/60" />}
        {areas.map((a) => {
          const id = `area:${a.name}`; const on = id === lensId;
          return (
            <span key={id} className="group/area inline-flex items-center">
              <button onClick={() => setLensId(on ? "all" : id)} title={`Area — ${a.tags.map((t) => "#" + t).join(" · ")}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[12px] transition ${on ? "border-brand/50 bg-brand/15 text-[var(--text-primary)]" : "border-border/60 text-[var(--text-secondary)] hover:border-brand/40 hover:text-[var(--text-primary)]"}`}>
                <Bookmark className="size-3" />{a.name}
              </button>
              <button onClick={() => saveAreas(areas.filter((x) => x.name !== a.name))} title={t('Remove Area')}
                className="ml-0.5 hidden text-[var(--text-secondary)] hover:text-destructive group-hover/area:inline"><X className="size-3" /></button>
            </span>
          );
        })}
        {/* Topic Spaces — your real arenas (engine-discovered via /state/spaces). One click
            focuses the graph on that arena's notes; the badge is its note count, the tooltip its rollup. */}
        {spaces.length > 0 && <span className="mx-1 h-4 w-px shrink-0 bg-border/60" />}
        {spaces.map((sp) => {
          const id = `space:${sp.name}`; const on = id === lensId;
          return (
            <button key={id} onClick={() => setLensId(on ? "all" : id)}
              title={`${sp.name} — ${sp.notes} notes · ${sp.decisions} decisions · ${sp.people} people`}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[12px] transition ${on ? "border-brand/50 bg-brand/15 text-[var(--text-primary)]" : "border-border/60 text-[var(--text-secondary)] hover:border-brand/40 hover:text-[var(--text-primary)]"}`}>
              <Layers className="size-3" />{sp.name}
              <span className="ml-0.5 rounded-full bg-muted/60 px-1 text-[11px] tabular-nums">{sp.notes}</span>
            </button>
          );
        })}
        {/* Tags now live in the Tags lens's rail (folder-style), not as chips here — keeps the bar clean. */}
        <button onClick={() => setAreaEdit(areaEdit ? null : { name: "", tags: lens.tags ?? [] })} title={t('Save an Area (named multi-tag view)')}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border/60 px-2 py-1 text-[12px] text-[var(--text-secondary)] transition hover:border-brand/40 hover:text-[var(--text-primary)]">
          <Plus className="size-3" /> {t('Area')}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {/* A "✓ in sync" / "syncing" pill used to sit here, fed by
              fetchGraphDiff(). `/state/graph-diff` was the Python sidecar's
              graph.parity_report(); the sidecar was retired in 1ce3c534 and no
              native route replaced it, so the fetch 404'd on every mount and
              the pill has never rendered since. Removed rather than faked: the
              indicator claims store-vs-live parity, and the unified brain has
              no second store to compare against. Reinstating it is a design
              decision (define "store" and "live"), not a missing line. */}
          <button onClick={() => filesRef.current?.click()} disabled={uploading} title={t('Import files into your brain')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition hover:border-brand/40 hover:text-[var(--text-primary)] disabled:opacity-50">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Import
          </button>
          {uploaded.length > 0 && (
            <button onClick={runIngest} disabled={ingest === "running"}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand/40 px-2.5 py-1 text-[12px] text-brand transition hover:bg-brand/10 disabled:opacity-50">
              {ingest === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Ingest {uploaded.length}
            </button>
          )}
        </div>
      </div>

      {/* Active SPACE context — the per-arena "right bar": its rollup + description, shown when a space lens is on. */}
      {lensId.startsWith("space:") && (() => {
        const sp = spaces.find((s) => `space:${s.name}` === lensId);
        if (!sp) return null;
        return (
          <div className="flex items-center gap-2 border-b border-border/60 bg-brand/5 px-3 py-2 text-[12px]">
            <Layers className="size-3.5 shrink-0 text-brand" />
            <span className="shrink-0 font-medium text-[var(--text-primary)]">{sp.name}</span>
            {sp.desc && <span className="truncate text-[var(--text-secondary)]">{sp.desc}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-[var(--text-secondary)]">
              <span>{sp.notes} notes</span>·<span>{sp.decisions} decisions</span>·<span>{sp.people} people</span>
            </span>
          </div>
        );
      })()}

      {/* Area editor — name it + toggle which tags compose it; prefilled with the active tag lens if any. */}
      {areaEdit && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-card/30 px-3 py-2">
          <input autoFocus value={areaEdit.name} onChange={(e) => setAreaEdit({ ...areaEdit, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") setAreaEdit(null); }}
            placeholder={t('Area name (e.g. ProjectA BD)')} className="w-44 rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-brand/40" />
          <span className="text-[11px] text-[var(--text-secondary)]">tags:</span>
          {tagLenses.map((t) => {
            const sel = areaEdit.tags.includes(t);
            return (
              <button key={t} onClick={() => setAreaEdit({ ...areaEdit, tags: sel ? areaEdit.tags.filter((x) => x !== t) : [...areaEdit.tags, t] })}
                className={`inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] transition ${sel ? "border-brand/50 bg-brand/15 text-[var(--text-primary)]" : "border-border/60 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                {sel && <Check className="size-2.5" />}#{t}
              </button>
            );
          })}
          <button disabled={!areaEdit.name.trim() || areaEdit.tags.length === 0}
            onClick={() => { const nm = areaEdit.name.trim(); saveAreas([...areas.filter((x) => x.name !== nm), { name: nm, tags: areaEdit.tags }]); setLensId(`area:${nm}`); setAreaEdit(null); }}
            className="rounded-md bg-brand px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50">{t('Save Area')}</button>
          <button onClick={() => setAreaEdit(null)} className="rounded-md p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* inner-left rail: file tree (All/Notes) or project→tracks tiers (Projects).
            Hidden in chromeless mode — rebuilt as lamprey-native UI. */}
        {chromeless ? null : navOpen ? (
          <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/20">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
              <span className="text-[12px] font-semibold text-[var(--text-secondary)]">{showProjects ? "Projects" : showGoals ? "Goals" : showEvents ? "Events" : showTags ? "Tags" : "Files"}</span>
              <button onClick={() => setNavOpen(false)} title={t('Collapse')} className="rounded p-0.5 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"><PanelLeftClose className="size-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 text-[12px]">
              {showFiles && tree.map(({ folder, notes }) => {
                const open = expanded.has(folder);
                return (
                  <div key={folder}>
                    <button onClick={() => setExpanded((s) => { const n = new Set(s); n.has(folder) ? n.delete(folder) : n.add(folder); return n; })}
                      className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[12px] font-medium transition hover:bg-muted/50">
                      {open ? <ChevronDown className="size-3.5 shrink-0 text-[var(--text-secondary)]" /> : <ChevronRight className="size-3.5 shrink-0 text-[var(--text-secondary)]" />}
                      <Folder className="size-3.5 shrink-0" style={{ color: resolveColor(folder, overrides, schemePalette) }} />
                      <span className="truncate">{folder}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-[11px] text-[var(--text-secondary)]">{notes.length}</span>
                    </button>
                    {open && (
                      <div className="ml-3 border-l border-border/40 pl-1">
                        {notes.map((nt) => {
                          const bn = byId.get(nt.id)!;
                          return (
                            <button key={nt.id} onClick={() => handleNodeClick(bn)} title={nt.label}
                              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px] transition hover:bg-muted/50 ${node?.id === nt.id ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                              <FileText className="size-3 shrink-0 opacity-60" /><span className="truncate">{nt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {showProjects && (
                projects.length === 0 ? <p className="px-2 py-2 text-[12px] text-[var(--text-secondary)]">{t('No projects yet.')}</p> :
                <div className="space-y-2">
                  {projects.map((p, i) => {
                    const pts = tracks.filter((t) => t.project === p.name);
                    return (
                      <div key={p.name}>
                        <button onClick={() => handleNodeClick(nodeForProject(p.name))}
                          className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] font-medium transition hover:bg-muted/50 ${node?.kind === "project" && node.label === p.name ? "bg-muted/60 text-[var(--text-primary)]" : ""}`}>
                          <span className={`size-2 shrink-0 rounded-full ${PROJ_HUES[i % PROJ_HUES.length]}`} />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="shrink-0 tabular-nums text-[11px] text-[var(--text-secondary)]">{pts.length}</span>
                        </button>
                        <div className="ml-[7px] mt-0.5 space-y-0.5 border-l border-border/40 pl-2.5">
                          {pts.map((t) => {
                            const moves = ((t as any).moves ?? []) as { id: string; title: string; status?: string }[];
                            return (
                              <div key={t.id}>
                                <button onClick={() => handleNodeClick(nodeForTrack(t))}
                                  className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px] transition hover:bg-muted/50 ${node?.kind === "track" && node.label === t.label ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                                  <span className={`size-1.5 shrink-0 rounded-full ${t.status === "active" ? "bg-brand" : "bg-muted-foreground/30"}`} />
                                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                                  {t.active_count > 0 && <span className="shrink-0 text-[11px] tabular-nums text-brand/80">{t.active_count}</span>}
                                </button>
                                {moves.length > 0 && (
                                  <div className="ml-2.5 space-y-0.5 border-l border-border/30 pl-2">
                                    {moves.map((m) => (
                                      <button key={m.id} onClick={() => handleNodeClick((byId.get(m.id) || { id: m.id, kind: "move", label: m.title, layer: "product" }) as any)}
                                        title={m.title}
                                        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition hover:bg-muted/40 ${node?.id === m.id ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                                        <span className={`size-1 shrink-0 rounded-full ${m.status === "active" ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
                                        <span className="min-w-0 flex-1 truncate">{m.title}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {pts.length === 0 && <p className="px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">no tracks</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Events rail — the roadmap milestones (date + prep count); click to select + inspect. */}
              {showEvents && (
                eventList.length === 0 ? <p className="px-2 py-2 text-[12px] text-[var(--text-secondary)]">{t('No milestones yet.')}</p> :
                <div className="space-y-0.5">
                  {eventList.map((e: any) => (
                    <button key={e.id} onClick={() => handleNodeClick(e)}
                      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition hover:bg-muted/50 ${node?.id === e.id ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"} ${e.passed ? "opacity-50" : ""}`}>
                      <CalendarClock className="size-3 shrink-0 text-amber-300/80" />
                      <span className="min-w-0 flex-1 truncate">{e.label}</span>
                      {(e.kind === "event" || e.kind === "milestone" || e.kind === "release") && <span className="shrink-0 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{e.kind}</span>}
                      {e.date && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">{e.date}</span>}
                      {e.prep ? <span className="shrink-0 rounded bg-amber-400/15 px-1 text-[11px] tabular-nums text-amber-200">{e.prep}</span> : null}
                    </button>
                  ))}
                </div>
              )}

              {/* Goals rail — strategic goals (GOALS.md) + project OKR objectives with their KRs nested. */}
              {showGoals && (() => {
                const STATE_DOT: Record<string, string> = { on: "bg-emerald-400", risk: "bg-amber-400", blocked: "bg-rose-400", done: "bg-emerald-500", todo: "bg-muted-foreground/30" };
                return goalList.length === 0 ? <p className="px-2 py-2 text-[12px] text-[var(--text-secondary)]">{t('No goals yet.')}</p> : (
                  <div className="space-y-0.5">
                    {goalList.map((g: any) => {
                      const krs = String(g.id).startsWith("okr:") ? krList.filter((k: any) => k.parent === g.id) : [];
                      return (
                        <div key={g.id}>
                          <button onClick={() => handleNodeClick(g)}
                            className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition hover:bg-muted/50 ${node?.id === g.id ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                            <Target className="size-3 shrink-0 text-yellow-300/80" />
                            <span className="min-w-0 flex-1 truncate">{g.label}</span>
                          </button>
                          {krs.length > 0 && (
                            <div className="ml-3 space-y-0.5 border-l border-border/40 pl-1.5">
                              {krs.map((k: any) => (
                                <button key={k.id} onClick={() => handleNodeClick(k)}
                                  className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition hover:bg-muted/40 ${node?.id === k.id ? "bg-muted/60 text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                                  <span className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[k.state] || STATE_DOT.todo}`} title={k.status || k.state} />
                                  <span className="min-w-0 flex-1 truncate">{k.label}</span>
                                  {k.progress && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{String(k.progress).split("（")[0].trim()}</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Tags rail — every #tag (frontmatter + inline), searchable. Click to focus, again to clear. */}
              {showTags && (() => {
                const q = tagQuery.trim().toLowerCase();
                const shown = q ? allTags.filter(({ t }) => t.includes(q)) : allTags.slice(0, 60);
                return (
                  <div>
                    <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder={`Filter ${allTags.length} tags…`}
                      className="mb-1.5 w-full rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-brand/40" />
                    {shown.length === 0 ? <p className="px-2 py-2 text-[12px] text-[var(--text-secondary)]">{t('No matching tags.')}</p> : (
                      <div className="space-y-0.5">
                        {shown.slice(0, 200).map(({ t, c }) => {
                          const id = `tag:${t}`; const on = id === lensId;
                          return (
                            <button key={t} onClick={() => setLensId(on ? "tags" : id)} title={`Focus everything tagged #${t}`}
                              className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition hover:bg-muted/50 ${on ? "bg-amber-400/10 text-amber-200" : "text-[var(--text-secondary)]"}`}>
                              <Hash className="size-3 shrink-0 opacity-70" /><span className="min-w-0 flex-1 truncate">{t}</span>
                              <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{c}</span>
                            </button>
                          );
                        })}
                        {!q && allTags.length > 60 && <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">+{allTags.length - 60} more — search to find them</p>}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <button onClick={() => setNavOpen(true)} title={t('Show list')} className="m-2 flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-lg border border-border/60 bg-card/30 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"><PanelLeftOpen className="size-4" /></button>
        )}

        {/* graph */}
        <div ref={wrapRef} className="relative min-w-0 flex-1 overflow-hidden bg-[var(--app-bg,#07070d)]">
          {/* All display controls consolidated behind ONE "Display" popover so the
              graph surface stays clean (was 5 chips + a floating cluster legend). */}
          {data && !err && (
            <div className="absolute right-3 top-3 z-20">
              <button
                onClick={() => setDisplayOpen((o) => !o)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium backdrop-blur transition ${displayOpen ? "border-[var(--accent)]/40 bg-[var(--accent-dim)] text-[var(--accent)]" : "border-[var(--panel-border)] bg-[var(--panel-bg)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
                title={t('Display options — view, labels, clusters, recency, performance')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                {t('Display')}
              </button>
              {displayOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setDisplayOpen(false)} />
                  <div className="absolute right-0 top-9 z-20 w-64 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)]/95 p-2.5 shadow-xl backdrop-blur">
                    {/* The View 2D/3D segmented pair lived here and is WITHDRAWN on the
                        operator's call (2026-08-26): 3D is laggy on a graph this dense
                        and is theirs to revisit. The rendering path is intact — see
                        FORCE_3D_WITHDRAWN by `is3d` — so restoring the control is
                        putting this block back, not rebuilding the view. */}
                    {/* On/off toggles */}
                    {([
                      { label: "Brain nodes", on: showBrain, set: toggleBrain },
                      { label: "Labels", on: showLabels, set: toggleLabels },
                      { label: "Recency fade", on: showRecent, set: () => setShowRecent((v) => !v) },
                      { label: "Clusters", on: colorByCommunity, set: () => setColorByCommunity((v) => !v) }
                    ]).map((r) => (
                      <button key={r.label} onClick={r.set} className="flex w-full items-center justify-between rounded px-1 py-1 text-[12px] hover:bg-[var(--bg-tertiary)]">
                        <span className="text-[var(--text-secondary)]">{r.label}</span>
                        <span className={`relative h-3.5 w-6 rounded-full transition ${r.on ? "bg-[var(--accent)]" : "bg-[var(--panel-border)]"}`}>
                          <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${r.on ? "left-3" : "left-0.5"}`} />
                        </span>
                      </button>
                    ))}
                    {/* Level-of-detail disclosure. The cull is the single largest thing this
                        view does to the operator's data, and it used to be invisible: on a
                        large vault most of the brain simply was not on screen and nothing
                        said so. State the numbers, and offer the way out. */}
                    {displayGraph.nodes.length > LOD_NODE_FLOOR && (
                      <div className="mt-1 border-t border-[var(--panel-border)] pt-1.5">
                        <button
                          onClick={() => setLodOverride((v) => !v)}
                          className="flex w-full items-center justify-between rounded px-1 py-1 text-[12px] hover:bg-[var(--bg-tertiary)]"
                          title={lodOverride
                            ? "Drawing every node. On a large brain this makes the graph slower to settle and to pan."
                            : "Sparsely-linked nodes are hidden so the graph stays responsive. Turn on to draw all of them."}
                        >
                          <span className="text-[var(--text-secondary)]">{t('Show all nodes')}</span>
                          <span className={`relative h-3.5 w-6 rounded-full transition ${lodOverride ? "bg-[var(--accent)]" : "bg-[var(--panel-border)]"}`}>
                            <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${lodOverride ? "left-3" : "left-0.5"}`} />
                          </span>
                        </button>
                        <div className="px-1 pb-0.5 text-[11px] text-[var(--text-muted)]">
                          {lodActive
                            ? `Showing ${lodGraph.nodes.length.toLocaleString()} of ${displayGraph.nodes.length.toLocaleString()} nodes`
                            : `Showing all ${displayGraph.nodes.length.toLocaleString()} nodes — slower`}
                        </div>
                      </div>
                    )}
                    {/* Cluster legend + filter — folded in under Clusters (was a floating row) */}
                    {colorByCommunity && clusterList.length > 0 && (
                      <div className="mt-1.5 border-t border-[var(--panel-border)] pt-1.5">
                        <div className="mb-1 flex items-center justify-between px-1">
                          <span className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{t('Isolate a cluster')}</span>
                          <button onClick={() => setClusterFilter(null)} className={`text-[11px] ${clusterFilter == null ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>{t('All')}</button>
                        </div>
                        <div className="max-h-40 space-y-0.5 overflow-y-auto">
                          {clusterList.slice(0, 30).map((c) => (
                            <button key={c.community} onClick={() => setClusterFilter((cur) => (cur === c.community ? null : c.community))}
                              className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--bg-tertiary)] ${clusterFilter === c.community ? "bg-[var(--accent-dim)]" : ""}`}>
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                              <span className="min-w-0 flex-1 truncate text-left text-[11px] text-[var(--text-secondary)]">{c.label}</span>
                              <span className="tabular-nums text-[11px] text-[var(--text-muted)]">{c.size}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Layout — Recall-style force + depth controls, ABSORBED into
                        this Display popover (no bolt-on floating panel). Collapsed
                        by default; 50 on every axis == today's look. */}
                    <div className="mt-1.5 border-t border-[var(--panel-border)] pt-1.5">
                      <button onClick={() => setLayoutOpen((o) => !o)}
                        className="flex w-full items-center justify-between rounded px-1 py-1 text-[12px] hover:bg-[var(--bg-tertiary)]">
                        <span className="text-[var(--text-secondary)]">{t('Layout')}</span>
                        <ChevronDown className={`size-3.5 text-[var(--text-muted)] transition ${layoutOpen ? "rotate-180" : ""}`} />
                      </button>
                      {layoutOpen && (
                        <div className="mt-1 space-y-2 px-1">
                          {/* Each axis owns its in-hand value (LayoutSlider): the thumb
                              tracks the pointer, the draft hears once per frame, settings
                              hear on release. */}
                          {([
                            { key: "nodeSpacing", label: t('Node spacing') },
                            { key: "linkLength", label: t('Link length') },
                            { key: "linkForce", label: t('Link force') },
                            { key: "centerForce", label: t('Center force') },
                          ] as const).map((s) => (
                            <LayoutSlider key={s.key} label={s.label} value={layoutDraft[s.key]}
                              onLive={(v) => liveAxis(s.key, v)} onCommit={(v) => commitAxis(s.key, v)} />
                          ))}
                          {/* Connection depth — a 1..5 stepper (N-hop focus). Commits
                              immediately; it never reheats, only widens the focus set. */}
                          <div className="flex items-center justify-between pt-0.5">
                            <span className="text-[11px] text-[var(--text-secondary)]">{t('Connection depth')}</span>
                            <div className="flex items-center gap-1.5">
                              <button aria-label={t('Fewer hops')} disabled={layoutDraft.connectionDepth <= 1}
                                onClick={() => commitLayout({ ...layoutDraft, connectionDepth: Math.max(1, layoutDraft.connectionDepth - 1) })}
                                className="flex size-5 items-center justify-center rounded border border-[var(--panel-border)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:opacity-40">
                                <Minus className="size-3" />
                              </button>
                              <span className="w-4 text-center tabular-nums text-[11px] text-[var(--text-primary)]">{layoutDraft.connectionDepth}</span>
                              <button aria-label={t('More hops')} disabled={layoutDraft.connectionDepth >= 5}
                                onClick={() => commitLayout({ ...layoutDraft, connectionDepth: Math.min(5, layoutDraft.connectionDepth + 1) })}
                                className="flex size-5 items-center justify-center rounded border border-[var(--panel-border)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:opacity-40">
                                <Plus className="size-3" />
                              </button>
                            </div>
                          </div>
                          <button onClick={() => commitLayout(DEFAULT_GRAPH_LAYOUT)}
                            className="w-full rounded px-1 py-1 text-left text-[11px] text-[var(--accent)] transition hover:bg-[var(--accent-dim)]">
                            {t('Reset layout')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {/* Event prep is shown in the standard detail Sheet (NodeDetail), like every other node — no separate popup. */}
          {err ? (
            <p className="p-6 text-[14px] text-[var(--text-secondary)]">Couldn&apos;t load your brain. Is the brain reachable?</p>
          ) : !data ? (
            <p className="flex items-center gap-2 p-6 text-[14px] text-[var(--text-secondary)]"><Loader2 className="size-4 animate-spin" /> Wiring your second brain…</p>
          ) : is3d ? (
            /* Window-sized, window-pinned canvas holder — the wrapper clips it.
               See the geometry comment on the measure effect. */
            <div ref={holderMountRef} className="absolute left-0 top-0" style={{ width: dim.w, height: dim.h }}>
            <ForceGraph3D
              key={(lite ? "fg3d-lite" : "fg3d-full") + "-" + (isLight ? "light" : "dark")}
              ref={fgRef}
              graphData={renderGraph as any}
              width={dim.w}
              height={dim.h}
              backgroundColor="rgba(0,0,0,0)"
              cooldownTicks={simTicks}
              // Same framing contract as the 2D graph: fit the whole brain once the
              // simulation settles, and re-frame after a minute untouched.
              onEngineStop={() => {
                if (!didInitialFitRef.current) {
                  didInitialFitRef.current = true;
                  fitGraph(0);
                }
                markGraphInteraction();
              }}
              onNodeDrag={onNodeDragTick}
              onNodeDragEnd={onNodeDragDone}
              d3VelocityDecay={0.3}
              onNodeClick={handleNodeClick}
              onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
              onBackgroundClick={() => setLockId(null)}
              nodeColor={(n: any) => (focusId != null && !inFocus(n.id) ? (isLight ? "rgba(150,160,175,0.3)" : "rgba(90,100,120,0.22)") : (n.__color || colorOf(n)))}
              nodeRelSize={rampFrom50(layout.nodeSpacing, 1.5, 2.6, 4)}
              nodeVal={(n: any) => (n.kind === "core" ? 9 : n.kind === "folder" ? 3 : n.layer === "product" ? 1.6 + (n.deg || 0) * 0.22 : 0.5 + (n.deg || 0) * 0.12)}
              nodeOpacity={1}
              nodeResolution={lite ? 6 : 10}
              nodeLabel={(n: any) => String(n.label || n.id)}
              nodeThreeObjectExtend={(n: any) => !(n.kind === "core" || (n.kind === "project" && n.logo))}
              nodeThreeObject={(n: any) => {
                // CORE → its mark as a screen-facing billboard sprite (always faces camera, never rotates).
                if (n.kind === "core") {
                  const tex = coreLogoTexture();
                  if (tex) {
                    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.62, depthWrite: false }));
                    sp.scale.set(26, 26, 1);
                    return sp;
                  }
                }
                // Project with an uploaded logo → billboard sprite (aspect-preserved, never rotates).
                if (n.kind === "project" && n.logo) {
                  const im = logoFor(n.logo);
                  if (im) {
                    const tex = new THREE.Texture(im); tex.needsUpdate = true;
                    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 1, depthWrite: false }));
                    const ar = (im.naturalWidth / im.naturalHeight) || 1; const S = 18;
                    sp.scale.set(ar >= 1 ? S : S * ar, ar >= 1 ? S / ar : S, 1);
                    return sp;
                  }
                }
                // label EVERY node; cornerstones stay visible, the rest appear when the camera is close (the cull loop below) — mirrors the 2D rule.
                const hub = isCornerstone(n);
                if (lite && !hub) return null as unknown as THREE.Object3D; // lite: only cornerstone labels — falsy → default node, skips ~1300 sprites
                const s = new SpriteText(ROADMAP_KINDS.has(n.kind) && n.prep ? `${n.label} · ${n.prep}▸` : String(n.label || n.id));
                s.color = isLight ? "rgba(24,26,32,0.95)" : "rgba(228,231,240,0.92)";
                s.textHeight = n.kind === "core" ? 7 : 3.5; // uniform size for every non-core label
                (s as any).position.y = -(n.kind === "core" ? 11 : hub ? 6 : 3.5);
                (s as any).visible = isAnchorLabel(n); // folder anchors start on; the cull loop reveals the rest by camera proximity
                (n as any).__label = s;
                return s;
              }}
              linkColor={linkColorFocused}
              // 0 = GL lines, not tube geometry. three-forcegraph promotes ANY truthy width
              // to a CylinderGeometry MESH per link — at ~16k links that alone was most of
              // the measured ~23k draw calls behind 3D's 15fps floor. Lines carry the same
              // color/opacity treatment at a fraction of the cost; the 0.2/0.6 width split
              // was barely perceptible in 3D anyway.
              linkWidth={0}
              linkOpacity={1}
              linkDirectionalParticles={(l: any) => (lite || FIRE.has(l.type) ? 0 : 2)}
              linkDirectionalParticleWidth={1.5}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleColor={() => (isLight ? "rgba(13,110,102,0.5)" : "rgba(94,234,212,0.4)")}
            />
            </div>
          ) : use2dGpu ? (
            /* Tier 3 default: GPU points/links via cosmos.gl. Same window-pinned holder,
               same worker-fed positions; the legacy canvas renderer stays one flag away
               (localStorage.brainRenderer=legacy) and is the automatic WebGL fallback. */
            <div ref={holderMountRef} className="absolute left-0 top-0" style={{ width: dim.w, height: dim.h }}>
              <CosmosBrainCanvas
                ref={cosmosRef}
                nodes={renderGraph.nodes as any[]}
                links={renderGraph.links as any[]}
                version={layoutState.version}
                paletteVersion={paletteVersion}
                width={dim.w}
                height={dim.h}
                isLight={isLight}
                showLabels={showLabels}
                adapters={cosmosAdapters}
                focusSet={litSet}
                lockId={lockId}
                selectedId={node?.id ?? null}
                coreMarkUrl={coreMarkUrl}
                fireTypes={FIRE}
                onNodeClick={(n) => handleNodeClick(n as any)}
                onNodeHover={(n) => setHoverId((n as any)?.id ?? null)}
                onBackgroundClick={() => setLockId(null)}
                onFallback={() => setUse2dGpu(false)}
              />
            </div>
          ) : (
            <div ref={holderMountRef} className="absolute left-0 top-0" style={{ width: dim.w, height: dim.h }}>
            <ForceGraph2D
              ref={fgRef}
              graphData={renderGraph as any}
              width={dim.w}
              height={dim.h}
              backgroundColor="rgba(0,0,0,0)"
              cooldownTicks={simTicks}
              autoPauseRedraw={!liveRedraw}
              // Frame the whole graph the first time the simulation settles, then leave
              // the view alone until it has been idle for a minute.
              onEngineStop={() => {
                if (!didInitialFitRef.current) {
                  didInitialFitRef.current = true;
                  fitGraph(0);
                }
                markGraphInteraction();
              }}
              onZoom={(t: any) => { updateViewRect(t); nudgeRedraw(); markGraphInteraction(); }}
              onZoomEnd={(t: any) => { updateViewRect(t); nudgeRedraw(); markGraphInteraction(); }}
              // Once per painted frame: hoist the clock the pulse reads (it was a
              // performance.now() PER NODE) and re-arm the zoom-label budget.
              onRenderFramePre={() => {
                frameNowRef.current = typeof performance !== "undefined" ? performance.now() : 0;
                labelBudgetRef.current = 250;
              }}
              // Cull links whose endpoints both sit beyond the same padded viewport edge —
              // such a segment cannot cross the view. Gates the control-point calc and the
              // stroke on BOTH the main and the hit-test canvas.
              linkVisibility={(l: any) => {
                const r = viewRectRef.current; if (!r) return true;
                const s = l.source, t = l.target;
                if (!s || typeof s !== "object" || !t || typeof t !== "object") return true;
                if (s.x < r.x0 && t.x < r.x0) return false;
                if (s.x > r.x1 && t.x > r.x1) return false;
                if (s.y < r.y0 && t.y < r.y0) return false;
                if (s.y > r.y1 && t.y > r.y1) return false;
                return true;
              }}
              // Links are not interactive in this view (no hover/click/label) — skip painting
              // ~16k of them onto the hit-test shadow canvas every refresh cycle.
              linkPointerAreaPaint={() => {}}
              onNodeDrag={onNodeDragTick}
              onNodeDragEnd={onNodeDragDone}
              d3VelocityDecay={0.3}
              onNodeClick={handleNodeClick}
              onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
              onBackgroundClick={() => setLockId(null)}
              linkColor={linkColorFocused}
              linkWidth={(l: any) => (FIRE.has(l.type) ? 0.25 : 0.6)}
              linkDirectionalParticles={(l: any) => (lite || FIRE.has(l.type) || (focusId != null && !linkIncidentToFocus(l)) ? 0 : 2)}
              linkDirectionalParticleWidth={1.5}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleColor={() => (isLight ? "rgba(13,110,102,0.5)" : "rgba(94,234,212,0.4)")}
              nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
                // Viewport cull FIRST — force-graph calls this for every drawn node on every
                // painted frame with no culling of its own; off-screen nodes cost nothing now.
                const vr = viewRectRef.current;
                if (vr && (n.x < vr.x0 || n.x > vr.x1 || n.y < vr.y0 || n.y > vr.y1)) return;
                const t = frameNowRef.current / 1000;
                const isCore = n.kind === "core";
                const isHub = n.kind === "folder" || n.layer === "product";
                // Dim if the lens excludes it OR (a node is focused — hovered or
                // locked — and this one isn't in its neighborhood): anti-hairball focus.
                const dimmed = (!isCore && !inLens(n)) || (focusId != null && !inFocus(n.id));
                // Recency fade: older files draw fainter (0.3 floor); unknown mtime (0)
                // stays full so pre-reindex nodes aren't all hidden.
                const recMul = showRecent && n.mtime ? recencyMul(n.mtime, Date.now()) : 1;
                const base = isCore ? 11 : n.kind === "folder" ? 3.5 : n.layer === "product" ? 2.4 + Math.sqrt(n.deg || 0) * 0.7 : 1.1 + Math.sqrt(n.deg || 0) * 0.35;
                const color = n.__color || colorOf(n);
                const isSel = node?.id === n.id;
                // The CORE mark no longer breathes (operator call, 2026-08-17): its pulse was a
                // scale oscillation, read as a distracting glow on the one node that is always
                // on screen. Hubs keep theirs — those are transient and carry degree information.
                const pulse = isHub ? 0.5 + 0.5 * Math.sin(t * 1.2 + (n.deg || 0)) : 0;
                if (isHub && !dimmed) {
                  ctx.beginPath(); ctx.arc(n.x, n.y, base + 1.5 + pulse * 1.5, 0, 2 * Math.PI);
                  ctx.fillStyle = color; ctx.globalAlpha = (isLight ? 0.06 : 0.10) * (0.5 + pulse * 0.5); ctx.fill(); ctx.globalAlpha = 1;
                }
                if (isCore) {
                  ctx.save(); ctx.translate(n.x, n.y);
                  const s = (base * 2.2) / 100; ctx.scale(s, s); ctx.translate(-50, -50);
                  drawCoreMark(ctx, coreAccent);
                  ctx.restore();
                  return;
                }
                // Project with an uploaded logo → draw it (aspect-preserved) in place of the dot.
                if (n.kind === "project" && n.logo) {
                  const im = logoFor(n.logo);
                  if (im) {
                    const want = base * 5;
                    const ar = (im.naturalWidth / im.naturalHeight) || 1;
                    const w = ar >= 1 ? want : want * ar, h = ar >= 1 ? want / ar : want;
                    ctx.save(); ctx.globalAlpha = (dimmed ? 0.3 : 1) * recMul; ctx.drawImage(im, n.x - w / 2, n.y - h / 2, w, h); ctx.restore();
                    return;
                  }
                }
                ctx.globalAlpha = dimmed ? 0.3 : 1;
                ctx.beginPath(); ctx.arc(n.x, n.y, base, 0, 2 * Math.PI);
                const solid = n.declared !== 0;
                if (solid) { ctx.fillStyle = color; ctx.globalAlpha = (n.layer === "vault" ? 0.95 : 1) * (dimmed ? 0.35 : 1) * recMul; ctx.fill(); ctx.globalAlpha = 1; }
                // Inferred nodes: a semi-solid COLORED disc (was near-black #07070d,
                // which read as invisible on the dark field) so they're legible while
                // still visually lighter than solid/declared nodes.
                else { ctx.fillStyle = color; ctx.globalAlpha = (dimmed ? 0.22 : 0.55) * recMul; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = 0.9; ctx.strokeStyle = color; ctx.globalAlpha = (dimmed ? 0.3 : 0.95) * recMul; ctx.stroke(); ctx.globalAlpha = 1; }
                ctx.lineWidth = 0.3; ctx.strokeStyle = isLight ? "rgba(20,24,32,0.18)" : "rgba(255,255,255,0.16)"; ctx.globalAlpha = dimmed ? 0.15 : 1; ctx.stroke(); ctx.globalAlpha = 1;
                if (isSel) { ctx.lineWidth = 1.2; ctx.strokeStyle = isLight ? "rgba(20,22,28,0.9)" : "rgba(255,255,255,0.95)"; ctx.stroke(); }
                // Focus anchor (hovered or locked) → accent ring so it pops out of its neighborhood.
                if (n.id === focusId) { ctx.lineWidth = 1.4; ctx.strokeStyle = isLight ? "rgba(13,110,102,0.95)" : "rgba(94,234,212,0.95)"; ctx.globalAlpha = 1; ctx.stroke(); }
                // A locked (but not currently hovered) anchor gets a subtle outer halo cue.
                if (n.id === lockId && n.id !== hoverId) { ctx.lineWidth = 0.8; ctx.strokeStyle = isLight ? "rgba(13,110,102,0.6)" : "rgba(94,234,212,0.5)"; ctx.beginPath(); ctx.arc(n.x, n.y, base + 3, 0, 2 * Math.PI); ctx.stroke(); }
                // Always-on labels = CORNERSTONE nodes (structural: core, folders, and
                // the product-layer roadmap) + the selected node. Everything else reveals
                // on zoom (scale > 1.4). Keyed on kind, not degree, so the permanent labels
                // A label appears on zoom (scale > 1.4) or on select. The ONE
                // always-on exception is top-level FOLDER anchors (isAnchorLabel) —
                // the map's stable region legend; never kind/degree/extracted nodes.
                // Zoom-revealed labels draw against a per-frame budget (re-armed in
                // onRenderFramePre): in the band where scale > 1.4 but most of the graph is
                // still in view, an uncapped pass is one fillText per drawn node — the most
                // expensive frame there is. Anchors and the selection are few and always draw.
                const zoomLabel = scale > 1.4 && labelBudgetRef.current > 0;
                const showLabel =
                  showLabels && !dimmed && (isAnchorLabel(n) || isSel || zoomLabel);
                if (showLabel) {
                  if (!(isAnchorLabel(n) || isSel)) labelBudgetRef.current--;
                  // Unified labels: constant on-screen size (~9px) and a constant
                  // gap below each node's edge regardless of node size or zoom, so
                  // every label sits the same visual distance from its node.
                  const fs = 9 / scale;
                  ctx.font = `${fs}px ui-sans-serif, system-ui, sans-serif`;
                  ctx.fillStyle = isLight ? "rgba(24,26,32,0.92)" : "rgba(225,228,240,0.92)"; ctx.textAlign = "center"; ctx.textBaseline = "top";
                  const lbl = ROADMAP_KINDS.has(n.kind)
                    ? `${n.label}${n.date ? " · " + n.date : ""}${n.prep ? " · " + n.prep + "▸" : ""}`
                    : String(n.label || n.id);
                  ctx.fillText(lbl.length > 30 ? lbl.slice(0, 28) + "…" : lbl, n.x, n.y + base + 4 / scale);
                }
              }}
              nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
                const vr = viewRectRef.current; // off-screen nodes need no hit area either
                if (vr && (n.x < vr.x0 || n.x > vr.x1 || n.y < vr.y0 || n.y > vr.y1)) return;
                const base = n.kind === "core" ? 11 : n.kind === "folder" ? 3.5 : n.layer === "product" ? 2.4 + Math.sqrt(n.deg || 0) * 0.7 : 1.1 + Math.sqrt(n.deg || 0) * 0.35;
                ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, base + 2, 0, 2 * Math.PI); ctx.fill();
              }}
            />
            </div>
          )}

        </div>
      </div>

      {/* omnibox — hidden in chromeless mode; lamprey's native ChatInput is wired in its place */}
      {!chromeless && (
      <form onSubmit={(e) => { e.preventDefault(); askOmni(); }}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-5">
        <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-border/70 bg-card/95 p-2 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur transition focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/25">
          {node && (
            <div className="mb-1.5 flex items-center gap-1.5 px-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2 py-0.5 text-[12px] text-[var(--text-primary)]">
                <span className="size-2 rounded-full" style={{ background: km(node.kind).color }} />
                <span className="max-w-[260px] truncate">{node.label}</span>
                <button type="button" onClick={() => setNode(null)} title={t('Clear context')} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><X className="size-3" /></button>
              </span>
              <span className="text-[11px] text-[var(--text-secondary)]">asking in context</span>
              {hasDetail && <button type="button" onClick={() => setDetailOpen(true)} className="ml-auto text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline">details</button>}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea ref={omniRef} rows={1} value={omni}
              onChange={(e) => { setOmni(e.target.value); growOmni(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); askOmni(); } }}
              placeholder={node ? `Ask about ${node.label}…` : "Ask your brain…"}
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 outline-none placeholder:text-[var(--text-secondary)]" />
            <button type="submit" disabled={!omni.trim()} aria-label={t('Ask')}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90 disabled:bg-muted disabled:text-[var(--text-secondary)]">
              <MessageSquare className="size-4" />
            </button>
          </div>
        </div>
      </form>
      )}

      {/* detail — DUIN's Sheet slide-over, used ONLY in the standalone (non-chromeless)
          build. In the deployed chromeless app the detail renders NATIVELY in lamprey's
          Brain Explorer right-panel (pickNode → store.setDetail), so this never shows. */}
      {!chromeless && (
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent side="right" className="flex w-[94vw] flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {selProject ? <ProjectDetailInner key={selProject.name} project={selProject} />
              : node?.layer === "vault" ? <DocView path={node.id} />
              : node ? <NodeDetail node={node} track={selTrack} stream={selStream} prep={ROADMAP_KINDS.has(node.kind) ? eventPrep : null} /> : null}
          </div>
        </SheetContent>
      </Sheet>
      )}
    </div>
  );
}

// Notes-style detail for nodes that aren't a project or a vault note (tracks get their moves; the rest
// get a clean card pointing at the omnibox context).
function NodeDetail({ node, track, stream, prep }: { node: BrainNode; track: Track | null; stream?: Stream | null; prep?: EventPrep | null }) {
  const meta = km(node.kind);
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: meta.color }} />
        <div className="min-w-0">
          <div className="text-[16px] font-semibold leading-snug">{node.label}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
            <span className="rounded-full bg-muted px-1.5 py-0.5">{meta.label}</span>
            {node.layer === "product" && <span>{node.declared === 0 ? "inferred" : "declared"}</span>}
            {stream?.status && <span>· {stream.status}</span>}
          </div>
        </div>
      </div>
      {stream ? (
        <div className="mt-4 space-y-3">
          {stream.objective && <Field label={t('Objective')} value={stream.objective} />}
          {stream.parent_label && <Field label={t('Goal')} value={stream.parent_label} />}
          {stream.decision && <Field label={t('Decision')} value={stream.decision} />}
          {stream.decide_by && <Field label={t('Decide by')} value={stream.decide_by} />}
          {stream.target && <Field label={t('Target')} value={stream.target} />}
          {stream.steps && stream.steps.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('Path')}</div>
              <div className="space-y-1">
                {stream.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-[12px]">
                    <span className={`size-1.5 shrink-0 rounded-full ${s.done ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                    <span className="min-w-0 flex-1">{s.event}</span>
                    {s.when && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">{s.when}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(stream.cleared || stream.blocked) && (
            <div className="space-y-1 text-[12px]">
              {stream.cleared && <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5"><span className="font-medium text-emerald-400">If cleared → </span>{stream.cleared}</div>}
              {stream.blocked && <div className="rounded-md border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5"><span className="font-medium text-rose-400">If blocked → </span>{stream.blocked}</div>}
            </div>
          )}
          {stream.log && stream.log.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('Log')}</div>
              <div className="space-y-1">
                {stream.log.slice(-4).map((l, i) => (
                  <div key={i} className="text-[12px] text-[var(--text-secondary)]"><span className="tabular-nums">{l.ts}</span> — {l.note}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : track ? (
        <div className="mt-4 space-y-3">
          {track.goal && <Field label={t('Goal')} value={track.goal} />}
          {track.project && <Field label={t('Project')} value={track.project} />}
          <Field label={t('Status')} value={`${track.status} · ${track.active_count} active · ${track.move_count} move${track.move_count === 1 ? "" : "s"}`} />
          {track.next_decide_by && <Field label={t('Next decision')} value={`${track.next_move || "—"} — by ${track.next_decide_by}`} />}
          {track.moves && track.moves.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('Moves')}</div>
              <div className="space-y-1">
                {track.moves.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-[12px]">
                    <span className={`size-1.5 shrink-0 rounded-full ${m.status === "active" ? "bg-brand" : "bg-muted-foreground/30"}`} />
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    {m.decide_by && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">{m.decide_by}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : prep && prep.ok ? (
        <div className="mt-4 space-y-3">
          {(node as any).date && <Field label={t('Date')} value={(node as any).date} />}
          <Field label={t('Prep')} value={`${prep.counts?.tasks ?? 0} task${(prep.counts?.tasks ?? 0) === 1 ? "" : "s"} · ${prep.counts?.moves ?? 0} move${(prep.counts?.moves ?? 0) === 1 ? "" : "s"} bound to this milestone`} />
          {prep.moves.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('Feeding moves')}</div>
              <div className="space-y-1">
                {prep.moves.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-[12px]">
                    <Sparkles className="size-3.5 shrink-0 text-teal-300/80" />
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Prep tasks {prep.tasks.length || ""}</div>
            {prep.tasks.length === 0 ? <p className="text-[12px] text-[var(--text-secondary)]">{t('No bound prep tasks yet.')}</p> : (
              <div className="space-y-1">
                {prep.tasks.map((t) => (
                  <div key={t.id} className="rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-[12px]">
                    <div>{t.text}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-[var(--text-secondary)]">
                      {t.branch && <span className="rounded bg-muted px-1">{t.branch}</span>}
                      {t.due && <span>due {t.due}</span>}
                      {t.project && <span>· {t.project}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-[14px] text-[var(--text-secondary)]">It&apos;s set as your context below — ask anything about this {meta.label.toLowerCase()} in the box at the bottom.</p>
      )}
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className="mt-0.5 text-[16px]">{value}</div>
    </div>
  );
}

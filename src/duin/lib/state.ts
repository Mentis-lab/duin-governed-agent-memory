// Live harness state — vault reads + vault-IO writes over the engine's /state/* surface.
//
// SEAM RULE (see ../DUIN_BRAIN_WRITER_CONSOLIDATION_SPEC.md, M6):
//   • This module is the RENDERER↔engine path via `fetch(BASE()/state/*)`. Post-M1, BASE() is the
//     single in-process TS front (:8799), which serves what it computes natively and PROXIES the
//     rest to the python sidecar. It is the right home for READS and for VAULT-IO writes
//     (tasks/meetings/outputs/models/docs/strategy — python owns the markdown).
//   • It is the WRONG home for writes to TS-brain-OWNED derived state — owed/decision resolution,
//     insight verdicts, prediction/calibration verdicts. Those carry an id-space that only the
//     in-process brain knows; writing them here reaches python with mismatched ids → the
//     "read-brain ≠ write-brain" bug class. Use `brain-client.ts` (IPC) for those.
//   The legacy owned-concept writers below (`resolveNode`, `recordVerdict`, `postInsightVerdict`)
//   are @deprecated for owned use and get migrated to brain-client per M6.0/M6.1.
//
import { attempt, type Result } from "@/lib/result";
import { duinFetch as fetch } from "./loopback-auth";

// Read __DUIN_BASE at CALL time (not import time): the host may inject an origin after this module
// loads; a frozen const would stick on the default. Default = the in-process front, :8799.
const BASE = (): string =>
  (typeof window !== "undefined" && (window as any).__DUIN_BASE) || "http://127.0.0.1:8799";

// ── FAILURE IS NOT AN EMPTY LIST (audit pattern A, "the confident zero") ──────
// Several readers below used to resolve a non-OK response as `[]` / `{}` / the
// value the caller had just asked to SET. The panel then rendered an authoritative
// empty state over a brain it could not reach. A read that failed must REJECT so
// the caller is forced to branch on it; `Result`/`<PanelState>` in src/lib carry
// it the rest of the way.
//
// Use this instead of hand-rolling `if (!r.ok) throw new Error(...)` so every
// failure sentence has the same shape and names the route that failed.
export class StateReadError extends Error {
  readonly status: number;
  readonly route: string;
  constructor(route: string, status: number) {
    super(`${route} failed (HTTP ${status})`);
    this.name = "StateReadError";
    this.route = route;
    this.status = status;
  }
}
function requireOk(r: Response, route: string): Response {
  if (!r.ok) throw new StateReadError(route, r.status);
  return r;
}

/**
 * The Result-shaped face of this chokepoint. `attempt` converts a rejection —
 * a non-OK status, a refused TCP connect, a body that will not parse — into
 * `{ok:false, error}` and re-throws aborts, so a panel gets ONE value it must
 * branch on rather than a fallback it can mistake for data.
 *
 *   const r = await readState('decisions', (s) => fetchDecisions(s), signal)
 *   setState(panelFromResult(r))
 */
export async function readState<T>(
  label: string,
  run: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<Result<T>> {
  return attempt(label, () => run(signal));
}

export type Decision = {
  id: string;
  title: string;
  date: string;
  status: string;
  oneWay: boolean;
  reversibility: string;
  owner: string;
  reviewOn: string;
  links: number;
  layer: string;
  domain: string;
};

export async function setDecisionMeta(id: string, meta: { layer?: string; domain?: string }): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/decision-meta`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...meta }),
  });
  return r.ok;
}
export async function uploadToRaw(file: File): Promise<{ stored: string; bytes: number }> {
  const r = await fetch(`${BASE()}/state/upload-raw?filename=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  return (await r.json()) as { stored: string; bytes: number };
}

export async function fetchDecisions(signal?: AbortSignal): Promise<Decision[]> {
  const r = await fetch(`${BASE()}/state/decisions`, { signal });
  if (!r.ok) throw new Error(`state ${r.status}`);
  const data = (await r.json()) as { decisions?: Decision[] };
  return data.decisions ?? [];
}

export type Project = { name: string; desc: string; tracks: number };

export async function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  const r = await fetch(`${BASE()}/state/projects`, { signal });
  if (!r.ok) throw new Error(`state ${r.status}`);
  const data = (await r.json()) as { projects?: Project[] };
  return data.projects ?? [];
}

// Topic SPACES — the user's real arenas (top-level domain folders), each with a
// cross-type rollup. Drives the per-space lenses + panel in the brain graph.
export type Space = { name: string; notes: number; decisions: number; people: number; desc: string };
export async function fetchSpaces(signal?: AbortSignal): Promise<Space[]> {
  // Was `if (!r.ok) return []` — a dead brain and a vault with no top-level
  // domains produced the same value, and the space lenses rendered as "none".
  const r = requireOk(await fetch(`${BASE()}/state/spaces`, { signal }), "spaces");
  const data = (await r.json()) as { spaces?: Space[] };
  return data.spaces ?? [];
}

// Operator STYLE FINGERPRINT — the descriptive self-model: how you actually decide (Wilson-gated
// decision-idiom histograms) + where stated preferences diverge from the record. A read-only mirror
// (see PLANNING/DUIN_OPERATOR_FINGERPRINT_PLAN.md). Silence below the sample floor is first-class.
export type FingerprintAxis = {
  id: string;
  label: string;
  poles: [string, string];
  countA: number;
  countB: number;
  n: number;
  total: number;
  explicitN?: number;
  ratio: number | null;
  ci: [number | null, number | null];
  lean: "A" | "B" | "balanced" | null;
  gate: "silent" | "observe" | "norm";
  source: string;
  derivable: "now" | "needs-capture";
};
export type Divergence = {
  factId: string;
  factText: string;
  axis: string;
  claimedPole: string;
  contradictingPole: string;
  againstShare: number | null;
  ci: [number | null, number | null];
  n: number;
  status: "aligned" | "diverges" | "cannot-prove";
};
export type StyleFingerprint = {
  fingerprint: { generatedAt: number; totalDecisions: number; minN: number; axes: FingerprintAxis[] };
  divergences: Divergence[];
  scopedIdioms: unknown[];
  drift: { drifting: boolean } | null;
  promotedFactCount: number;
};
export async function fetchStyleFingerprint(signal?: AbortSignal): Promise<StyleFingerprint | null> {
  const r = await fetch(`${BASE()}/state/style-fingerprint`, { signal });
  // 404 is a real answer here — the route only exists once the fingerprint pass has
  // run — so `null` still means "no fingerprint yet". Every OTHER non-OK status is a
  // read FAILURE and must not masquerade as "you have no measured style".
  if (r.status === 404) return null;
  requireOk(r, "style-fingerprint");
  return (await r.json()) as StyleFingerprint;
}

// Event (milestone) prep — the tasks bound to it (full corpus, via anchor rules) + the moves that feed it.
export type EventPrep = {
  ok: boolean;
  event?: { id: string; name: string; date: string };
  tasks: { id: string; text: string; branch: string; due: string; project: string }[];
  moves: { id: string; title: string; track: string }[];
  counts?: { tasks: number; moves: number };
};
export async function fetchEventPrep(id: string, signal?: AbortSignal): Promise<EventPrep> {
  // Had NO status check at all: a 500 whose body happened to parse resolved as a
  // successful EventPrep with empty tasks/moves.
  const r = requireOk(
    await fetch(`${BASE()}/state/event-prep?id=${encodeURIComponent(id)}`, { signal }),
    "event-prep"
  );
  return r.json();
}

// Upload a PNG logo for a project — its brain-graph node then renders AS that logo (2D + 3D billboard).
export async function uploadProjectLogo(project: string, file: File): Promise<{ ok: boolean; logo?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/project-logo?project=${encodeURIComponent(project)}`, { method: "POST", body: file });
  return r.json();
}
export async function clearProjectLogo(project: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${BASE()}/state/project-logo?project=${encodeURIComponent(project)}&clear=1`, { method: "POST" });
  return r.json();
}

// Meetings & Events mined from chat sweeps (WeChat / Feishu).
export type Meeting = { id: string; when: string; who: string; what: string; type: string; source: string; status: string };
export async function fetchMeetings(signal?: AbortSignal): Promise<Meeting[]> {
  const r = await fetch(`${BASE()}/state/meetings`, { signal });
  if (!r.ok) throw new Error(`meetings ${r.status}`);
  return ((await r.json()) as { meetings?: Meeting[] }).meetings ?? [];
}
export async function scanMeetings(): Promise<{ ok: boolean; found?: number; total?: number; error?: string }> {
  const r = await fetch(`${BASE()}/state/meeting-scan`, { method: "POST" });
  return r.json();
}
export async function meetingAction(id: string, action: "confirm" | "dismiss"): Promise<{ ok: boolean; status?: string }> {
  const r = await fetch(`${BASE()}/state/meeting-action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
  return r.json();
}

/* ---------------- Outputs: what the assistant produces, tracked + graph-linked ---------------- */
export type Output = {
  id: string;
  title: string;
  type: string;
  created: string;
  decision: string;
};

export type OutputDraft = {
  title: string;
  type: string;
  content: string;
  decisionId: string;
  linkedTo?: { kind: string; id: string }[];
  thinking?: string[];
};

export async function fetchOutputs(decisionId: string, signal?: AbortSignal): Promise<Output[]> {
  const r = await fetch(`${BASE()}/state/outputs?decisionId=${encodeURIComponent(decisionId)}`, { signal });
  if (!r.ok) throw new Error(`outputs ${r.status}`);
  const data = (await r.json()) as { outputs?: Output[] };
  return data.outputs ?? [];
}

export async function saveOutput(draft: OutputDraft): Promise<Output> {
  const r = await fetch(`${BASE()}/state/outputs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return (await r.json()) as Output;
}

/* ---------------- Outputs hub: Schedules (recurring loops) · Intel (md) · Documents (files) ---------------- */
export type Schedule = {
  name: string; schedule: string; executor: string; target: string;
  enabled: boolean; paused: boolean; due: boolean; last: string; note: string;
};
export async function fetchSchedules(signal?: AbortSignal): Promise<Schedule[]> {
  const { schedules } = await fetchSchedulesWithRunner(signal);
  return schedules;
}
/** Schedules PLUS whether the loop runner can actually fire them (backgroundAutonomy AND
 *  loopsEnabled). Older engines omit the flag — treat missing as true so we never show a
 *  false "runner off" note against a build that predates it. */
export async function fetchSchedulesWithRunner(
  signal?: AbortSignal
): Promise<{ schedules: Schedule[]; runnerEnabled: boolean }> {
  const r = await fetch(`${BASE()}/state/schedules`, { signal });
  if (!r.ok) throw new Error(`schedules ${r.status}`);
  const body = (await r.json()) as { schedules?: Schedule[]; runnerEnabled?: boolean };
  return { schedules: body.schedules ?? [], runnerEnabled: body.runnerEnabled !== false };
}
export type ScheduleActionPayload = {
  action: "add" | "edit" | "remove" | "pause" | "resume" | "run";
  name: string; schedule?: string; executor?: string; target?: string; args?: string; note?: string; disabled?: boolean;
};
export async function scheduleAction(p: ScheduleActionPayload): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/schedule-action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
  });
  return (await r.json()) as { ok: boolean; message?: string; error?: string };
}

export type IntelDoc = { path: string; title: string; date: string; source: string; from_schedule: string; track: string; summary: string; bytes: number };
export async function fetchIntel(signal?: AbortSignal): Promise<IntelDoc[]> {
  const r = await fetch(`${BASE()}/state/intel`, { signal });
  if (!r.ok) throw new Error(`intel ${r.status}`);
  return ((await r.json()) as { intel?: IntelDoc[] }).intel ?? [];
}

export type DocFile = { path: string; name: string; format: string; ext: string; bytes: number; created: string; source: string; from_schedule: string };
export async function fetchDocuments(signal?: AbortSignal): Promise<DocFile[]> {
  const r = await fetch(`${BASE()}/state/documents`, { signal });
  if (!r.ok) throw new Error(`documents ${r.status}`);
  return ((await r.json()) as { documents?: DocFile[] }).documents ?? [];
}
export function documentUrl(path: string): string {
  return `${BASE()}/state/document-raw?path=${encodeURIComponent(path)}`;
}

/* ---------------- Tasks: interactive Kanban over the vault's checkbox tasks ---------------- */
export type TaskFeed = { stream_id: string; title: string; track: string; goal: string; step: string };
export type Task = {
  id: string; movable: boolean; text: string; done: boolean; status: string; priority: string;
  due: string; estimate: string; assignees: string; tags: string[]; people: string[];
  contexts: string[]; project: string; source: string; line: number;
  feeds?: TaskFeed[]; grounded?: boolean;
};
export type TasksData = { columns: string[]; tasks: Task[]; counts: Record<string, number>; grounded?: number; open?: number };

export type CaptureResult = {
  ok: boolean;
  task?: { id: string; title: string; track: string; priority: string; due: string; path: string };
  bound_to?: { stream_id: string; title: string; track: string } | null;
  proposed_stream?: string | null;
  error?: string;
};
export async function captureWork(text: string): Promise<CaptureResult> {
  const r = await fetch(`${BASE()}/state/capture-work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  return (await r.json()) as CaptureResult;
}
export async function scoutWork(force = false): Promise<{ ok: boolean; scanning?: boolean; skipped?: string }> {
  const r = await fetch(`${BASE()}/state/scout-work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
  return (await r.json()) as { ok: boolean; scanning?: boolean; skipped?: string };
}
export async function bindTask(task_id: string, stream_id: string, opts: { unbind?: boolean; due?: string } = {}): Promise<{ ok: boolean; title?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/task-bind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_id, stream_id, ...opts }) });
  return (await r.json()) as { ok: boolean; title?: string; error?: string };
}

export async function fetchTasks(signal?: AbortSignal): Promise<TasksData> {
  const r = await fetch(`${BASE()}/state/tasks`, { signal });
  if (!r.ok) throw new Error(`tasks ${r.status}`);
  return (await r.json()) as TasksData;
}
export async function moveTask(id: string, status: string): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/task-move`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }),
  });
  return r.ok;
}
// Prewarm a conversation's persistent brain session the moment its chat opens, so the first turn skips
// the cold-connect. Fire-and-forget; threadId must match the AG-UI run's threadId (= convId).
export async function prewarmSession(threadId: string): Promise<void> {
  try {
    await fetch(`${BASE()}/state/prewarm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId }) });
  } catch { /* best-effort */ }
}
// Deleting a Recents chat clears its brain-side cache too (warm SDK client + --resume session id).
export async function deleteConversationSession(threadId: string): Promise<void> {
  try {
    await fetch(`${BASE()}/state/conversation-delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId }) });
  } catch { /* best-effort */ }
}
export async function resyncHarness(): Promise<{ ok: boolean; fired?: string[] }> {
  const r = await fetch(`${BASE()}/state/resync`, { method: "POST" });
  return r.ok ? ((await r.json()) as { ok: boolean; fired?: string[] }) : { ok: false };
}
export async function taskAction(id: string, action: "complete" | "reopen" | "delete" | "priority" | "due" | "estimate", value = ""): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/task-action`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, value }),
  });
  return r.ok;
}
export async function setModel(model: string): Promise<string> {
  const r = await fetch(`${BASE()}/state/config`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error(`set model failed (${r.status})`);
  return ((await r.json()) as { model?: string }).model ?? model;
}

/* ---------------- Loops: DUIN's judgment & learning machinery (read-only visualization) ---------------- */
export type Learning = { ts: string; skill: string; correction: string; rule: string; status: string; polarity: string };
export type RoutineRun = { routine: string; runs: number; lastTs: string; lastMessage: string; level: string; path: string };
export type Loops = { learnings: Learning[]; routines: RoutineRun[]; summary: Record<string, number> };

export async function fetchLoops(signal?: AbortSignal): Promise<Loops> {
  const r = await fetch(`${BASE()}/state/loops`, { signal });
  if (!r.ok) throw new Error(`loops ${r.status}`);
  return (await r.json()) as Loops;
}

export type LearnRun = { status: "idle" | "running" | "done" | "error"; summary: string; started: string; finished: string };
export type LearnLoop = { queued: number; corrections_new: number; proposals_pending: number; distill_due: boolean; debt: number; run?: LearnRun };
export async function fetchLearnLoop(signal?: AbortSignal): Promise<LearnLoop> {
  const r = await fetch(`${BASE()}/state/learn-loop`, { signal });
  if (!r.ok) throw new Error(`learn-loop ${r.status}`);
  return (await r.json()) as LearnLoop;
}
export async function runLearnLoop(): Promise<{ ok: boolean; status: string }> {
  const r = await fetch(`${BASE()}/state/learn-loop/run`, { method: "POST" });
  return r.ok ? ((await r.json()) as { ok: boolean; status: string }) : { ok: false, status: "error" };
}

// ── Learning loop (in-engine): capture → reflect → taste ──────────────────────
export type Correction = {
  why?: string; correction?: string; candidate_rule?: string; ai_output?: string;
  artifact?: string; skill?: string; polarity?: "correction" | "positive";
  touches?: { values?: string[]; frameworks?: string[] };
};
/** Capture arrow: log an operator correction (or a positive endorsement). The engine
 *  rejects any row carrying `source` (machine rows must not pollute the learn stream). */
export async function postCorrection(c: Correction): Promise<{ ok: boolean; total?: number; error?: string }> {
  const r = await fetch(`${BASE()}/learn/correction`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c)
  });
  return r.ok ? await r.json() : { ok: false, error: `correction ${r.status}` };
}
export type ReflectResult = {
  stream_size: number; themes: string[];
  binding_candidates: { count: number; theme: string[]; sample: string }[];
  taste_counts: { values?: number; frameworks?: number; correction_rules?: number };
};
/** Reflect + surface 3×-recurrence binding candidates + recompute taste-engine, one call. */
export async function runReflect(): Promise<ReflectResult> {
  const r = await fetch(`${BASE()}/learn/reflect`, { method: "POST" });
  if (!r.ok) throw new Error(`reflect ${r.status}`);
  return (await r.json()) as ReflectResult;
}
/** The HUMAN CONFIRM on a surfaced binding candidate — the one thing that mints a
 *  binding row. Nothing auto-binds: the route 400s unless the caller supplies an
 *  explicit `rule` AND a non-empty `candidate.theme[]`, which is why the caller
 *  gates its button on the same two conditions rather than letting the operator
 *  discover the refusal.
 *
 *  Same renderer→:8799 transport as runReflect above (the confirm sits next to the
 *  reflect that produced the candidate). Resolves — never throws — so a refusal is
 *  surfaced as a message instead of an unhandled rejection in a click handler. */
export async function bindCandidate(
  candidate: { count: number; theme: string[]; sample: string },
  rule: string
): Promise<{ ok: boolean; binding?: { id: string; rule: string }; error?: string }> {
  try {
    const r = await fetch(`${BASE()}/state/bind-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate, rule })
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; binding?: { id: string; rule: string }; error?: string };
    if (!r.ok) return { ok: false, error: body.error ?? `bind-candidate ${r.status}` };
    return { ok: true, binding: body.binding };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
export type Taste = {
  values: { id?: string; statement?: string; name?: string }[];
  frameworks: { id?: string; name?: string }[];
  correction_rules: { why?: string; correction?: string; candidate_rule?: string; polarity?: string }[];
};
/** Consumption arrow: the compiled taste the brain reads before reasoning. */
export async function fetchTaste(signal?: AbortSignal): Promise<Taste> {
  const r = await fetch(`${BASE()}/learn/taste`, { signal });
  if (!r.ok) throw new Error(`taste ${r.status}`);
  return (await r.json()) as Taste;
}

export type TrackMove = { id: string; title: string; decide_by: string; status: string };
export type Track = { id: string; label: string; goal: string; lane: string; project: string; move_count: number; active_count: number; status: "active" | "quiet"; next_move: string; next_decide_by: string; moves: TrackMove[] };
export async function fetchTracks(signal?: AbortSignal): Promise<Track[]> {
  const r = await fetch(`${BASE()}/state/tracks`, { signal });
  if (!r.ok) throw new Error(`tracks ${r.status}`);
  return ((await r.json()) as { tracks: Track[] }).tracks ?? [];
}
export async function createProject(name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/project-create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}
export async function addTrack(t: { label: string; project?: string; lane?: string; keywords?: string[] }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/track-add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}
export async function assignTrack(id: string, project: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/track-assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, project }) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}

export type StrategySections = { aspiration: string; where_to_play: string; how_to_win: string; capabilities: string; values: string };
export type Strategy = { id: string; level: "global" | "project" | "track"; target: string; title: string; sections: StrategySections };
export async function fetchStrategies(signal?: AbortSignal): Promise<Strategy[]> {
  const r = await fetch(`${BASE()}/state/strategies`, { signal });
  if (!r.ok) throw new Error(`strategies ${r.status}`);
  return ((await r.json()) as { strategies: Strategy[] }).strategies ?? [];
}
export async function saveStrategy(s: Partial<Strategy> & { id: string }): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/strategy-save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}
export async function generateStrategy(p: { level: string; target: string; instruction?: string }): Promise<{ ok: boolean; sections?: StrategySections; error?: string }> {
  const r = await fetch(`${BASE()}/state/strategy-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}

// Mental Models — Strategy is one TYPE among principles / lenses / frameworks / playbooks.
export type ModelSection = { key: string; label: string };
export type ModelTemplates = Record<string, ModelSection[]>;
export type MentalModel = { id: string; type: string; level: string; target: string; title: string; summary?: string; sections: Record<string, string> };
export async function fetchModels(signal?: AbortSignal): Promise<{ models: MentalModel[]; templates: ModelTemplates }> {
  const r = await fetch(`${BASE()}/state/models`, { signal });
  if (!r.ok) throw new Error(`models ${r.status}`);
  return (await r.json()) as { models: MentalModel[]; templates: ModelTemplates };
}
export async function saveModel(m: Partial<MentalModel> & { id: string }): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/model-save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}
export async function generateModel(p: { type: string; title?: string; target?: string; level?: string; instruction?: string }): Promise<{ ok: boolean; type?: string; sections?: Record<string, string>; error?: string }> {
  const r = await fetch(`${BASE()}/state/model-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
  return r.ok ? await r.json() : { ok: false, error: `http ${r.status}` };
}

// The unified graph store (ONTOLOGY.md / duin.db) — Phase-1 shadow, read-only.
export type StoreNode = { id: string; kind: string; declared: number; title: string; status?: string; project?: string; lane?: string; decide_by?: string; confidence?: number; verdict?: string; provenance?: string };
export type StoreEdge = { src: string; dst: string; type: string };
export type GraphSummary = { nodes: StoreNode[]; edges: StoreEdge[]; by_kind: Record<string, { declared: number; inferred: number }>; by_edge: Record<string, number>; node_count: number; edge_count: number };
export async function fetchUnifiedGraph(signal?: AbortSignal): Promise<GraphSummary> {
  const r = await fetch(`${BASE()}/state/store-graph`, { signal });
  if (!r.ok) throw new Error(`store-graph ${r.status}`);
  return (await r.json()) as GraphSummary;
}

// The combined second-brain graph (DUIN CORE at center + product graph + vault knowledge cloud, no islands).
/** `layer` is the coarsest true partition of the graph, and the Explorer's tiers are built on it:
 *  `vault` = notes the operator wrote, `construction` = entities the extractor derived from them,
 *  `product` = the operator's committed structure (cards / KRs / moves). `folder` and `core` are
 *  scaffolding.
 *
 *  `construction` was ABSENT from this union until 2026-08-04 while carrying 6,213 of the 7,462
 *  live nodes — the single largest layer, untypeable. Any `n.layer === 'construction'` comparison
 *  was a TS2367 "this comparison appears unintentional", which is exactly the check that would
 *  have caught the Explorer partitioning on overlapping `kind` sets instead of on `layer`. */
export type BrainNode = { id: string; kind: string; label: string; layer: "core" | "product" | "vault" | "folder" | "construction"; declared?: number; group?: string; date?: string; mtime?: number };
export type BrainLink = { source: string; target: string; type: string };
export type BrainGraph = { nodes: BrainNode[]; links: BrainLink[]; core: string; stats: { nodes: number; edges: number }; demo?: boolean };
export async function fetchBrainGraph(signal?: AbortSignal): Promise<BrainGraph> {
  const r = await fetch(`${BASE()}/state/brain-graph`, { signal });
  if (!r.ok) throw new Error(`brain-graph ${r.status}`);
  return (await r.json()) as BrainGraph;
}
/** Counts-only view of the same cache. For surfaces that show numbers, not the
 *  graph: the full route is ~1.5MB and its JSON.parse is a measured renderer
 *  main-thread stall, paid per open before this existed. */
export type BrainGraphSummary = { nodes: number; links: number; stale?: boolean };
export async function fetchBrainGraphSummary(signal?: AbortSignal): Promise<BrainGraphSummary> {
  const r = await fetch(`${BASE()}/state/brain-graph/summary`, { signal });
  if (!r.ok) throw new Error(`brain-graph summary ${r.status}`);
  return (await r.json()) as BrainGraphSummary;
}
/* `fetchGraphDiff` / `GraphDiff` were REMOVED here — see the note in
   brain-shell.tsx where the "in sync" pill used to live. That route was only
   ever the Python sidecar's `graph.parity_report()`; the sidecar was deleted in
   1ce3c534 and no TS route replaced it, so this fetcher had been 404ing on
   every graph-shell mount ever since. Restoring the pill means first deciding
   what "store" and "live" mean in the unified single-brain architecture — a
   design call, not a missing line of code. */

/* ---------------- Knowledge graph: the whole vault as nodes + wikilink edges ---------------- */
export type GraphNode = { id: string; label: string; group: string; deg: number };
export type GraphLink = { source: string; target: string };
export type Graph = { nodes: GraphNode[]; links: GraphLink[]; folders: string[] };

export async function fetchGraph(signal?: AbortSignal): Promise<Graph> {
  const r = await fetch(`${BASE()}/state/graph`, { signal });
  if (!r.ok) throw new Error(`graph ${r.status}`);
  return (await r.json()) as Graph;
}
export async function fetchFolders(signal?: AbortSignal): Promise<string[]> {
  const r = await fetch(`${BASE()}/state/folders`, { signal });
  if (!r.ok) throw new Error(`folders ${r.status}`);
  return ((await r.json()) as { folders?: string[] }).folders ?? [];
}

/* ---------------- Problems: the open-loop register (problems · risks · owed decisions) ---------------- */
export type ProblemNode = { id: string; kind: string; title: string; meta: string; state: string; source: string; detail: string; links: string[]; graduated: boolean; path: string };
export type ProblemsData = { nodes: ProblemNode[]; counts: Record<string, number>; register: string };
export async function fetchProblems(signal?: AbortSignal): Promise<ProblemsData> {
  const r = await fetch(`${BASE()}/state/problems`, { signal });
  if (!r.ok) throw new Error(`problems ${r.status}`);
  return (await r.json()) as ProblemsData;
}

/* ---------------- Conversations: people you owe follow-ups, timeline in their profile ---------------- */
export type Conversation = { person: string; org: string; profile: string; open: number; total: number; followups: Task[] };
export async function fetchConversations(signal?: AbortSignal): Promise<Conversation[]> {
  const r = await fetch(`${BASE()}/state/conversations`, { signal });
  if (!r.ok) throw new Error(`conversations ${r.status}`);
  return ((await r.json()) as { conversations?: Conversation[] }).conversations ?? [];
}
export type ConversationThread = { person: string; org: string; channel: string; title: string; summary: string; updated: string; messages?: string; owed?: string; awaiting?: boolean; status: string; open: number; total: number; profile: string; followups: Task[] };
export async function fetchConversationThreads(signal?: AbortSignal): Promise<{ threads: ConversationThread[]; channels: { name: string; count: number }[] }> {
  const r = await fetch(`${BASE()}/state/conversation-threads`, { signal });
  if (!r.ok) throw new Error(`conversation-threads ${r.status}`);
  return (await r.json()) as { threads: ConversationThread[]; channels: { name: string; count: number }[] };
}
export async function draftReply(profile: string, person: string, owed: string, thread = ""): Promise<{ ok: boolean; draft?: string }> {
  const r = await fetch(`${BASE()}/state/draft-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, person, owed, thread }) });
  return r.ok ? ((await r.json()) as { ok: boolean; draft?: string }) : { ok: false };
}
export type LiveMessage = { mine: boolean | null; text: string; time: string };
export async function pullMessages(query: string): Promise<{ ok: boolean; chat?: string; awaiting?: boolean; messages: LiveMessage[]; error?: string }> {
  const r = await fetch(`${BASE()}/state/pull-messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  return r.ok ? ((await r.json()) as { ok: boolean; chat?: string; awaiting?: boolean; messages: LiveMessage[]; error?: string }) : { ok: false, messages: [] };
}
export async function sendMessage(query: string, text: string): Promise<{ ok: boolean; to?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/send-message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, text }) });
  return r.ok ? ((await r.json()) as { ok: boolean; to?: string; error?: string }) : { ok: false, error: "request failed" };
}

export async function makeDecision(d: { nodeId?: string; title: string; call: string; rationale?: string; reversibility?: string; layer?: string; domain?: string; consequences?: string }): Promise<{ ok: boolean; path?: string; id?: string; nodeClosed?: boolean }> {
  const r = await fetch(`${BASE()}/state/make-decision`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d),
  });
  return r.ok ? ((await r.json()) as { ok: boolean; path?: string; id?: string; nodeClosed?: boolean }) : { ok: false };
}

export async function resolveNode(id: string, action: "resolve" | "archive" | "advance", note = ""): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/resolve-node`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, note }),
  });
  return r.ok;
}

/* ---------------- Detectors: what the scheduled routines FOUND (not just that they ran) ---------------- */
export type DetectorGroup = { key: string; label: string; count: number; items: string[] };
export type Detector = { name: string; path: string; lastRun: string; total: number; groups: DetectorGroup[]; stateFile: string };
export async function fetchDetectors(signal?: AbortSignal): Promise<Detector[]> {
  const r = await fetch(`${BASE()}/state/detectors`, { signal });
  if (!r.ok) throw new Error(`detectors ${r.status}`);
  return ((await r.json()) as { detectors?: Detector[] }).detectors ?? [];
}

/* ---------------- Value-visible loop: the track record (saves / misses / verdicts) ---------------- */
export type ValueData = {
  digest: string; track: Record<string, number>; saves: string[]; misses: string[];
  dueForVerdict: { id: string; title: string; reviewOn: string }[]; hasDigest: boolean;
};
export async function fetchValue(signal?: AbortSignal): Promise<ValueData> {
  const r = await fetch(`${BASE()}/state/value`, { signal });
  if (!r.ok) throw new Error(`value ${r.status}`);
  return (await r.json()) as ValueData;
}

/** Record how a due decision turned out — closes the value loop (writes verdict + ledger). */
export async function recordVerdict(id: string, verdict: "right" | "wrong" | "partial" | "unobserved", note = ""): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/verdict`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, verdict, note }),
  });
  return r.ok;
}

/* ---------------- Insight engine: the synthesis pass over Prediction + Learning ---------------- */
export type Insight = { id: string; type: string; mode?: "generative" | "analytical" | "decisional"; headline: string; why: string; sources: string[]; confidence: number; suggested_move: string; track: string; verdict?: string; generated?: string };
export async function fetchInsights(force = false, signal?: AbortSignal): Promise<{ insights: Insight[]; count?: number; generated?: string }> {
  const r = await fetch(`${BASE()}/state/insights${force ? "?force=1" : ""}`, { signal });
  if (!r.ok) throw new Error(`insights ${r.status}`);
  return (await r.json()) as { insights: Insight[]; count?: number };
}
export async function postInsightVerdict(id: string, verdict: "useful" | "dismissed" | "acted" | "inaccurate"): Promise<{ ok: boolean }> {
  const r = await fetch(`${BASE()}/state/insight-verdict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, verdict }) });
  return (await r.json()) as { ok: boolean };
}

/* -------- Cascade review tray: high-stakes generative cascades (project→tracks, decision→affected),
   already adversarially judged, awaiting your approve/dismiss. -------- */
export type CascadePending = {
  id: string;
  kind: "project-track" | "decision-affected" | "active-work";
  source: string;
  proposal: { label?: string; goal?: string; keywords?: string[]; stream_id?: string; title?: string; change?: string; why?: string; track?: string; task_title?: string };
  status: string;
  created?: string;
};
export async function fetchCascadePending(signal?: AbortSignal): Promise<CascadePending[]> {
  const r = await fetch(`${BASE()}/state/cascade-pending`, { signal });
  if (!r.ok) throw new Error(`cascade-pending ${r.status}`);
  return ((await r.json()) as { pending: CascadePending[] }).pending || [];
}
export async function postCascadeResolve(id: string, action: "approve" | "dismiss"): Promise<{ ok: boolean; applied?: string; error?: string }> {
  const r = await fetch(`${BASE()}/state/cascade-resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
  return (await r.json()) as { ok: boolean; applied?: string; error?: string };
}

/* ---------------- Revealed risks: detector-surfaced risk tasks (confirm → register / dismiss) ---------------- */
export type RevealedRisk = { id: string; title: string; due: string; priority: string; reason: string; project: string; source: string; summary?: string; key?: string; track?: string; update?: string | null; confidence?: number };
export async function fetchRevealedRisks(signal?: AbortSignal): Promise<RevealedRisk[]> {
  const r = await fetch(`${BASE()}/state/revealed-risks`, { signal });
  if (!r.ok) throw new Error(`revealed ${r.status}`);
  return ((await r.json()) as { risks?: RevealedRisk[] }).risks ?? [];
}
export type WorldUpdate = { summary: string; ts: string; type?: string };
export type WorldEvent = { date: string; label: string; kind: "update" | "risk" | "deadline"; confidence: number };
export type WorldTrack = { key: string; label: string; open: number; due_soon: number; next_due: string | null; risks: number; top_risk: string | null; status: string; drivers: string[]; linked?: string[]; risk_list?: string[]; updates?: WorldUpdate[]; beliefs?: WorldUpdate[]; trajectory?: string | null; events?: WorldEvent[] };
export type WorldState = { tracks: WorldTrack[]; generated: string; priors: string };
export async function fetchWorldState(signal?: AbortSignal): Promise<WorldState> {
  const r = await fetch(`${BASE()}/state/world-state`, { signal });
  if (!r.ok) throw new Error(`world-state ${r.status}`);
  return (await r.json()) as WorldState;
}
export type WGNode = { id: string; kind: "track" | "risk" | "deadline" | "update" | "decision"; track: string; label: string; date: string; confidence?: number };
export type WGEdge = { source: string; target: string; type: string };
export type WGTrajPoint = { date: string; v: number; risk?: string };
export type WGTrajectory = { line: WGTrajPoint[]; end: string; addressed: { date: string; v: number }; unaddressed: { date: string; v: number } };
export type WorldGraph = { tracks: string[]; labels: Record<string, string>; nodes: WGNode[]; edges: WGEdge[]; trajectories: Record<string, WGTrajectory>; generated: string };
export async function fetchWorldGraph(signal?: AbortSignal): Promise<WorldGraph> {
  const r = await fetch(`${BASE()}/state/world-graph`, { signal });
  if (!r.ok) throw new Error(`world-graph ${r.status}`);
  return (await r.json()) as WorldGraph;
}
export async function fetchFuturesGraph(signal?: AbortSignal): Promise<{ nodes: unknown[]; links: unknown[]; today?: string }> {
  const r = await fetch(`${BASE()}/state/futures-graph`, { signal });
  if (!r.ok) throw new Error(`futures-graph ${r.status}`);
  return (await r.json()) as { nodes: unknown[]; links: unknown[]; today?: string };
}
export type CausalNode = { id: string; kind: string; label: string; track?: string; date?: string; risk?: string; branch?: string; slack?: number | null; in_degree?: number; converges?: boolean; confidential?: boolean; overdue?: boolean; decide_by?: string; decision_id?: string; fork?: { cleared: string; blocked: string } | null; steps?: { event: string; when: string; done: boolean }[] };
export type CausalEdge = { source: string; target: string; type: string; lag_days?: number | null; polarity?: string; branch?: boolean; confidence?: number; evidence?: string };
export type RoadmapNode = { id: string; name: string; date?: string; kind?: string; risk?: string; track?: string; in_degree?: number; days_out?: number | null; builds_toward?: string };
export type CausalGraph = { nodes: CausalNode[]; edges: CausalEdge[]; anchor?: string | null; critical_path_edges?: CausalEdge[]; roadmap?: RoadmapNode[]; today?: string; stats?: { nodes: number; edges: number; converge_nodes: number } };
export async function fetchCausalGraph(anchor?: string, signal?: AbortSignal): Promise<CausalGraph> {
  const q = anchor ? `?anchor=${encodeURIComponent(anchor)}` : "";
  const r = await fetch(`${BASE()}/state/causal-graph${q}`, { signal });
  if (!r.ok) throw new Error(`causal-graph ${r.status}`);
  return (await r.json()) as CausalGraph;
}
export type Driver = { driver: string; track?: string; explains: string[] };
export async function fetchDrivers(signal?: AbortSignal): Promise<{ drivers: Driver[]; generated?: string }> {
  const r = await fetch(`${BASE()}/state/drivers`, { signal });
  if (!r.ok) throw new Error(`drivers ${r.status}`);
  return (await r.json()) as { drivers: Driver[]; generated?: string };
}
export type PropagateResult = { origin: string; shift_days?: number; decision?: string | null; count: number; affected: { id: string; label: string; kind: string; shift_days?: number; branch?: string }[] };
export async function fetchPropagate(node?: string, decision?: string, signal?: AbortSignal): Promise<PropagateResult> {
  const p = new URLSearchParams();
  if (node) p.set("node", node);
  if (decision) p.set("decision", decision);
  const qs = p.toString();
  const r = await fetch(`${BASE()}/state/propagate${qs ? `?${qs}` : ""}`, { signal });
  if (!r.ok) throw new Error(`propagate ${r.status}`);
  return (await r.json()) as PropagateResult;
}
export type StreamStep = { event: string; when: string; lead: string; done?: boolean };
export type StreamLevels = { risk: number; progress: number; confidence: number };
export type StreamLog = { ts: string; note: string };
export type Stream = { id: string; title: string; objective: string; parent: string; parent_label: string; track: string; kind: "active" | "emerging"; target: string; trigger: string; decision: string; decide_by: string; steps: StreamStep[]; cleared: string; blocked: string; confirm?: string; levels: StreamLevels; confidence: number; log?: StreamLog[]; mentions?: number; importance?: number; status: "open" | "engaged" | "declined"; source: "inferred" | "synced" };
export type Objective = { key: string; label: string; count: number; engaged: number; risk: number; progress: number; confidence: number; decide_by: string; mentions?: number; importance?: number; members: string[] };
export type StreamStub = { id: string; title: string; track: string; mentions?: number };
export async function fetchFutures(signal?: AbortSignal): Promise<{ objectives: Objective[]; streams: Stream[]; dormant?: StreamStub[]; dismissed?: StreamStub[]; today: string; accuracy?: { hit_rate: number | null; scored: number } }> {
  const r = await fetch(`${BASE()}/state/futures`, { signal });
  if (!r.ok) throw new Error(`futures ${r.status}`);
  return (await r.json()) as { objectives: Objective[]; streams: Stream[]; dormant?: StreamStub[]; dismissed?: StreamStub[]; today: string; accuracy?: { hit_rate: number | null; scored: number } };
}
export type ForecastRecord = { generated?: string; resolved_this_run?: number; note?: string; patterns?: Record<string, { fired: number; materialized: number; averted?: number; unobserved?: number; hit_rate: number | null }>; confidence_calibration?: Record<string, { fired: number; materialized: number; observed: number; materialize_rate: number | null }> };
export async function fetchForecastRecord(signal?: AbortSignal): Promise<ForecastRecord> {
  // Was `: {}` — indistinguishable from "no forecasts have ever fired", which is
  // exactly the claim the Decisions track-record header makes out of it.
  const r = requireOk(await fetch(`${BASE()}/state/forecast-record`, { signal }), "forecast-record");
  return (await r.json()) as ForecastRecord;
}
// Calibration scorecard — the honest, FEDERATED forecast track record (risk · stream · promotion).
// averted = useful (not a miss); gated below min_n; no Brier; human false-alarm feedback overlaid.
export type ResolvedPrediction = { id: string; domain: string; kind: string; mode: string; predicted: string; confidence: number | null; track: string; verdict: string; outcome: string | null; false_alarm?: boolean; resolved: string };
export type CalDomain = { total: number; resolved: number; useful: number; wrong: number; signal: number; false_alarms: number; observed: number; useful_rate: number | null; smoothed_rate: number | null; wilson_lo: number | null; wilson_hi: number | null; gated: boolean };
export type CalTier = { fired: number; observed: number; useful: number; useful_rate: number | null; smoothed_rate: number | null; wilson_lo: number | null; wilson_hi: number | null; gated: boolean };
export type Calibration = {
  generated: string; min_n: number; note: string;
  domains: Record<string, CalDomain>;
  tier_calibration: Record<string, CalTier>;
  recently_resolved: ResolvedPrediction[];
  totals: { predictions: number; resolved: number; open: number; false_alarms: number; by_domain: Record<string, { total: number; resolved: number; useful_rate: number | null; gated: boolean }> };
};
export async function fetchCalibration(signal?: AbortSignal): Promise<Calibration> {
  const r = await fetch(`${BASE()}/state/calibration`, { signal });
  if (!r.ok) throw new Error(`calibration ${r.status}`);
  return (await r.json()) as Calibration;
}

export type ReliabilityBin = { lo: number; hi: number; n: number; meanPredicted: number; observedFreq: number };
export type CalibrationScore = {
  n: number;
  baseRate: number | null;
  brier: number | null;
  baselineBrier: number | null;
  skillScore: number | null;
  logLoss: number | null;
  ece: number | null;
  reliability: ReliabilityBin[];
  synthetic?: boolean;
  label?: string;
};
/** Proper-scoring readout (Brier / skill / ECE + reliability curve). `replay:true` fetches the
 *  LABELED synthetic demo (never real data) so the instrument is visible before organic forecasts
 *  resolve (item 18 panel data layer; the brain-shell overlay lands after live visual verification). */
export async function fetchCalibrationScore(opts?: { replay?: boolean }, signal?: AbortSignal): Promise<CalibrationScore> {
  const q = opts?.replay ? '?replay=synthetic' : '';
  const r = await fetch(`${BASE()}/state/calibration-score${q}`, { signal });
  if (!r.ok) throw new Error(`calibration-score ${r.status}`);
  return (await r.json()) as CalibrationScore;
}
export async function markPrediction(id: string, domain: string, mark: "false_alarm" | "correct" | "clear"): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/prediction-feedback`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, domain, mark }),
  });
  return (await r.json()) as { ok: boolean; error?: string };
}

// Open (owed) predictions — probabilistic forecasts whose review date passed but
// that have no recorded verdict yet. The calibration scorecard counts these as
// `open` but never lists them; this GET (existing python /state/forecast-owed)
// surfaces the actual rows so the panel shows the open ones instead of an empty
// list under a non-zero count.
export type ForecastOwed = { id: string; predicted: string; kind: string; confidence: number | null; track: string; eval_by: string; days_overdue: number };
/** Rows PLUS the composition of what was excluded. The scorecard's `open` tile counts every
 *  unresolved forecast, but only a subset is owed from a human — so the list can be legitimately
 *  empty under a non-zero count, and without these counts the panel had no way to say why. */
export type ForecastOwedResult = { owed: ForecastOwed[]; selfResolving: number; notDueYet: number; ok: boolean };
export async function fetchForecastOwed(signal?: AbortSignal): Promise<ForecastOwedResult> {
  const r = await fetch(`${BASE()}/state/forecast-owed`, { signal });
  // `ok: false` is load-bearing: a non-OK response used to resolve with zeros, which the caller
  // could not tell apart from a genuine "0 self-resolving, 0 not-due" and rendered as an
  // explanation it had no evidence for.
  if (!r.ok) return { owed: [], selfResolving: 0, notDueYet: 0, ok: false };
  const j = (await r.json()) as Partial<ForecastOwedResult>;
  return { owed: j.owed ?? [], selfResolving: j.selfResolving ?? 0, notDueYet: j.notDueYet ?? 0, ok: true };
}

export type StreamVerdict = { id: string; what: string; kind: string; outcome: "hit" | "miss"; ts: string };
export async function fetchStreamVerdicts(signal?: AbortSignal): Promise<StreamVerdict[]> {
  // Was `: []` — "the forecast track record is empty" is a very different claim
  // from "we could not read the forecast track record".
  const r = requireOk(await fetch(`${BASE()}/state/stream-verdicts`, { signal }), "stream-verdicts");
  return ((await r.json()) as { verdicts: StreamVerdict[] }).verdicts || [];
}
export async function nudgeStreams(text: string): Promise<{ nudged: string[] }> {
  // Was `: { nudged: [] }` — a failed nudge read as "nudged nothing", i.e. success.
  const r = requireOk(
    await fetch(`${BASE()}/state/stream-nudge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
    "stream-nudge"
  );
  return (await r.json()) as { nudged: string[] };
}
export async function runProjection(force = false): Promise<{ generated?: number; streams: Stream[] }> {
  // Was `: { streams: [] }` — a failed projection run was indistinguishable from a
  // run that legitimately projected nothing.
  const r = requireOk(
    await fetch(`${BASE()}/state/project`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) }),
    "project"
  );
  return (await r.json()) as { generated?: number; streams: Stream[] };
}
export async function actFuture(id: string, action: "engage" | "pass" | "reset" | "keep" | "delete"): Promise<void> {
  // Had no status check: `await fetch(...)` resolves for a 500 exactly as it does
  // for a 200, so a refused engage/delete returned normally and the caller
  // proceeded to update the UI as though it had landed.
  requireOk(
    await fetch(`${BASE()}/state/future-act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) }),
    "future-act"
  );
}
export async function updateStream(id: string, patch: Partial<Stream>): Promise<{ ok: boolean; stream?: Stream }> {
  const r = await fetch(`${BASE()}/state/stream-update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, patch }) });
  return r.ok ? ((await r.json()) as { ok: boolean; stream?: Stream }) : { ok: false };
}
export async function syncStream(text: string): Promise<{ ok: boolean; stream?: Stream; error?: string }> {
  const r = await fetch(`${BASE()}/state/stream-sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  return r.ok ? ((await r.json()) as { ok: boolean; stream?: Stream; error?: string }) : { ok: false, error: "request failed" };
}
export type WorldDelta = { id: string; track: string; type?: string; summary: string; change: string; affects: string; confidence: number; status: string };
export async function proposeWorldUpdate(text: string): Promise<WorldDelta | null> {
  const r = await fetch(`${BASE()}/state/world-update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  return r.ok ? ((await r.json()) as { delta: WorldDelta }).delta : null;
}
export async function actWorldUpdate(id: string, action: "confirm" | "discard" | "promote"): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/world-update-act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
  return r.ok;
}
export type PredictedRisk = { id: string; kind: string; title: string; detail: string; due: string; reason: string; leading_indicator: string; summary?: string; key?: string; track?: string; sources?: string[] };
export async function fetchPredictedRisks(signal?: AbortSignal): Promise<PredictedRisk[]> {
  const r = await fetch(`${BASE()}/state/predicted-risks`, { signal });
  if (!r.ok) throw new Error(`predicted ${r.status}`);
  return ((await r.json()) as { risks?: PredictedRisk[] }).risks ?? [];
}
export async function actRevealedRisk(id: string, action: "confirm" | "dismiss", title = ""): Promise<boolean> {
  const r = await fetch(`${BASE()}/state/revealed-risk`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, title }),
  });
  return r.ok;
}

/* ---------------- Profile: foundation files + agent configs ---------------- */
export type ProfileMe = { name: string; bio: string; work: string[]; path: string };
export type ProfileData = { foundation: ConnItem[]; agents: ConnItem[]; me?: ProfileMe };
export async function fetchProfile(signal?: AbortSignal): Promise<ProfileData> {
  const r = await fetch(`${BASE()}/state/profile`, { signal });
  if (!r.ok) throw new Error(`profile ${r.status}`);
  return (await r.json()) as ProfileData;
}

/* ---------------- Workflows: the capability layer (methods · skills · agents) ---------------- */
export type WorkflowWire = { name: string; kind: string };
export type Workflow = { name: string; desc: string; kind: string; path: string; category?: string; wires?: WorkflowWire[]; stages?: number; taskKind?: string; deliverable?: string };
export type Workflows = { methods: Workflow[]; skills: Workflow[]; agents: Workflow[] };

export async function fetchWorkflows(signal?: AbortSignal): Promise<Workflows> {
  const r = await fetch(`${BASE()}/state/workflows`, { signal });
  if (!r.ok) throw new Error(`workflows ${r.status}`);
  return (await r.json()) as Workflows;
}

// The CONSUME half of a method: resolve its wired skills + a grounded run prompt.
// The caller activates the skills and sends the prompt through the chat loop.
export type MethodRun = { name: string; deliverable: string; skillWires: string[]; prompt: string };
export async function prepareMethodRun(path: string, signal?: AbortSignal): Promise<MethodRun | null> {
  const r = await fetch(`${BASE()}/state/prepare-method-run?path=${encodeURIComponent(path)}`, { signal });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`prepare-method-run ${r.status}`);
  return (await r.json()) as MethodRun;
}

/* ---------------- Experts: the editable lens roster for the decision panel ---------------- */
export type Expert = { key: string; label: string; frame: string };
export async function fetchExperts(signal?: AbortSignal): Promise<Expert[]> {
  const r = await fetch(`${BASE()}/state/experts`, { signal });
  if (!r.ok) throw new Error(`experts ${r.status}`);
  return ((await r.json()) as { experts?: Expert[] }).experts ?? [];
}
export async function saveExperts(experts: Expert[]): Promise<Expert[]> {
  const r = await fetch(`${BASE()}/state/experts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experts }),
  });
  if (!r.ok) throw new Error(`save experts failed (${r.status})`);
  return ((await r.json()) as { experts?: Expert[] }).experts ?? experts;
}

/* ---------------- Decision connections: what a decision links to across the graph ---------------- */
export type ConnItem = { name: string; path: string };
export type DecisionConnections = Record<string, ConnItem[]>;

export async function fetchDecisionConnections(id: string, signal?: AbortSignal): Promise<DecisionConnections> {
  const r = await fetch(`${BASE()}/state/decision-connections?id=${encodeURIComponent(id)}`, { signal });
  if (!r.ok) throw new Error(`connections ${r.status}`);
  return (await r.json()) as DecisionConnections;
}

export type ProjectDetail = { name: string; desc: string; overview: string; tracks: ConnItem[]; connections: DecisionConnections };
export async function fetchProject(name: string, signal?: AbortSignal): Promise<ProjectDetail> {
  const r = await fetch(`${BASE()}/state/project?name=${encodeURIComponent(name)}`, { signal });
  if (!r.ok) throw new Error(`project ${r.status}`);
  return (await r.json()) as ProjectDetail;
}

/* ---------------- Source documents: the original markdown behind any surface ---------------- */
export async function fetchDoc(path: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE()}/state/doc?path=${encodeURIComponent(path)}`, { signal });
  if (r.status === 404) throw new Error("not found");
  if (!r.ok) throw new Error(`doc ${r.status}`);
  const data = (await r.json()) as { content?: string };
  return data.content ?? "";
}

/** Save a vault note. When the write REPLACED an existing body, the engine first copies the
 *  prior bytes to <vault>/.trash and returns that tombstone as `replaced` — callers that
 *  synthesize a path (OutputsPanel slugifies a title) should surface it, so an accidental
 *  slug collision is visible and recoverable instead of a silent obliteration. */
export async function saveDoc(path: string, content: string): Promise<{ replaced?: string }> {
  const r = await fetch(`${BASE()}/state/doc/save`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  try {
    const j = (await r.json()) as { replaced?: string };
    return { replaced: typeof j?.replaced === "string" ? j.replaced : undefined };
  } catch {
    return {};
  }
}

/** Soft-delete a vault note (engine moves it to <vault>/.trash/ — recoverable). */
export async function deleteDoc(path: string): Promise<void> {
  const r = await fetch(`${BASE()}/state/doc/delete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}

/** Retire a doc-less GRAPH node (person/org/topic/entity). Soft: the store stamps
 *  `valid_to`, so this is reversible and costs one indexed UPDATE — fast enough for
 *  the UI to treat as instant. Notes go through deleteDoc above instead. */
export async function deleteNode(id: string): Promise<void> {
  const r = await fetch(`${BASE()}/state/node/delete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`node delete failed (${r.status})`);
}

/** Resolve an Obsidian [[wikilink]] name to a vault-relative path, or null if it doesn't exist. */
export async function resolveWiki(name: string, signal?: AbortSignal): Promise<string | null> {
  const r = await fetch(`${BASE()}/state/resolve?name=${encodeURIComponent(name)}`, { signal });
  // 404 keeps its meaning: the note genuinely does not exist, and callers render
  // "no note found for [[x]]". Any other non-OK is a read failure — returning null
  // for it told the operator their note was MISSING when the brain was merely down.
  if (r.status === 404) return null;
  requireOk(r, "resolve");
  const data = (await r.json()) as { path?: string };
  return data.path ?? null;
}

/* ---------------- Backend health / config (so Settings shows the real wiring) ---------------- */
export type Health = { status: string; brain: string; dir?: string; model?: string; auto_track?: boolean };
export async function setAutoTrack(on: boolean): Promise<boolean> {
  // Was `: on` — the WORST shape in this file: a failed write returned the value
  // the caller had just asked to set, so the toggle moved and reported the new
  // state while the engine never heard the request.
  const r = requireOk(
    await fetch(`${BASE()}/state/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auto_track: on }) }),
    "config(auto_track)"
  );
  return Boolean(((await r.json()) as { auto_track?: boolean }).auto_track);
}
export async function runAutoTrack(): Promise<{ graduated: string[] }> {
  // Was `: { graduated: [] }` — a failed run reported "graduated nothing".
  const r = requireOk(await fetch(`${BASE()}/state/auto-track`, { method: "POST" }), "auto-track");
  return (await r.json()) as { graduated: string[] };
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const r = await fetch(`${BASE()}/health`, { signal });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return (await r.json()) as Health;
}

/** Pop a native OS folder dialog on the machine running the engine; returns the chosen path or "". */
export async function pickFolder(): Promise<string> {
  const r = await fetch(`${BASE()}/state/pick-folder`, { method: "POST" });
  if (!r.ok) throw new Error(`pick failed (${r.status})`);
  return ((await r.json()) as { path?: string }).path ?? "";
}

/** Re-point the engine at a new vault folder (persisted). */
export async function setVaultDir(dir: string): Promise<string> {
  const r = await fetch(`${BASE()}/state/config`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }),
  });
  if (!r.ok) throw new Error(`couldn't set folder (${r.status})`);
  return ((await r.json()) as { dir?: string }).dir ?? dir;
}

/* ---------------- People & entities: the grounding graph, fed by uploads ---------------- */
export type Entity = {
  id: string;
  name: string;
  kind: string; // "person" | "org"
  role: string;
  org: string;
  email: string;
  source: string;
  members?: string[]; // for orgs: the people linked to them
};

export async function fetchEntities(signal?: AbortSignal): Promise<Entity[]> {
  const r = await fetch(`${BASE()}/state/entities`, { signal });
  if (!r.ok) throw new Error(`entities ${r.status}`);
  const data = (await r.json()) as { entities?: Entity[] };
  return data.entities ?? [];
}

export async function addEntity(e: { name: string; kind?: string; role?: string; org?: string; email?: string }): Promise<Entity> {
  const r = await fetch(`${BASE()}/state/entities`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e),
  });
  if (!r.ok) throw new Error(`add entity failed (${r.status})`);
  return (await r.json()) as Entity;
}

/** Upload a file as grounding. parse="contacts" also extracts entities from a contact/org list. */
export async function uploadFile(file: File, parse?: "contacts"): Promise<{ stored: string; bytes: number; added: Entity[] }> {
  const q = new URLSearchParams({ filename: file.name, ...(parse ? { parse } : {}) });
  const r = await fetch(`${BASE()}/state/upload?${q}`, { method: "POST", body: file });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  return (await r.json()) as { stored: string; bytes: number; added: Entity[] };
}

/** Group decisions into monthly cadence buckets (one-way vs reversible). */
export function cadence(decisions: Decision[]) {
  const m = new Map<string, { month: string; oneWay: number; reversible: number }>();
  for (const d of decisions) {
    const mon = (d.date || "").slice(0, 7);
    if (!mon) continue;
    const e = m.get(mon) ?? { month: mon, oneWay: 0, reversible: 0 };
    if (d.oneWay) e.oneWay++;
    else e.reversible++;
    m.set(mon, e);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ── W5: claims a model retired from your notes, and your ruling on them ───────────────────────────
/** One row of the claim metabolism's corrections, annotated by the supersession guards. */
export type ClaimCorrection = {
  claimId: string;
  verdict: string;
  reason: string;
  supersededBy?: string;
  /** Did the retirement stand after the guards? */
  applied?: boolean;
  /** Why a model supersession was NOT applied. */
  blockedBy?: string;
  /** A human ruling already on the claim (`confirmed` / `reverted`). */
  reviewState?: string;
};
export type ClaimMetabolismView = {
  total: number;
  active: number;
  byVerdict: Record<string, number>;
  corrections: ClaimCorrection[];
};
/** GET /state/claim-metabolism — a shadow pass over the ledger; reading it persists nothing. */
export async function fetchClaimMetabolism(signal?: AbortSignal): Promise<ClaimMetabolismView> {
  const r = requireOk(await fetch(`${BASE()}/state/claim-metabolism`, { signal }), "claim-metabolism");
  return (await r.json()) as ClaimMetabolismView;
}
/** POST /state/claim-metabolism/resolve — the human's ruling on a retired claim: keep it retired
 *  (`confirm`) or bring it back (`revert`). Either way it is a pin that survives every later tick. */
export async function resolveClaim(claimId: string, action: "confirm" | "revert"): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE()}/state/claim-metabolism/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId, action })
  });
  return r.ok ? await r.json() : { ok: false, error: `resolve ${r.status}` };
}

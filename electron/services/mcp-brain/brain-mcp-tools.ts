// brain-mcp-tools — PURE core of the DUIN brain MCP server (Evidence Threshold · C2).
//
// C2 exposes DUIN's forecast + decision + calibration layer to any MCP client (Claude Desktop,
// Cursor, …) so an operator gets DUIN's state + a few safe writes where they already work,
// without opening the Electron app. The tool catalog + request construction + guards live here
// (no MCP transport, no fetch) so they unit-test cleanly; `brain-mcp-server.ts` is the thin
// stdio wrapper.
//
// SAFETY: (1) only the allow-listed routes below are reachable — no arbitrary passthrough;
// (2) WRITES must target a LOOPBACK brain, so a mis-set DUIN_BRAIN_URL can't silently ship the
// operator's writes to a remote id-space (the two-brain split guard from the C2 scoping);
// (3) the brain itself enforces the B1 loopback control-plane guard on the write routes.

export interface BrainTool {
  name: string
  description: string
  method: 'GET' | 'POST'
  route: string
  write: boolean
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
    additionalProperties: boolean
  }
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description })
const obj = (
  properties: Record<string, { type: string; description: string }>,
  required?: string[]
): BrainTool['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false })

/** The curated, allow-listed surface. Reads expose DUIN's state; a small set of safe writes let
 *  an MCP client capture + resolve. Routes are confirmed live on the brain (:8799). */
export const BRAIN_TOOLS: BrainTool[] = [
  { name: 'duin_decisions', description: 'List the typed decision ledger (reversibility / owner / layer / domain).', method: 'GET', route: '/state/decisions', write: false, inputSchema: obj({}) },
  { name: 'duin_style_fingerprint', description: 'The descriptive operator self-model: how you ACTUALLY decide (Wilson-gated decision-idiom histograms) + where your stated preferences diverge from your record. A mirror, never advice; silence below the sample floor is honest.', method: 'GET', route: '/state/style-fingerprint', write: false, inputSchema: obj({}) },
  { name: 'duin_projects', description: 'List projects with track + activity counts.', method: 'GET', route: '/state/projects', write: false, inputSchema: obj({}) },
  { name: 'duin_tasks', description: 'List the kanban task board (Inbox / ThisWeek / Soon / Overdue / …).', method: 'GET', route: '/state/tasks', write: false, inputSchema: obj({}) },
  { name: 'duin_forecasts', description: 'List open + resolved forecasts (graph-grounded, adjudicated).', method: 'GET', route: '/state/forecasts', write: false, inputSchema: obj({}) },
  { name: 'duin_calibration', description: 'The calibration scorecard + forecast track-record (how well-calibrated the foresight is).', method: 'GET', route: '/state/calibration', write: false, inputSchema: obj({}) },
  { name: 'duin_calibration_score', description: 'Proper scoring of the foresight: Brier, log-loss, base-rate baseline, Murphy skill score, reliability/ECE over resolved probabilistic forecasts.', method: 'GET', route: '/state/calibration-score', write: false, inputSchema: obj({}) },
  { name: 'duin_autonomy', description: 'Per-capability autonomy rung + earned trust (0..1), whether the breaker is about to trip and where to, whether the operator can re-arm it, and per-loop effective (trust-scaled) ceilings.', method: 'GET', route: '/state/autonomy', write: false, inputSchema: obj({}) },
  { name: 'duin_undo', description: 'Revert the most recent (or a specified) reversible Tier-B action from the safe-undo ledger; the capability demotion fires automatically.', method: 'POST', route: '/state/undo', write: true, inputSchema: obj({}) },
  { name: 'duin_measure_facts', description: 'Run the A/B behavioral measurement over promoted + provisional facts (persists an efficacy signal per fact; several model calls, key-gated).', method: 'POST', route: '/state/measure-facts', write: true, inputSchema: obj({}) },
  { name: 'duin_efficacy', description: 'Read the persisted measured efficacy (flip-rate / verdict) per promoted + provisional fact — no model calls.', method: 'GET', route: '/state/efficacy', write: false, inputSchema: obj({}) },
  { name: 'duin_world_state', description: 'Per-track situation rollup: open / due-soon / next-due / risks per track.', method: 'GET', route: '/state/world-state', write: false, inputSchema: obj({}) },
  { name: 'duin_insights', description: 'Generative + analytical insights (tension / inspiration) with sources + confidence.', method: 'GET', route: '/state/insights', write: false, inputSchema: obj({}) },
  { name: 'duin_capture_work', description: 'Capture a free-text work note into DUIN (structured asynchronously).', method: 'POST', route: '/state/capture-work', write: true, inputSchema: obj({ text: str('the work note to capture') }, ['text']) },
  { name: 'duin_resolve_decision', description: 'Resolve or advance an owed-decision node.', method: 'POST', route: '/state/resolve-node', write: true, inputSchema: obj({ id: str('decision node id, e.g. D1'), action: str('resolve | advance | dismiss'), note: str('optional note') }, ['id', 'action']) },
  { name: 'duin_set_decision_meta', description: 'Classify a decision: write layer (strategic|tactical) and/or domain to its frontmatter.', method: 'POST', route: '/state/decision-meta', write: true, inputSchema: obj({ id: str('decision id / filename'), layer: str('strategic | tactical'), domain: str('domain tag') }, ['id']) }
]

const BY_NAME = new Map(BRAIN_TOOLS.map((t) => [t.name, t]))
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** Default + trailing-slash-normalized brain origin. */
export function normalizeBase(base: string | undefined): string {
  return (base && base.trim() ? base : 'http://127.0.0.1:8799').replace(/\/+$/, '')
}

export interface BrainRequest {
  url: string
  method: 'GET' | 'POST'
  body?: string
}

/** Build the HTTP request for an MCP tool call. Guards: allow-listed tool only; writes must
 *  target a loopback brain; required args present; only schema-declared fields forwarded. PURE. */
export function buildBrainRequest(
  toolName: string,
  args: Record<string, unknown>,
  base: string | undefined
): BrainRequest {
  const tool = BY_NAME.get(toolName)
  if (!tool) throw new Error(`unknown tool: ${toolName}`)
  const origin = normalizeBase(base)
  if (tool.write && !LOOPBACK.test(origin)) {
    throw new Error(`refusing to write to a non-loopback brain (${origin}) — set DUIN_BRAIN_URL to a local brain`)
  }
  if (tool.method === 'GET') return { url: origin + tool.route, method: 'GET' }
  const body: Record<string, unknown> = {}
  for (const k of Object.keys(tool.inputSchema.properties)) {
    if (args[k] !== undefined) body[k] = args[k]
  }
  for (const r of tool.inputSchema.required ?? []) {
    if (body[r] === undefined || body[r] === '') throw new Error(`missing required arg: ${r}`)
  }
  return { url: origin + tool.route, method: 'POST', body: JSON.stringify(body) }
}

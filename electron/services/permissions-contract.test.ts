// permissions-contract.test.ts — the HUMAN-APPROVAL GATE, pinned against the REAL
// tool registries.
//
// WHY THIS FILE EXISTS: `descriptorNeedsApproval` is the authoritative dispatch-time
// predicate — chat.ts and tool-exec.ts both ask it whether a call must route through
// the approval service. But approval is DERIVED, not declared: a tool gates because
// of its `requiresApproval` flag OR its `risks` array OR (inversely) `selfApproves`.
// That means a one-token edit at a REGISTRATION SITE — dropping `'network'` from a
// risks array, flipping `requiresApproval` to false — silently removes the human
// gate from a tool while every existing test stays green. permissions-store.test.ts
// exercises the predicate against SYNTHETIC descriptors, so it cannot see that; the
// registry tests check names/handlers/schemas, not approval. Nothing enumerated the
// real catalogs and asked "is each of these still gated the way we decided?".
//
// This file is that contract. It imports the REAL predicate and the REAL catalogs
// (NO vi.mock anywhere — the global `electron` alias in vitest.config.ts is the
// standard load-time stub every suite runs under, not a mock of anything under
// test), enumerates getDescriptors(), and checks each tool against an EXPLICIT
// table checked in below.
//
// It fails in three directions on purpose:
//   1. a tool in a registry with NO table entry  → a NEW tool must be classified
//      DELIBERATELY, by a human, in this file. Adding a tool cannot be a silent
//      grant of ungated authority.
//   2. a tool whose verdict DISAGREES with the table → the regression this guards.
//   3. a table entry with no matching tool → a stale row, i.e. a tool vanished from
//      the catalog (a pack that threw at import looks exactly like this).
//
// HOW TO UPDATE: change a row here ONLY together with the registration-site change,
// and say in the commit message why the tool's approval posture moved. Loosening a
// row (true → false) removes a human gate — that is a security decision, not
// bookkeeping.
//
// SCOPE: native descriptors only. MCP tools are discovered at runtime and are
// classified by `classifyMcpTool` (covered by mcp-tool-classify.test.ts); they
// cannot appear in a static table and are filtered out below.

import { describe, it, expect } from 'vitest'

// Load the bundled native tool packs exactly the way production does
// (electron/ipc/index.ts imports this module for its registration side effects).
// Without it the coder catalog is only the core tools declared inside
// tool-registry.ts and this contract would silently cover a third of the surface.
import './tool-packs'

import { descriptorNeedsApproval } from './permissions-store'
import { toolRegistry, type LampreyToolDescriptor } from './tool-registry'
import { brainToolRegistry } from './local-brain/brain-tool-registry'

/** tool name → does a human have to approve this call? */
type ApprovalTable = Record<string, boolean>

// ──────────────────── CODER surface (toolRegistry + tool-packs) ────────────────────
//
// `true` = descriptorNeedsApproval() routes the call to the approval service.
// Grouped by the REASON, so a reviewer can see whether a flip is coherent.

const CODER_EXPECTED: ApprovalTable = {
  // ── Host execution / patching: declared requiresApproval. ──
  shell_command: true,
  shell_stop: true,
  apply_patch: true,
  verify_workspace: true,

  // ── Shell introspection: reads over an already-approved process. ──
  shell_monitor: false,
  shell_list: false,
  shell_output: false,

  // ── Session/UI state: no workspace or outward effect. ──
  enter_plan_mode: false,
  exit_plan_mode: false,
  mark_chapter: false,
  ask_user_question: false,
  create_document: false,
  propose_edit: false,
  update_plan: false,
  memory_add: false,

  // ── Local reads. ──
  read_file: false,
  list_dir: false,
  view_image: false,
  read_thread_terminal: false,
  load_workspace_dependencies: false,
  workspace_context: false,
  read_tool_result: false,
  skill_open: false,
  graph_report: false,
  search_notes: false,
  walk_links: false,
  time_lookup: false,

  // ── request_permissions is the ONE deliberate selfApproves tool: its handler IS
  //    the prompt. Gating it at dispatch would double-prompt, and a global
  //    "deny secret" policy would lock the user out of ever granting anything.
  //    It keeps risks:['secret'] so the UI still badges the escalation.
  //    If this row ever needs to become `true`, check selfApproves first — a
  //    SECOND tool acquiring selfApproves is how a gate gets removed quietly.
  request_permissions: false,

  // ── Goal / task bookkeeping: local durable writes, reversible. ──
  get_goal: false,
  create_goal: false,
  update_goal: false,
  transition_goal: false,
  list_task_graph: false,
  update_task_metadata: false,
  preview_delete_task: false,
  read_task: false,
  wait_tasks: false,
  // …except the irreversible one.
  delete_task: true,

  // ── Browser: reads are free, anything that ACTS on the page is gated. ──
  browser_find: false,
  browser_screenshot: false,
  browser_get_current_tab: false,
  browser_evaluate_readonly: false,
  browser_open: true,
  browser_click: true,
  browser_type: true,
  browser_click_xy: true,
  browser_key: true,
  // Pointer/scroll motion alone changes nothing durable and is not gated.
  browser_move_xy: false,
  browser_scroll_xy: false,

  // ── Network egress (risks:['network'] ⇒ gated even without requiresApproval). ──
  frontend_qa: true,
  web_search: true,
  web_open: true,
  // web_find was filed under "Local reads" with `false` until this row moved: it
  // reads a CACHED page, but on a cache miss it fetches the URL itself (via
  // executeWebOpen) — same egress as web_open, from a model-chosen URL. This is a
  // TIGHTENING (false → true): the descriptor gained the 'network' risk it always
  // performed, so the gate this table pins now fires. See web-tool-pack.ts.
  web_find: true,
  image_search: true,
  finance_quote: true,
  weather_lookup: true,
  sports_lookup: true,
  multi_agent_run: true,
  image_generate: true,
  image_edit: true,
  image_variation: true,
  generate_audio: true,
  list_mcp_resources: true,
  list_mcp_resource_templates: true,
  read_mcp_resource: true,

  // ── Outward messaging. ──
  send_message: true,
  send_email: true,
  // push/session notifications stay local to this machine.
  push_notification: false,
  send_to_session: false,

  // ── Background work scheduling: enqueues, does not itself act outward. ──
  spawn_task: false,
  schedule_wakeup: false,
  loop_enqueue: false,
  loop_complete_task: false,
  loop_control: false,

  // ── Artifact generation: writes a local file. ──
  export_artifact: false,
  generate_pdf_document: false,
  generate_docx: false,
  generate_xlsx: false,
  generate_pptx: false,

  // ── ACT external effectors (electron/services/act) — every one reaches a
  //    third-party account, so every one is gated. calendar_delete_event is
  //    additionally irreversible and carries requiresApproval outright.
  calendar_create_event: true,
  calendar_update_event: true,
  calendar_delete_event: true,
  drive_upload_file: true,
  feishu_create_doc: true,
  feishu_base_add_record: true,

  // ── External executor (electron/services/executor) — spawns another harness (dsh) as a
  //    child process in a worktree: shell access by construction. requiresApproval +
  //    sandboxBypass → prompts attended, refused unattended
  //    (PLANNING/DUIN_EXTERNAL_EXECUTOR_PLAN.md, Q1).
  delegate_task: true
}

// ──────────────────── BRAIN surface (/agui loop's own catalog) ────────────────────
//
// A SEPARATE ToolRegistry instance with deliberately divergent semantics (vault-
// jailed vs workspace-jailed), so it gets its own table. Three names exist on both
// surfaces; the cross-surface check at the bottom pins them to one verdict.

const BRAIN_EXPECTED: ApprovalTable = {
  // Vault reads.
  read_file: false,
  list_dir: false,
  search_files: false,
  glob_files: false,
  read_command: false,
  render_artifact: false,

  // Reversible vault writes.
  write_file: false,
  edit_file: false,
  create_dir: false,
  write_todos: false,
  // create_skill false→true 2026-08-22 (F5): a SKILL.md is live-loaded as an executable capability
  // outside the vault jail, so creating one authors new persistent behavior — a human gate is
  // warranted. This ADDS a gate (the safe direction), and it is also in AGUI_GATED_TOOLS so a
  // de-privileged inbound turn is denied before approval is even reached.
  create_skill: true,

  // Irreversible / relocating file operations.
  delete_file: true,
  move_file: true,

  // Host execution.
  run_command: true,
  start_command: true,
  stop_command: true,

  // Network egress.
  web_fetch: true,
  web_search: true,

  // Spawns a subagent that can itself act.
  spawn_agent: true
}

// ──────────────────── the contract ────────────────────

/** Native descriptors only — see the SCOPE note in the header. */
function nativeDescriptors(ds: LampreyToolDescriptor[]): LampreyToolDescriptor[] {
  return ds.filter((d) => d.providerKind === 'native')
}

/** name → verdict, with a hard failure on duplicate names (a duplicate would let
 *  one registration silently shadow another's classification). */
function verdicts(label: string, ds: LampreyToolDescriptor[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const d of ds) {
    expect(out.has(d.name), `${label}: duplicate tool name '${d.name}' in the catalog`).toBe(false)
    out.set(d.name, descriptorNeedsApproval(d))
  }
  return out
}

const CODER = verdicts('coder', nativeDescriptors(toolRegistry.getDescriptors()))
const BRAIN = verdicts('brain', nativeDescriptors(brainToolRegistry.getDescriptors()))

describe.each([
  ['coder (toolRegistry + tool-packs)', CODER, CODER_EXPECTED],
  ['brain (brainToolRegistry)', BRAIN, BRAIN_EXPECTED]
] as const)('descriptorNeedsApproval contract — %s', (label, actual, expected) => {
  it('is not vacuous: the catalog actually loaded', () => {
    // Without this, a registry that failed to populate would make every other
    // assertion in this block pass by enumerating nothing.
    expect(actual.size).toBeGreaterThan(10)
  })

  it('classifies EVERY registered tool — a new tool must be added to the table deliberately', () => {
    const unclassified = [...actual.keys()].filter((n) => !(n in expected)).sort()
    expect(
      unclassified,
      `${label}: tool(s) registered with no entry in this test's approval table.\n` +
        `Add each one to the table with the verdict you INTEND, in the same commit as the ` +
        `registration. A new tool must never inherit its approval posture by accident:\n  ` +
        unclassified.map((n) => `${n}: ${actual.get(n)}`).join('\n  ')
    ).toEqual([])
  })

  it('matches the checked-in approval verdict for every tool', () => {
    const drifted = [...actual.entries()]
      .filter(([n]) => n in expected)
      .filter(([n, v]) => v !== expected[n])
      .map(([n, v]) => `${n}: expected ${expected[n]}, registry now says ${v}`)
      .sort()
    expect(
      drifted,
      `${label}: the human-approval gate MOVED for the tool(s) below. If the move is ` +
        `intended, change the table row and justify it in the commit message — a true→false ` +
        `flip removes a human gate:\n  ` + drifted.join('\n  ')
    ).toEqual([])
  })

  it('has no stale table rows — a table entry with no tool means the tool vanished', () => {
    const missing = Object.keys(expected).filter((n) => !actual.has(n)).sort()
    expect(
      missing,
      `${label}: table classifies tool(s) that are no longer registered. Either the tool was ` +
        `removed (drop the row) or a tool pack threw at import and the catalog is silently ` +
        `short — which looks identical from here:\n  ` + missing.join('\n  ')
    ).toEqual([])
  })
})

describe('cross-surface agreement', () => {
  it('a tool name carried by BOTH registries has the SAME approval verdict', () => {
    // The coder loop and the brain loop are separate catalogs, and a name that gates
    // on one surface but not the other is a routing-shaped bypass: the same-named
    // capability reached through the cheaper surface skips the human.
    const shared = [...CODER.keys()].filter((n) => BRAIN.has(n)).sort()
    expect(shared.length, 'expected some overlap between the two catalogs').toBeGreaterThan(0)
    const divergent = shared
      .filter((n) => CODER.get(n) !== BRAIN.get(n))
      .map((n) => `${n}: coder=${CODER.get(n)} brain=${BRAIN.get(n)}`)
    expect(
      divergent,
      'the same tool name is gated on one surface and free on the other:\n  ' + divergent.join('\n  ')
    ).toEqual([])
  })
})

// brain-tool-registry — the /agui brain loop's tool CATALOG, as a dedicated
// instance of lamprey's mature `ToolRegistry` class (Agent-engine unification,
// Stage 1/2). Before this, `server.ts` hand-built an inline `aguiTools` array
// and dispatched through a bespoke `runOneCall` if/else plus a second divergent
// `dispatchSubagentTool` path — a parallel agent engine reimplementing the tool
// layer the coder loop already had.
//
// This gives the brain the SAME machinery the coder path uses (one registry
// class, `getDescriptors()` for the fallback parser, `getNormalizedToolsForRole`
// / `normalizeToolsForProvider` for the provider-adapted surface, one
// `executeNative` dispatch) WITHOUT sharing the coder's singleton — three tool
// ids collide with divergent semantics (read_file / list_dir are vault-jailed
// here vs workspace-jailed there; web_search args differ), so a shared singleton
// would clobber the coder chat. A dedicated instance is the same class, isolated
// catalog: genuine reuse, zero blast radius on the coder surface.
//
// Schemas are the EXACT `*_TOOL` consts the loop already authored (imported, not
// re-typed) so the model-facing tool names/params are unchanged. Handlers for
// the 16 "simple" tools delegate to `runAguiTool` (the golden-locked AGUI_TOOLS
// formatter table), so `executeNative` returns byte-identical model-facing
// strings. render_artifact / spawn_agent are catalog-only (no executeNative
// handler): they emit extra frames / spawn subagents and stay dispatched at
// their call site in server.ts, exactly as the AGUI_TOOLS comment documents.

import { ToolRegistry, type ToolRisk } from '../tool-registry'
import { runAguiTool } from './agui-tools'
import {
  WRITE_NOTE_TOOL,
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  EDIT_FILE_TOOL,
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  CREATE_DIR_TOOL,
  CREATE_SKILL_TOOL,
  SEARCH_FILES_TOOL,
  GLOB_FILES_TOOL,
  RUN_COMMAND_TOOL,
  START_COMMAND_TOOL,
  READ_COMMAND_TOOL,
  STOP_COMMAND_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_TODOS_TOOL,
  SPAWN_AGENT_TOOL,
  RENDER_ARTIFACT_TOOL
} from './agui-executors'

/** The brain loop's own tool catalog — a second instance of the coder's
 *  ToolRegistry class, not the shared singleton (see file header). */
export const brainToolRegistry = new ToolRegistry()

/** The 9 vault-jailed tools — offered on the /agui surface only when a vault
 *  is configured (server.ts filters these out when localBrainNotesDir is unset,
 *  matching the pre-registry `vaultTools` conditional exactly). */
export const VAULT_TOOL_NAMES = new Set<string>([
  'write_file', 'read_file', 'list_dir', 'edit_file', 'delete_file',
  'move_file', 'create_dir', 'search_files', 'glob_files'
])

type ToolConst = { type: 'function'; function: { name: string; description: string; parameters: unknown } }

interface BrainToolReg {
  tool: ToolConst
  risks: ToolRisk[]
  requiresApproval: boolean
  /** false → catalog-only (dispatched specially in server.ts; no executeNative). */
  simple: boolean
}

// Risk tags mirror the loop's own gate intent (resolveAguiGate is still the
// authoritative per-action gate for /agui; these tags drive descriptor-level
// classification, role filtering, and the fallback surface). `simple: true`
// tools route through runAguiTool → AGUI_TOOLS (golden-locked).
const BRAIN_TOOLS: BrainToolReg[] = [
  { tool: WRITE_NOTE_TOOL as ToolConst, risks: ['write'], requiresApproval: false, simple: true },
  { tool: READ_FILE_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: true },
  { tool: LIST_DIR_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: true },
  { tool: EDIT_FILE_TOOL as ToolConst, risks: ['write'], requiresApproval: false, simple: true },
  { tool: DELETE_FILE_TOOL as ToolConst, risks: ['destructive', 'write'], requiresApproval: true, simple: true },
  { tool: MOVE_FILE_TOOL as ToolConst, risks: ['write'], requiresApproval: true, simple: true },
  { tool: CREATE_DIR_TOOL as ToolConst, risks: ['write'], requiresApproval: false, simple: true },
  { tool: SEARCH_FILES_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: true },
  { tool: GLOB_FILES_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: true },
  { tool: RUN_COMMAND_TOOL as ToolConst, risks: ['write', 'network'], requiresApproval: true, simple: true },
  { tool: START_COMMAND_TOOL as ToolConst, risks: ['write', 'network'], requiresApproval: true, simple: true },
  { tool: READ_COMMAND_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: true },
  { tool: STOP_COMMAND_TOOL as ToolConst, risks: ['write'], requiresApproval: true, simple: true },
  { tool: WEB_FETCH_TOOL as ToolConst, risks: ['network'], requiresApproval: false, simple: true },
  { tool: WEB_SEARCH_TOOL as ToolConst, risks: ['network'], requiresApproval: false, simple: true },
  { tool: WRITE_TODOS_TOOL as ToolConst, risks: ['write'], requiresApproval: false, simple: true },
  // create_skill writes a SKILL.md into the skills dir (NOT the vault) — offered even when
  // no vault is configured, so it is deliberately absent from VAULT_TOOL_NAMES. Additive/dedup-guarded.
  // requiresApproval TRUE (2026-08-22, F5): a SKILL.md is live-loaded as an executable capability
  // outside the vault jail, so creating one is authoring new persistent behavior — the operator
  // confirms it. Also gated in AGUI_GATED_TOOLS so a de-privileged inbound turn cannot reach it.
  { tool: CREATE_SKILL_TOOL as ToolConst, risks: ['write'], requiresApproval: true, simple: true },
  // Catalog-only: dispatched at their call site in server.ts (extra frames / subagent spawn).
  // Order (spawn_agent before render_artifact) mirrors the hand-built aguiTools array so the
  // registry-sourced surface is byte-order-identical to what the model saw before.
  { tool: SPAWN_AGENT_TOOL as ToolConst, risks: ['write', 'network'], requiresApproval: true, simple: false },
  { tool: RENDER_ARTIFACT_TOOL as ToolConst, risks: ['read'], requiresApproval: false, simple: false }
]

for (const { tool, risks, requiresApproval, simple } of BRAIN_TOOLS) {
  const f = tool.function
  brainToolRegistry.registerNative(
    {
      id: f.name,
      name: f.name,
      title: f.name,
      description: f.description,
      providerKind: 'native',
      providerId: 'brain',
      inputSchema: f.parameters,
      risks,
      requiresApproval,
      enabled: true
    },
    // Simple tools get a handler that delegates to the golden-locked AGUI_TOOLS
    // formatter, so executeNative(id) returns the identical model-facing string
    // the loop already produces. notesDir/threadId map from the exec context.
    simple
      ? async (args, ctx) =>
          runAguiTool(f.name, { notesDir: ctx.workspacePath ?? '', threadId: ctx.conversationId ?? '' }, args)
      : undefined
  )
}

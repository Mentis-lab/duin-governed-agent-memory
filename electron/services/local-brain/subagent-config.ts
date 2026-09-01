// subagent-config — typed, parameterized spawn_agent (Capabilities S2). Today `spawn_agent` takes
// only `{task}` and always runs a general subagent on the parent's model at 'low' effort with the
// full toolset. This lets the model instead pick a subagent TYPE (a curated toolset + system
// prompt), a MODEL, and a REASONING EFFORT — so a "researcher" spawn is read-only, a "coder" spawn
// gets file+shell but no web, etc.
//
// PURE resolver + a small built-in type registry (no I/O), so it unit-tests directly. Every field
// is OPTIONAL: with a bare `{task}` the resolver returns today's exact defaults (full toolset, empty
// system prompt, parent model, 'low' effort, 6 rounds) — byte-identical single-level spawn until a
// caller opts in. Threading the result through runSubagent is Capabilities S3.

export type AguiToolName =
  | 'write_file' | 'read_file' | 'list_dir' | 'edit_file' | 'delete_file' | 'move_file'
  | 'create_dir' | 'search_files' | 'glob_files' | 'run_command' | 'web_fetch'

const READ_TOOLS: AguiToolName[] = ['read_file', 'list_dir', 'search_files', 'glob_files', 'web_fetch']
const FILE_TOOLS: AguiToolName[] = [
  'write_file', 'read_file', 'list_dir', 'edit_file', 'delete_file', 'move_file', 'create_dir', 'search_files', 'glob_files'
]

export interface SubagentType {
  id: string
  description: string
  /** The /agui tools this type may use. EMPTY = the full toolset (no restriction). */
  allowedTools: AguiToolName[]
  /** Prepended as a system message when this type is chosen. '' = none (today's behavior). */
  systemPrompt: string
}

// A small, curated registry. 'general' is today's default (full toolset, no system prompt).
export const BUILT_IN_SUBAGENT_TYPES: SubagentType[] = [
  { id: 'general', description: 'Full toolset — file, shell, and web. The default.', allowedTools: [], systemPrompt: '' },
  {
    id: 'researcher',
    description: 'Read-only investigation: read/search files + web fetch. No file mutation, no shell.',
    allowedTools: READ_TOOLS,
    systemPrompt:
      'You are a research subagent. Investigate the task using ONLY read-only tools and return a concise, sourced findings summary. Do not modify files or run shell commands.'
  },
  {
    id: 'coder',
    description: 'File edits + shell. No web access.',
    allowedTools: [...FILE_TOOLS, 'run_command'],
    systemPrompt:
      'You are a coding subagent. Make the requested file changes precisely and verify them with shell commands. Return a concise summary of what you changed.'
  }
]

export const SUBAGENT_TYPE_IDS: string[] = BUILT_IN_SUBAGENT_TYPES.map((t) => t.id)

export function listSubagentTypes(): SubagentType[] {
  return BUILT_IN_SUBAGENT_TYPES
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

export interface ResolvedSubagentConfig {
  modelId: string
  effort: ReasoningEffort
  systemPrompt: string
  /** Resolved allow-list; EMPTY = full toolset (the caller offers everything). */
  allowedToolNames: AguiToolName[]
  maxRounds: number
}

export interface SubagentResolveCtx {
  /** The parent turn's model — used when the caller doesn't override `model`. */
  defaultModelId: string
  defaultEffort?: ReasoningEffort
  defaultMaxRounds?: number
}

function isEffort(v: unknown): v is ReasoningEffort {
  return v === 'low' || v === 'medium' || v === 'high'
}

// Per-run minimal-toolset derivation (default-deny least-privilege). A general spawn no longer gets the
// FULL toolset by default; it starts at the READ-ONLY floor and widens ONLY to the tool classes the
// task text implies — file mutation on write/edit verbs, shell on run/build verbs. Deterministic +
// PURE (regex over the task, no state). The model can always opt UP explicitly with agent_type:'coder'
// (full file+shell). Errs toward granting on any hint so a legitimate mutation task isn't starved.
// Broad coverage of mutation/shell INTENT — an adversarial grade found a crude verb list mis-classified
// most naturally-phrased mutation tasks (rewrite/make/convert/port/set/bump/translate/reformat/document)
// to the read-only floor, starving them. Errs toward granting on a genuine hint (fail-direction here is
// capability, not safety). \b(re)?write covers write AND rewrite.
const FILE_VERBS =
  /\b((re)?write|writes|edit|edits|create|creates|delete|deletes|remove|removes|move|moves|rename|renames|save|saves|modif|fix|fixes|refactor|patch|update|updates|add|adds|implement|implements|generat|scaffold|append|insert|replace|replaces|make|convert|converts|port|ports|bump|bumps|set|translate|translates|reformat|reformats|document|documents|clean)\b/i
const SHELL_VERBS =
  /\b(run|runs|execute|executes|build|builds|test|tests|typecheck|tsc|install|installs|compil|npm|yarn|pnpm|git|command|shell|script|lint|deploy|exec|invoke|start|launch)\b/i

/** Derive the minimal /agui toolset a general `{task}` spawn needs (default-deny least-privilege).
 *  Read-only floor always; add file tools when the task implies mutation, run_command when it implies
 *  a shell op. PURE. An empty/whitespace task → read-only floor (safest). */
export function deriveToolset(task: string): AguiToolName[] {
  const t = String(task || '')
  const tools = new Set<AguiToolName>(READ_TOOLS)
  if (FILE_VERBS.test(t)) for (const f of FILE_TOOLS) tools.add(f)
  if (SHELL_VERBS.test(t)) tools.add('run_command')
  return [...tools]
}

/**
 * PURE: resolve the spawn_agent args (+ ctx) into a concrete subagent config. Tolerant — an unknown
 * agent_type or a blank model falls back to the general default. With NO optional args this returns
 * today's exact behavior: general type (full toolset, no system prompt), parent model, 'low' effort,
 * 6 rounds.
 */
export function resolveSubagentConfig(args: Record<string, unknown>, ctx: SubagentResolveCtx): ResolvedSubagentConfig {
  // Distinguish "no type requested" (→ general full-toolset default, byte-identical) from "a type was
  // REQUESTED but doesn't resolve" (a capability-MISS: typo, or a scoped type the registry lacks).
  const requested = typeof args.agent_type === 'string' && args.agent_type.trim() ? args.agent_type.trim() : null
  const type = requested ? BUILT_IN_SUBAGENT_TYPES.find((t) => t.id === requested) : undefined
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : ctx.defaultModelId
  const effort = isEffort(args.reasoning_effort) ? args.reasoning_effort : ctx.defaultEffort ?? 'low'
  // LEAST-PRIVILEGE, DEFAULT-DENY (frontier per-run minimal-toolset):
  //  - a requested type that resolves (researcher/coder) → its curated allow-list;
  //  - a requested-but-unknown type → fail-CLOSED to READ-ONLY (a miss must not escalate to full);
  //  - the GENERAL agent (explicit 'general' or a bare {task}) → a MINIMAL toolset DERIVED from the
  //    task (read-only floor, widened to file/shell only on mutation/shell hints) instead of the old
  //    blanket full toolset. The model opts UP explicitly with agent_type:'coder' for full file+shell.
  // This closes the axis's remaining gap ("general still gets full; no per-run minimal-toolset").
  const task = typeof args.task === 'string' ? args.task : ''
  const allowedToolNames: AguiToolName[] =
    type && type.id !== 'general' ? type.allowedTools : requested && !type ? READ_TOOLS : deriveToolset(task)
  return {
    modelId: model,
    effort,
    systemPrompt: type?.systemPrompt ?? '',
    allowedToolNames,
    maxRounds: ctx.defaultMaxRounds ?? 6
  }
}

/** The subagent tool CEILING — the widest set any subagent may ever call, independent of
 *  its per-run config. Lives here (pure) so the least-privilege boundary is testable
 *  without loading the electron main-process graph. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'read_file', 'list_dir', 'edit_file', 'delete_file', 'move_file', 'create_dir',
  'search_files', 'glob_files', 'run_command', 'web_fetch', 'web_search'
])

/** PURE deny-first meet of the subagent ceiling and the per-run least-privilege list.
 *  An EMPTY allow-list means "no per-run restriction" (a bare {task} spawn threads no
 *  config) and reproduces the pre-fix behaviour exactly; a non-empty one is ENFORCED at
 *  dispatch rather than merely shaping which schemas get offered. Never loosens: a name
 *  outside SUBAGENT_TOOLS is refused regardless of what the allow-list says. */
export function subagentToolAllowed(name: string, allowed: ReadonlySet<string> | readonly string[] = []): boolean {
  if (!SUBAGENT_TOOLS.has(name)) return false
  const size = allowed instanceof Set ? allowed.size : (allowed as readonly string[]).length
  if (size === 0) return true
  return allowed instanceof Set ? allowed.has(name) : (allowed as readonly string[]).includes(name)
}

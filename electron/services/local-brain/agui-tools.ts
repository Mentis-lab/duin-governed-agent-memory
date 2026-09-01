// agui-tools — the shared /agui tool dispatch registry (Architecture reconciled-plan step 1, the
// registry keystone). The tool RESULT formatting was DUPLICATED: the main brain loop's `runOneCall`
// if/else and the subagent's `dispatchSubagentTool` switch each re-implemented the same
// model-facing `out` string per tool (the panel's "registry-less duplicated dispatch" finding).
// This collapses the 16 "simple" tools (execute → result → out/end strings) onto ONE table used by
// BOTH paths, so a tool's behavior is defined once.
//
// The 3 frame/dep-heavy tools stay inline at their call sites (they don't fit a uniform spec):
// render_artifact (extra ARTIFACT frame + validateArtifact), spawn_agent (runSubagent + config),
// and MCP tools (dynamic, routed via mcpManager).
//
// `out`  = the model-facing result string (SHARED main+subagent — the duplication this kills).
// `end`  = the TOOL_CALL_END summary the main loop shows in the tool card (main-only).
// Both are PURE functions of the executor result, so the golden byte-parity test locks them exactly
// (agui-tools.golden.test.ts) — a drift would mis-render a tool card on every turn.

import {
  executeWriteNote, executeReadFile, executeListDir, executeEditFile, executeDeleteFile,
  executeMoveFile, executeCreateDir, executeSearchFiles, executeGlobFiles, executeRunCommand,
  executeWebFetch, executeWriteTodos, executeStartCommand, executeReadCommand, executeStopCommand,
  executeCreateSkill
} from './agui-executors'
import { executeAguiWebSearch } from './agui-search'
import type { EmbedFn } from '../brain/claim-entities'

/** Everything a simple-tool executor needs, uniformly. */
export interface AguiToolCtx {
  /** Vault root (writeNotesDir in the main loop; the subagent's notesDir). */
  notesDir: string
  /** Continuity id — only write_todos uses it (subagents pass ''). */
  threadId: string
  /** Turn abort signal (R3). Threaded from AguiDispatchPolicy so a tool that can
   *  stall (web_search) honors the deadline/cancel and returns instead of hanging. */
  signal?: AbortSignal
  /** F2 (bounded-context): the current turn query — the relevance signal used to bound an
   *  over-budget tool output. Absent (subagent/tests) ⇒ tools head-slice exactly as before. */
  query?: string
  /** F2: on-device embedder for relevance ranking. Only the main loop supplies it; when absent,
   *  or cold, boundToBudget falls back to today's head-slice (byte-identical). */
  embed?: EmbedFn
}

export interface AguiToolSpec {
  /** Run the tool. May be sync or async; returns the executor's result object. */
  execute: (ctx: AguiToolCtx, args: Record<string, unknown>) => unknown | Promise<unknown>
  /** Model-facing result string (shared by both dispatch paths). */
  out: (r: never) => string
  /** TOOL_CALL_END summary shown in the main loop's tool card. */
  end: (r: never) => string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any // executor result — narrowed at each definition site, `any` for the thin dispatch table
const err = (r: R): string => `Error: ${r.error}`

export const AGUI_TOOLS: Record<string, AguiToolSpec> = {
  // Same preserve+record+STAMP contract as move_file below. An overwrite of an existing
  // hand-authored note rendered byte-identically to creating a new file, so neither the model nor
  // the operator watching the tool card learned that a prior body was replaced — and the tombstone
  // name is Date.now()-stamped and flattened into .trash, so nobody who is not told can guess it.
  // This matters most on a TRUNCATED generation: a rewrite cut off at the token cap writes a partial
  // body and would otherwise report plain success.
  write_file: {
    execute: (ctx, a) => executeWriteNote(ctx.notesDir, a.path, a.content),
    out: (r: R) =>
      r.ok
        ? `Wrote file to ${r.path}` +
          (r.replaced
            ? `\nNOTE: a file already existed at ${r.path} and its previous contents were REPLACED by this write. They are preserved at ${r.replaced}. If you did not mean to discard the prior body — e.g. you rewrote a note you had only partly read, or your output was cut short — restore it from there and use edit_file for a targeted change instead.`
            : '')
        : err(r),
    end: (r: R) => (r.ok ? `Wrote file to ${r.path}${r.replaced ? ` (replaced prior contents → ${r.replaced})` : ''}` : err(r))
  },
  read_file: {
    execute: (ctx, a) => executeReadFile(ctx.notesDir, a.path, undefined, ctx.query, ctx.embed),
    out: (r: R) => (r.ok ? `${r.path}:\n${r.content}` : err(r)),
    end: (r: R) => (r.ok ? `Read ${r.path} (${r.content.length} chars)` : err(r))
  },
  list_dir: {
    execute: (ctx, a) => executeListDir(ctx.notesDir, a.path),
    out: (r: R) => (r.ok ? `${r.path}/\n${r.entries.join('\n')}` : err(r)),
    end: (r: R) => (r.ok ? `${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'} in ${r.path}` : err(r))
  },
  // Same preserve+record+STAMP contract as write_file above. edit_file's own description sells it as
  // the SAFE choice ("it never clobbers the rest"), but old_string is whatever span the model chose:
  // trimming a 300-line section with new_string="" is a byte-identical loss to a write_file
  // overwrite, and used to render as the same unqualified `Edited {path}` as a one-word typo fix.
  // The executor now snapshots the pre-edit body; say so, or nobody knows there is anything in
  // .trash to recover — the tombstone name is Date.now()-stamped and flattened, so it is unguessable.
  edit_file: {
    execute: (ctx, a) => executeEditFile(ctx.notesDir, a.path, a.old_string, a.new_string),
    out: (r: R) =>
      r.ok
        ? `Edited ${r.path}` +
          (r.replaced
            ? `\nNOTE: the file's contents BEFORE this edit are preserved at ${r.replaced}. If the edit removed more than you meant — e.g. you replaced a long hand-authored span with a short one or with nothing — restore the prior body from there.`
            : '')
        : err(r),
    end: (r: R) => (r.ok ? `Edited ${r.path}${r.replaced ? ` (prior contents → ${r.replaced})` : ''}` : err(r))
  },
  delete_file: {
    execute: (ctx, a) => executeDeleteFile(ctx.notesDir, a.path),
    out: (r: R) => (r.ok ? `Deleted ${r.path}${r.trashed ? ` (recoverable at ${r.trashed})` : ''}` : err(r)),
    end: (r: R) => (r.ok ? `Deleted ${r.path}${r.trashed ? ` → ${r.trashed}` : ''}` : err(r))
  },
  // A colliding move DISPLACES a bystander file the model never named as a target. The executor
  // tombstones it (agui-executors.executeMoveFile) — but preserve+record is only two thirds of the
  // contract: without the STAMP below, a collision rendered byte-identically to a clean move, so
  // neither the model nor the operator watching the tool card ever learned a second file existed,
  // and nobody had a reason to go look in .trash. Say it in both surfaces.
  move_file: {
    execute: (ctx, a) => executeMoveFile(ctx.notesDir, a.from, a.to),
    out: (r: R) =>
      r.ok
        ? `Moved ${r.from} → ${r.to}` +
          (r.displaced
            ? `\nNOTE: a different file already existed at ${r.to} and was displaced by this move. Its previous contents are preserved at ${r.displaced}. If that file was not meant to be replaced, restore it from there and pick another destination.`
            : '')
        : err(r),
    end: (r: R) =>
      r.ok ? `Moved ${r.from} → ${r.to}${r.displaced ? ` (displaced prior file → ${r.displaced})` : ''}` : err(r)
  },
  create_dir: {
    execute: (ctx, a) => executeCreateDir(ctx.notesDir, a.path),
    out: (r: R) => (r.ok ? `Created folder ${r.path}` : err(r)),
    end: (r: R) => (r.ok ? `Created folder ${r.path}` : err(r))
  },
  // Writes to the skills dir (outside the vault), so it takes no notesDir.
  create_skill: {
    execute: (_ctx, a) => executeCreateSkill(a.name, a.description, a.body),
    out: (r: R) => (r.ok ? `Created skill "${r.id}" → ${r.path} (now in the Skills panel)` : err(r)),
    end: (r: R) => (r.ok ? `Created skill "${r.id}" (now in the Skills panel)` : err(r))
  },
  search_files: {
    execute: (ctx, a) => executeSearchFiles(ctx.notesDir, a.query),
    // Unified to the main-loop formatting (includes the capped marker); the subagent path gains the
    // "capped" hint too — strictly more informative, and the honest signal it was already computing.
    out: (r: R) =>
      r.ok
        ? r.matches.length
          ? r.matches.join('\n') + (r.capped ? '\n[…more matches capped…]' : '')
          : 'No matches.'
        : err(r),
    end: (r: R) => (r.ok ? `${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}` : err(r))
  },
  glob_files: {
    execute: (ctx, a) => executeGlobFiles(ctx.notesDir, a.pattern),
    out: (r: R) => (r.ok ? (r.results.length ? r.results.join('\n') : 'No files match.') : err(r)),
    end: (r: R) => (r.ok ? `${r.results.length} file${r.results.length === 1 ? '' : 's'}` : err(r))
  },
  run_command: {
    execute: (ctx, a) => executeRunCommand(a.command, ctx.notesDir, undefined, ctx.query, ctx.embed),
    out: (r: R) => (r.ok ? r.output : err(r)),
    end: (r: R) => (r.ok ? `ran (${r.output.length} chars out)` : err(r))
  },
  web_fetch: {
    execute: (ctx, a) => executeWebFetch(a.url, undefined, ctx.query, ctx.embed),
    out: (r: R) => (r.ok ? `${r.url}:\n${r.content}` : err(r)),
    end: (r: R) => (r.ok ? `fetched ${r.url} (${r.content.length} chars)` : err(r))
  },
  web_search: {
    execute: (ctx, a) => executeAguiWebSearch(a.query, {}, 8_000, ctx.signal, ctx.embed),
    out: (r: R) => (r.ok ? r.results : err(r)),
    end: (r: R) => (r.ok ? `searched (${r.results.length} chars)` : err(r))
  },
  write_todos: {
    execute: (ctx, a) => executeWriteTodos(ctx.threadId, a.todos),
    out: (r: R) => (r.ok ? `Task list updated:\n${r.rendered}` : err(r)),
    end: (r: R) => (r.ok ? 'todos updated' : err(r))
  },
  start_command: {
    execute: (ctx, a) => executeStartCommand(a.command, ctx.notesDir),
    out: (r: R) =>
      r.ok
        ? `Started background command with id ${r.id}. Poll its output with read_command("${r.id}") and end it with stop_command("${r.id}").`
        : err(r),
    end: (r: R) => (r.ok ? `started ${r.id}` : err(r))
  },
  read_command: {
    execute: (_ctx, a) => executeReadCommand(a.id),
    out: (r: R) => (r.ok ? `[${r.status}]\n${r.output}` : err(r)),
    end: (r: R) => (r.ok ? r.status : err(r))
  },
  stop_command: {
    execute: (_ctx, a) => executeStopCommand(a.id),
    out: (r: R) => (r.ok ? 'Background command stopped.' : err(r)),
    end: (r: R) => (r.ok ? 'stopped' : err(r))
  }
}

/** Run a simple tool end-to-end → its model-facing `out` string (the SHARED path). */
export async function runAguiTool(name: string, ctx: AguiToolCtx, args: Record<string, unknown>): Promise<string> {
  const spec = AGUI_TOOLS[name]
  if (!spec) return `Error: tool "${name}" is not available`
  const r = await spec.execute(ctx, args)
  return spec.out(r as never)
}

export function isSimpleAguiTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGUI_TOOLS, name)
}

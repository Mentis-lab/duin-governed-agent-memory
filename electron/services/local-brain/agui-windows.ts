// agui-windows — partition a round's tool calls into execution windows so the
// brain loop can run INDEPENDENT read-only calls concurrently instead of strictly
// one-at-a-time. Mirrors the coder path's tool-call-windowing, kept self-contained
// for the brain's fixed tool set.
//
// Only side-effect-FREE reads are parallelized: their relative order is
// immaterial and they cannot race each other or a write. Everything else — vault
// mutations, host-exec, spawn_agent, todos, artifacts, background-command control
// — stays serial and ORDERED, exactly as before. Tool-result messages are always
// re-assembled in original tool_call order by the caller, regardless of which
// finished first, so provider assistant↔tool pairing is untouched. PURE.

/** The read-only tools whose calls are safe to run concurrently. A tool is here
 *  only if it neither mutates the vault/host nor depends on another call in the
 *  same round. */
export const AGUI_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'glob_files',
  'read_command',
  'web_fetch',
  'web_search'
])

/** Tools eligible to run in a concurrent window. This is the read-only set PLUS
 *  `spawn_agent`: independent sub-agents ARE the fan-out primitive, and the model
 *  emits several in one round only when it wants parallel delegation (the
 *  Claude-Code pattern). Concurrency is capped at the execution seam (see
 *  AGUI_PARALLEL_LIMIT) so a burst of spawns can't launch unbounded host shells,
 *  and results are still re-assembled in tool_call order. Subagents may write the
 *  shared vault, so this trusts the model to fan out INDEPENDENT tasks — a wrong
 *  overlap is a vault write race, bounded and git-recoverable, not a crash. */
export const AGUI_PARALLEL_TOOLS: ReadonlySet<string> = new Set([...AGUI_READONLY_TOOLS, 'spawn_agent'])

/** Max concurrent calls inside one parallel window (bounds spawn_agent fan-out +
 *  concurrent web/file reads). */
export const AGUI_PARALLEL_LIMIT = 4

export type AguiWindow = { kind: 'parallel'; indices: number[] } | { kind: 'serial'; index: number }

/**
 * Group a round's tool calls into contiguous windows. A run of adjacent
 * read-only calls becomes ONE `parallel` window; any non-read-only call is its
 * own `serial` window and breaks the run (so ordering across a write is
 * preserved). A single-entry parallel window is emitted as `serial` so the
 * caller never pays Promise.all overhead for one call.
 */
export function partitionAguiWindows(
  calls: Array<{ function?: { name?: unknown } }>,
  isParallelizable: (name: unknown) => boolean = (n) => typeof n === 'string' && AGUI_PARALLEL_TOOLS.has(n)
): AguiWindow[] {
  const windows: AguiWindow[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) windows.push({ kind: 'serial', index: run[0] })
    else windows.push({ kind: 'parallel', indices: run })
    run = []
  }
  for (let i = 0; i < calls.length; i++) {
    if (isParallelizable(calls[i]?.function?.name)) {
      run.push(i)
    } else {
      flush()
      windows.push({ kind: 'serial', index: i })
    }
  }
  flush()
  return windows
}

/**
 * Run `items` through `fn` with at most `limit` in flight at once, preserving
 * output order (result[i] corresponds to items[i]). A rejecting fn surfaces its
 * rejection (callers wrap fn to never throw). Used to cap parallel-window
 * concurrency so a burst of spawn_agent calls can't launch unbounded subagents.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

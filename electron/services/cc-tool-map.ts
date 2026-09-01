// cc-tool-map.ts — the ONE canonical Claude-Code tool-name → DUIN native tool-id
// map. Two call sites consume it: the loop executor (loop-agent.ts, mapping a
// loop's declared `allowed_tools`) and the vault-agents loader (vault-agents-
// loader.ts, mapping a `.duin/agents/*.md` agent's `tools:`). They were drifting
// as two hand-maintained copies; this is the single source of truth. Each caller
// applies its OWN capability floor (a brain loop always keeps apply_patch; a
// read-only agent floors to read_file/list_dir) — that policy stays caller-side.
//
// Names with no native equivalent (Grep, Task, NotebookEdit, mcp__*) are simply
// absent → dropped by the mapper. Already-native ids pass straight through.

export const CC_TO_NATIVE: Record<string, string> = {
  Read: 'read_file',
  read_file: 'read_file',
  LS: 'list_dir',
  Glob: 'list_dir',
  list_dir: 'list_dir',
  Write: 'apply_patch',
  Edit: 'apply_patch',
  MultiEdit: 'apply_patch',
  apply_patch: 'apply_patch',
  WebSearch: 'web_search',
  web_search: 'web_search',
  WebFetch: 'web_open',
  web_open: 'web_open',
  ImageSearch: 'image_search',
  image_search: 'image_search',
  Bash: 'shell_command',
  shell_command: 'shell_command',
  graph_report: 'graph_report'
}

/** Map a list of CC/native tool names → de-duplicated native ids (no floor). */
export function mapCcToolNames(names: readonly string[]): string[] {
  const out = new Set<string>()
  for (const n of names) {
    const native = CC_TO_NATIVE[(n ?? '').trim()]
    if (native) out.add(native)
  }
  return [...out]
}

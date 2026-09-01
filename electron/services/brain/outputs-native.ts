// outputs-native — TS port of server.py:list_outputs + parse_output. Formatted
// deliverables under <vaultRoot>/_agui_outputs (newest-first), optionally filtered by the
// decision they belong to. Pure reads. NOTE the path: paths.P.outputs_dir = _DIR/_agui_outputs
// where _DIR is the VAULT ROOT (not .duin/_state).
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

interface OutputRow {
  id: string
  title: string
  type: string
  created: string
  decision: string
}

/** Parse an output file's frontmatter into a row. Pure port of parse_output. */
export function parseOutput(text: string, filename: string): OutputRow {
  const fm: Record<string, string> = {}
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i >= 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const unq = (v: string): string => {
    const s = v.trim()
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      try {
        return JSON.parse(s) as string
      } catch {
        return s.slice(1, -1)
      }
    }
    return s
  }
  const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename
  return {
    id: fm.id ?? stem,
    title: unq(fm.title ?? '') || filename,
    type: unq(fm.type ?? 'note'),
    created: fm.created ?? '',
    decision: fm.decision ?? ''
  }
}

export function listOutputs(vaultDir: string | null, decisionId: string | null = null): { outputs: OutputRow[] } {
  if (!vaultDir) return { outputs: [] }
  const dir = join(vaultDir, '_agui_outputs')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { outputs: [] }
  }
  const rows: OutputRow[] = []
  for (const fn of names.sort().reverse()) {
    if (!fn.endsWith('.md')) continue
    let text: string
    try {
      text = readFileSync(join(dir, fn), 'utf-8').replace(/\r\n?/g, '\n')
    } catch {
      continue
    }
    const o = parseOutput(text, fn)
    if (decisionId && o.decision !== decisionId) continue
    rows.push(o)
  }
  return { outputs: rows }
}

// Native port of the .duin/routines/decision_verdict.py vault routine (shelled by
// /state/verdict). The value-visible close on a decided decision — a 3-effect write:
//   1. set `verdict:` in the decision file's frontmatter (replace, or insert before
//      tags:, or append)
//   2. prepend a dated line under `## Updates` (or create the section)
//   3. append a row to .duin/_state/decision-outcomes.jsonl (the value-digest ledger)
// Replicating all three is required — dropping any breaks the decision-quality loop.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'

const VALID = new Set(['right', 'wrong', 'partial', 'unobserved'])

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
function readNorm(fp: string): string {
  return readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
function isoToday(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** _resolve: an existing file path, else DUIN/Decisions/<arg>.md, else the first
 *  *.md in DUIN/Decisions whose stem == arg (or contains arg). */
function resolveDecision(vault: string, arg: string): string | null {
  const decisionsDir = join(vault, 'DUIN', 'Decisions')
  if (isFile(arg)) return arg
  const cand = join(decisionsDir, arg.endsWith('.md') ? arg : arg + '.md')
  if (isFile(cand)) return cand
  let files: string[]
  try {
    files = readdirSync(decisionsDir).filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }
  for (const f of files) {
    const stem = f.slice(0, -3)
    if (stem === arg || (arg && stem.includes(arg))) return join(decisionsDir, f)
  }
  return null
}

function field(fm: string, key: string): string {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)
  return m ? m[1].trim() : ''
}

export interface VerdictResult {
  ok: boolean
  msg?: string
  error?: string
}

/** Port of decision_verdict.py::record. */
export function recordVerdict(vaultDir: string, arg: string, verdict: string, note: string, now: Date = new Date()): VerdictResult {
  verdict = verdict.trim().toLowerCase()
  if (!VALID.has(verdict)) return { ok: false, error: `verdict must be one of ${[...VALID].sort().join(',')}` }
  const f = resolveDecision(vaultDir, arg)
  if (!f) return { ok: false, error: `decision not found: ${arg}` }
  const text = readNorm(f)
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) return { ok: false, error: `no frontmatter: ${f.split(/[\\/]/).pop()}` }
  let fm = m[1]
  let body = m[2]
  const today = isoToday(now)

  // 1. verdict in frontmatter
  if (/^verdict:.*$/m.test(fm)) {
    fm = fm.replace(/^verdict:.*$/m, `verdict: ${verdict}`)
  } else if (/^tags:.*$/m.test(fm)) {
    fm = fm.replace(/^(tags:.*)$/m, `verdict: ${verdict}\n$1`)
  } else {
    fm = fm.replace(/\s+$/, '') + `\nverdict: ${verdict}`
  }

  // 2. newest-first under ## Updates
  const upd = `- ${today} — verdict: **${verdict}** — ${note}`
  if (/^## Updates[^\n]*$/m.test(body)) {
    body = body.replace(/(^## Updates[^\n]*\n(?:<!--[\s\S]*?-->\n)?)/m, `$1${upd}\n`)
  } else {
    body = body.replace(/\s+$/, '') + `\n\n## Updates\n${upd}\n`
  }

  writeFileSync(f, `---\n${fm}\n---\n${body}`, 'utf-8')

  // 3. append to the aggregation ledger
  const h1 = /^#\s+(.+)$/m.exec(body)
  const stem = (f.split(/[\\/]/).pop() as string).slice(0, -3)
  const row = {
    ts: today,
    id: stem,
    title: h1 ? h1[1].trim() : stem,
    surfaced_by: field(fm, 'surfaced_by') || 'self',
    reversibility: field(fm, 'reversibility'),
    review_on: field(fm, 'review_on'),
    verdict,
    note
  }
  const ledger = join(vaultDir, '.duin', '_state', 'decision-outcomes.jsonl')
  mkdirSync(dirname(ledger), { recursive: true })
  // Python json.dumps default separators (", ", ": ") so native rows match sidecar rows.
  const pyDumps = (o: Record<string, unknown>): string =>
    '{' + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}'
  appendFileSync(ledger, pyDumps(row) + '\n', 'utf-8')
  return { ok: true, msg: `✓ ${stem}: verdict=${verdict} → frontmatter + ## Updates + decision-outcomes.jsonl` }
}

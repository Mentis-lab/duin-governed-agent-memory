// make_decision (native) — record a real decision in the decision pillar (per 09 Rules/decisions.md
// headings) AND close the originating open-loop node, then stage the decision's cascade (what streams
// it affects). Port of make_decision (server.py:4262).
//
// Mostly deterministic: writes the decision .md + resolveNode (reused from decision-write-native) +
// fires runCascadeDecision (background). NB: Python also calls schedule_recompute([...]) — a debounced
// trigger that fires PYTHON harness routines + clears a Python read-cache. Per the established native
// precedent (decision-write-native's own comment), the native path deliberately does NOT fire it: the
// routines run on their own cadence and the in-process native reads are live (no cache to drop).

import { writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { resolveNode } from './decision-write-native'
import { runCascadeDecision } from './cascade-creators-native'
import { type GenerateFn } from './cascade-native'

const DECISION_PILLARS = ['DUIN/Decisions', '05 Decisions']

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
/** The decisions pillar dir (relative segment + absolute): first existing candidate, else the first. */
function decisionsPillar(base: string): { rel: string; abs: string } {
  const rel = DECISION_PILLARS.find((c) => isDir(join(base, ...c.split('/')))) ?? DECISION_PILLARS[0]
  return { rel, abs: join(base, ...rel.split('/')) }
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDaysIso(d: Date, days: number): string {
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

export interface MakeDecisionArgs {
  node_id?: string
  title: string
  the_call?: string
  rationale?: string
  reversibility?: string
  layer?: string
  domain?: string
  consequences?: string
}

export interface MakeDecisionResult {
  ok: boolean
  error?: string
  path?: string
  id?: string
  nodeClosed?: boolean
}

export interface MakeDecisionDeps {
  generate: GenerateFn
  today?: () => Date
}

/** Build the decision note markdown — verbatim structure from server.py:4283-4297. Exported for diffing. */
export function buildDecisionNote(args: MakeDecisionArgs, todayIso: string, reviewIso: string): string {
  const reversibility = args.reversibility || 'reversible'
  const fm = [
    '---', 'type: decision', `date: ${todayIso}`, 'status: decided',
    `reversibility: ${reversibility}`, 'owner: operator', `review_on: ${reviewIso}`,
    'supersedes:', 'superseded_by:', 'method:', 'tags: [decision]'
  ]
  if (args.layer) fm.push(`layer: ${args.layer}`)
  if (args.domain) fm.push(`domain: ${args.domain}`)
  fm.push('---')
  const body = [
    `# ${args.title}`, '', '## Decision', '', (args.the_call ?? '').trim() || args.title, '',
    '## Rationale', '', (args.rationale ?? '').trim() || '_(recorded from the DUIN workspace)_', '',
    '## Consequences / watch for', '', (args.consequences ?? '').trim() || '_(to monitor at review)_', ''
  ]
  if (args.node_id) {
    body.push('## 关联文档', '', '### 来源', `- closes open-loop node ${args.node_id} (resolved via DUIN)`, '')
  }
  return [...fm, '', ...body].join('\n')
}

/**
 * Record a decision + close its originating loop node + stage the decision cascade. Port of
 * make_decision. Writes to <decisions-pillar>/<date>-<slug>.md (disambiguated), reuses resolveNode,
 * fires runCascadeDecision fire-and-forget. Does NOT fire schedule_recompute (native precedent).
 */
export function makeDecision(base: string | null, args: MakeDecisionArgs, deps: MakeDecisionDeps): MakeDecisionResult {
  if (!args.title || !args.title.trim()) return { ok: false, error: 'title required' }
  if (!base) return { ok: false, error: 'no vault' }

  const { rel, abs } = decisionsPillar(base)
  mkdirSync(abs, { recursive: true })
  const today = (deps.today ?? (() => new Date()))()
  const todayIso = isoDate(today)
  const slug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'decision'
  let fn = `${todayIso}-${slug}.md`
  let n = 2
  while (isFileAt(join(abs, fn))) {
    fn = `${todayIso}-${slug}-${n}.md`
    n += 1
  }
  const reviewIso = addDaysIso(today, 30)
  const content = buildDecisionNote(args, todayIso, reviewIso)
  writeFileSync(join(abs, fn), content, 'utf-8')

  const id = fn.slice(0, -3)
  const closed = args.node_id
    ? resolveNode(base, args.node_id, 'resolve', `decided → [[${id}]]`).ok
    : false
  // Fire the decision cascade in the background (never blocks the response).
  void runCascadeDecision(base, { id, title: args.title, call: args.the_call, rationale: args.rationale }, { generate: deps.generate })

  return { ok: true, path: `${rel}/${fn}`, id, nodeClosed: closed }
}

function isFileAt(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

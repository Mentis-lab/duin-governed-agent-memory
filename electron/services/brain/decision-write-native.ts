// decision-write-native — operator writes into the decision pillar: setDecisionMeta
// (classify a decision's layer/domain in its frontmatter) + resolveNode (close/advance an
// owed-decision loop node in _Owed-Decisions.md). Ports set_decision_meta + resolve_node
// from server.py. Pure fs + regex (no model/subprocess). This cluster owns the decision
// notes' frontmatter and the _Owed-Decisions.md register.
//
// DEFERRED side effect (documented, matches prior native-write precedent): resolve_node's
// schedule_recompute(['owed-decisions-detector','dashboard_feed']) is not fired from TS —
// those routines run on cadence, so the write lands and derived views refresh next tick.
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { messageOf } from '../guarded'

const DECISION_PILLARS = ['DUIN/Decisions', '05 Decisions']
const DISCOVER_SKIP = new Set([
  '.duin', '.obsidian', '.git', '.smart-env', '.brain', '.trash', '.codex',
  'node_modules', '__pycache__', '.venv', 'dist', 'dist2', 'build', 'out',
  '_agui_outputs', '_agui_uploads', 'even-g2-companion', '99 Attachments'
])
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// Python reads text-mode (universal newlines → \n) then writes newline='\n'. Match both.
function readText(fp: string): string {
  return readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n')
}
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

function pillarPath(base: string, ...parts: string[]): string {
  for (const c of DECISION_PILLARS) {
    const full = join(base, ...c.split('/'))
    try {
      if (statSync(full).isDirectory()) return join(full, ...parts)
    } catch (e) { console.debug('[decision-write-native] not this candidate:', messageOf(e)) }
  }
  return join(base, ...DECISION_PILLARS[0].split('/'), ...parts)
}

// Find a .md file by exact basename anywhere in the vault (skipping framework dirs). Port of
// the `next(path for path, fn in _iter_md(...) if fn == target)` fallback.
function findByBasename(base: string, target: string): string {
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (DISCOVER_SKIP.has(e.name) || e.name.startsWith('.')) continue
        stack.push(join(dir, e.name))
      } else if (e.name === target) {
        return join(dir, e.name)
      }
    }
  }
  return ''
}

/** Set/replace a frontmatter scalar field (create the block if absent). Port of _set_fm_field. */
export function setFmField(text: string, key: string, value: string): string {
  const m = /^---\n(.*?)\n---\n?(.*)$/s.exec(text)
  if (!m) return `---\n${key}: ${value}\n---\n\n${text}`
  let fm = m[1]
  const body = m[2]
  const k = escRe(key)
  if (new RegExp(`^${k}:.*$`, 'm').test(fm)) {
    fm = fm.replace(new RegExp(`^${k}:.*$`, 'm'), `${key}: ${value}`)
  } else {
    fm = fm.replace(/\n+$/, '') + `\n${key}: ${value}`
  }
  return `---\n${fm}\n---\n${body}`
}

/** Classify a decision: write layer and/or domain to its frontmatter. Port of set_decision_meta.
 *  layer/domain: pass the value to set it, or null/undefined to leave it untouched. */
export function setDecisionMeta(
  base: string | null,
  decisionId: string,
  layer?: string | null,
  domain?: string | null
): boolean {
  if (!base || !decisionId) return false
  let p = pillarPath(base, decisionId)
  if (!isFile(p)) {
    const target = decisionId.endsWith('.md') ? decisionId : `${decisionId}.md`
    p = findByBasename(base, target)
  }
  if (!p || !isFile(p)) return false
  let text: string
  try {
    text = readText(p)
  } catch {
    return false
  }
  if (layer !== undefined && layer !== null) text = setFmField(text, 'layer', layer)
  if (domain !== undefined && domain !== null) text = setFmField(text, 'domain', domain)
  atomicWrite(p, text)
  return true
}

export interface ResolveNodeResult {
  ok: boolean
  error?: string
  id?: string
  action?: string
}

/** Close (resolve/archive → audit trail) or advance an owed-decision loop node in the
 *  _Owed-Decisions.md register. Non-destructive. Port of resolve_node.
 *  `today` is injectable for testing (Python uses date.today()). */
export function resolveNode(
  base: string | null,
  nodeId: string,
  action: string,
  note = '',
  today: Date = new Date()
): ResolveNodeResult {
  if (!base) return { ok: false, error: 'register or id missing' }
  const reg = pillarPath(base, '_Owed-Decisions.md')
  if (!isFile(reg) || !nodeId) return { ok: false, error: 'register or id missing' }
  let text = readText(reg)
  const id = escRe(nodeId)
  // Python uses \Z (string-end only) in the lookahead; JS has no \Z and `$` under /m matches
  // at EVERY line end, which would truncate a multi-line node block to its first line. Use
  // (?![\s\S]) = true end-of-string, which /m does not affect. (/m still needed for the leading ^.)
  const blockRe = new RegExp(`^- \\*\\*${id}\\s*[·.].*?(?=\\n- \\*\\*|\\n## |(?![\\s\\S]))`, 'ms')
  const m = blockRe.exec(text)
  if (!m) return { ok: false, error: `${nodeId} not in register` }
  const block = m[0]
  const tm = new RegExp(`^- \\*\\*${id}\\s*[·.]\\s*(.+?)\\*\\*`).exec(block)
  const title = tm ? tm[1].trim() : nodeId
  const day = today.toISOString().slice(0, 10)
  const mStart = m.index
  const mEnd = m.index + block.length

  if (action === 'resolve' || action === 'archive') {
    const verb = action === 'resolve' ? 'resolved' : 'archived'
    const line = `- ${day} · **${nodeId}** (${title}) → ${verb}` + (note.trim() ? `: ${note.trim()}` : '')
    text = (text.slice(0, mStart) + text.slice(mEnd)).replace(/\n+$/, '') + '\n'
    const gm = /^## ✅ Graduated.*$/m.exec(text)
    if (gm) {
      const gEnd = gm.index + gm[0].length
      text = text.slice(0, gEnd) + '\n' + line + text.slice(gEnd)
    } else {
      text = text.replace(/\s+$/, '') + '\n\n## ✅ Graduated / resolved (audit trail)\n' + line + '\n'
    }
  } else if (action === 'advance') {
    const nxt: Record<string, string> = {
      open: 'mitigated',
      'to-make': 'made-not-executed',
      'made-not-executed': 'executed',
      stated: 'in-progress'
    }
    const newBlock = block.replace(/`([^`]+)`/, (_full, g1: string) => '`' + (nxt[g1.trim()] ?? g1) + '`')
    text = text.slice(0, mStart) + newBlock + text.slice(mEnd)
  } else {
    return { ok: false, error: `unknown action ${action}` }
  }

  text = text.replace(/\n{3,}/g, '\n\n')
  atomicWrite(reg, text)
  return { ok: true, id: nodeId, action }
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

export interface MakeDecisionInput {
  nodeId?: string
  title: string
  call?: string
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

/** Record a real decision note in the decisions pillar (per 09 Rules/decisions.md headings) and
 *  close the originating open-loop node. Port of make_decision — the DETERMINISTIC core (note write
 *  + node close via resolveNode). DEFERRED: schedule_recompute (cadence) and cascade_decision (the
 *  model-backed "propose what's affected → stage" — a separate follow-on port). `today` injectable. */
export function makeDecision(base: string | null, input: MakeDecisionInput, today: Date = new Date()): MakeDecisionResult {
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'title required' }
  if (!base) return { ok: false, error: 'title required' }
  const dd = pillarPath(base)
  const ddRel = relative(base, dd).split(sep).join('/')
  mkdirSync(dd, { recursive: true })
  const day = isoDay(today)
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'decision'
  let fn = `${day}-${slug}.md`
  let n = 2
  while (statExists(join(dd, fn))) {
    fn = `${day}-${slug}-${n}.md`
    n += 1
  }
  const review = isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + 30 * 86400000))
  const reversibility = input.reversibility || 'reversible'
  const fm = ['---', 'type: decision', `date: ${day}`, 'status: decided', `reversibility: ${reversibility}`, 'owner: operator', `review_on: ${review}`, 'supersedes:', 'superseded_by:', 'method:', 'tags: [decision]']
  if (input.layer) fm.push(`layer: ${input.layer}`)
  if (input.domain) fm.push(`domain: ${input.domain}`)
  fm.push('---')
  const call = (input.call || '').trim()
  const rationale = (input.rationale || '').trim()
  const consequences = (input.consequences || '').trim()
  const body = ['# ' + title, '', '## Decision', '', call || title, '', '## Rationale', '', rationale || '_(recorded from the DUIN workspace)_', '', '## Consequences / watch for', '', consequences || '_(to monitor at review)_', '']
  if (input.nodeId) body.push('## 关联文档', '', '### 来源', `- closes open-loop node ${input.nodeId} (resolved via DUIN)`, '')
  atomicWrite(join(dd, fn), [...fm, '', ...body].join('\n'))
  const id = fn.slice(0, -3)
  const closed = input.nodeId ? resolveNode(base, input.nodeId, 'resolve', `decided → [[${id}]]`, today).ok : false
  return { ok: true, path: `${ddRel}/${fn}`, id, nodeClosed: closed }
}

function statExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

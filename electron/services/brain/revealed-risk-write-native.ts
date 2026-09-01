// act_revealed_risk / auto_track_risks (native) — graduate a revealed risk into the register (or
// dismiss/suppress it), and the opt-in veto model that auto-graduates the highest-confidence ones.
// Ports of act_revealed_risk (server.py:603) + auto_track_risks (655) + _risk_edges (556) +
// _risk_summary (584). Deterministic (no model) — writes the risk register + suppress list.

import { readFileSync, writeFileSync, renameSync, statSync } from 'fs'
import { join, relative } from 'path'
import { locateTask } from './task-write-native'
import { parseTaskLine } from './causal-substrate'
import { trackOf } from './predicted-risks-native'
import { revealedRisks } from './world-state-native'
import { messageOf } from '../guarded'
import { hasCjk } from './cjk-tokens'

const DECISION_PILLARS = ['DUIN/Decisions', '05 Decisions']
const suppressPath = (v: string): string => join(v, '_agui_suppressed_risks.json')
const predLedgerPath = (v: string): string => join(v, '.duin', '_state', 'risk-predictions.jsonl')
const futuresPath = (v: string): string => join(v, '.duin', '_state', 'future-nodes.jsonl')

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
function decisionRegister(base: string): string {
  const rel = DECISION_PILLARS.find((c) => isDir(join(base, ...c.split('/')))) ?? DECISION_PILLARS[0]
  return join(base, ...rel.split('/'), '_Owed-Decisions.md')
}
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}
function loadFutureNodes(v: string): Record<string, unknown>[] {
  try {
    return readFileSync(futuresPath(v), 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    }).filter((x): x is Record<string, unknown> => x !== null)
  } catch {
    return []
  }
}

export function suppressedRisks(v: string): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(suppressPath(v), 'utf-8')) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}
function saveSuppressed(v: string, set: Set<string>): void {
  writeFileSync(suppressPath(v), JSON.stringify([...set].sort()), 'utf-8')
}

/** Derive (track, caused-by refs, born-of) provenance for a graduating risk. Port of _risk_edges. */
export function riskEdges(v: string, taskId: string): { track: string; drivers: string[]; born: string } {
  try {
    const txt = readFileSync(predLedgerPath(v), 'utf-8')
    for (const ln of txt.split(/\r?\n/)) {
      if (!ln.trim()) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(ln) as Record<string, unknown>
      } catch {
        continue
      }
      if (row.id === taskId) {
        const refs = ((row.sources as string[]) ?? []).map((s) => `[[${s}]]`)
        const by = ((row.eval_after as Record<string, unknown>)?.by as string) ?? ''
        const tv = ((row.trigger_signature as Record<string, unknown>)?.value as string) ?? ''
        return { track: String(row.track ?? ''), drivers: refs, born: `predicted · ${tv} ${by}`.trim() }
      }
    }
  } catch (e) { console.debug('[revealed-risk-write-native] no ledger:', messageOf(e)) }
  const loc = locateTask(v, taskId)
  if (loc) {
    const rel = relative(v, loc.fp).replace(/\\/g, '/')
    const t = parseTaskLine(loc.lines[loc.idx], rel, loc.idx)
    const track = t ? trackOf(`${t.text} ${t.tags.join(' ')} ${t.project}`) : ''
    return { track: track || '', drivers: [`[[${rel}]]`], born: 'revealed · detector scan' }
  }
  return { track: '', drivers: [], born: 'DUIN draft' }
}

/** Plain-language stakes for a graduating risk (decision-window risks sourced from the stream).
 *  Port of _risk_summary. */
export function riskSummary(v: string, taskId: string): string {
  const tid = String(taskId)
  if (tid.startsWith('decide::')) {
    const sid = tid.slice('decide::'.length)
    for (const s of loadFutureNodes(v)) {
      if (s.id !== sid) continue
      const what = String(s.objective || s.decision || '').trim()
      const tgt = s.target || '?'
      const dby = s.decide_by || '?'
      // Detect via the tokenizer's own CJK test (kanji + KANA): the bare ideograph range
      // read a kana objective as Latin and handed it the English stakes sentence.
      const cjk = hasCjk(what)
      const stake = cjk ? `须在 ${dby} 前决定，否则目标 ${tgt} 延期。` : `Decide by ${dby}, or the ${tgt} target slips.`
      return what ? `${what} ${stake}`.trim().slice(0, 340) : stake
    }
  }
  return ''
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface ActRevealedRiskResult {
  ok: boolean
  error?: string
  id?: string
}

/** confirm → append a provenance-tagged risk node to _Owed-Decisions.md (graduate); dismiss →
 *  suppress so it stops showing. Port of act_revealed_risk. */
export function actRevealedRisk(v: string, taskId: string, action: string, title = '', today: Date = new Date()): ActRevealedRiskResult {
  if (!taskId) return { ok: false, error: 'id required' }
  if (action === 'dismiss') {
    const sup = suppressedRisks(v)
    sup.add(taskId)
    saveSuppressed(v, sup)
    return { ok: true }
  }
  if (action === 'confirm') {
    const reg = decisionRegister(v)
    if (!isFile(reg)) return { ok: false, error: 'register not found' }
    let text = readFileSync(reg, 'utf-8')
    const nums = [...text.matchAll(/\*\*R(\d+)\b/g)].map((m) => parseInt(m[1], 10))
    const rid = `R${nums.length ? Math.max(...nums) + 1 : 1}`
    const { track, drivers, born } = riskEdges(v, taskId)
    const edges: string[] = []
    if (track) edges.push(`\`affects\` → ${track}`)
    if (drivers.length) edges.push('`caused-by` → ' + drivers.join(', '))
    if (born) edges.push(`\`born-of\` → ${born}`)
    const provenance = /^(collision::|decide::|slip::)/.test(taskId) ? 'predicted' : 'revealed'
    const desc = riskSummary(v, taskId)
    const provLine = [...edges, `confirmed ${isoDate(today)}`].join(' · ')
    const bullet =
      `- **${rid} · ${title.trim().slice(0, 90)}** — \`open\` · \`${provenance}\`\n` +
      (desc ? `  - ${desc}\n` : '') +
      `  - ${provLine}\n`
    const m = /^##\s*⚠️\s*Risks\s*$/m.exec(text)
    if (m) {
      // When the header is the final line (no trailing newline) indexOf returns -1;
      // append after the header instead of prepending to the top of the file.
      const nl = text.indexOf('\n', m.index + m[0].length)
      const insert = nl < 0 ? text.length : nl + 1
      const lead = nl < 0 ? '\n' : ''
      text = text.slice(0, insert) + lead + bullet + text.slice(insert)
    } else {
      text = text.replace(/\s+$/, '') + '\n\n## ⚠️ Risks\n' + bullet
    }
    atomicWrite(reg, text)
    const sup = suppressedRisks(v)
    sup.add(taskId)
    saveSuppressed(v, sup)
    return { ok: true, id: rid }
  }
  return { ok: false, error: 'unknown action' }
}

export interface AutoTrackResult {
  ok: boolean
  enabled: boolean
  graduated: string[]
}

/** Opt-in veto model: auto-graduate the highest-confidence (≥0.85) revealed risks into the register,
 *  capped at 3. Port of auto_track_risks. */
export function autoTrackRisks(v: string, deps: { autoTrack: boolean; today?: () => Date }): AutoTrackResult {
  if (!deps.autoTrack) return { ok: true, enabled: false, graduated: [] }
  const today = (deps.today ?? (() => new Date()))()
  const risks = revealedRisks(v, today).risks as Array<{ id: string; title: string; confidence?: number; summary?: string }>
  const high = risks.filter((r) => (r.confidence ?? 0) >= 0.85).slice(0, 3)
  const graduated: string[] = []
  for (const r of high) {
    const res = actRevealedRisk(v, r.id, 'confirm', r.summary || r.title, today)
    if (res.ok && res.id) graduated.push(res.id)
  }
  return { ok: true, enabled: true, graduated }
}

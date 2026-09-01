// Native port of Python `anchors()` (server.py) — the branch/converge view.
// Anchors (event|milestone declared as `(C) anchor-*.md`) with fanned-in task
// branches, a back-propagated critical path, a rolled-up risk, and DECLARED
// cross-anchor convergence (shared resource/dependency/membership — NEVER date
// proximity). Read-only over tasks; reuses the causal-substrate loaders.
//
// SKIPPED side effect (per unification §2): Python calls _log_anchor_predictions()
// to append forward-dated predictions to the calibration ledger — that write does
// not affect the response body, so the pure read is parity-faithful.
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { readAnchorDecls, gatherTasks, anchorBinds, anchorBranch, shortItem, type Task, type AnchorDecl } from './causal-substrate'

interface Branch {
  branch: string
  items: number
  overdue: number
  p1_overdue: number
  soonest_due: string | null
  open_ids: string[]
  state?: string
}
interface CritItem {
  id: string
  text: string
  due: string
  slack_days: number | null
  priority: string
  branch: string
}
interface AnchorOut {
  id: string
  name: string
  kind: string
  track: string
  date: string
  window_end: string
  immovable: boolean
  days_out: number | null
  attendees: string[]
  depends_on: string[]
  confidential: boolean
  doc: string
  risk: string
  branch_count: number
  item_count: number
  branches: Branch[]
  critical_path: CritItem[]
}
export interface AnchorsResponse {
  anchors: AnchorOut[]
  convergence: unknown[]
  generated?: string
  note?: string
  invariant?: string
}

/** UTC-midnight of `t`'s LOCAL day — mirrors Python `date.today()`. */
function todayUTC(t: Date): Date {
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))
}
/** Strict YYYY-MM-DD → UTC Date, else null. Mirrors date.fromisoformat + its ValueError→None guard. */
function ymd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}
const days = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 86400000)
const iso = (d: Date): string => d.toISOString().slice(0, 10)
const ORD = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const STATE_RANK: Record<string, number> = { red: 0, amber: 1, green: 2 }

/** Faithful port of server.py:anchors(). Pure fs (skips the ledger-log side effect). */
export function anchors(vaultDir: string | null, now: Date = new Date()): AnchorsResponse {
  const today = todayUTC(now)
  const decls: AnchorDecl[] = readAnchorDecls(vaultDir)
  if (!decls.length) return { anchors: [], convergence: [], note: 'no (C) anchor-*.md declarations found' }

  const items: Task[] = gatherTasks(vaultDir, today)
  const membership = new Map<string, Set<string>>()
  const outAnchors: AnchorOut[] = []

  for (const a of decls) {
    const bound: Task[] = []
    for (const t of items) {
      if (anchorBinds(t, a)) {
        bound.push(t)
        let ms = membership.get(t.id)
        if (!ms) {
          ms = new Set()
          membership.set(t.id, ms)
        }
        ms.add(a.id)
      }
    }
    const aDate = ymd(a.date)
    const branches = new Map<string, Branch>()
    for (const t of bound) {
      const bk = anchorBranch(t.contexts, t.tags, a)
      const d = ymd(t.due)
      let br = branches.get(bk)
      if (!br) {
        br = { branch: bk, items: 0, overdue: 0, p1_overdue: 0, soonest_due: null, open_ids: [] }
        branches.set(bk, br)
      }
      br.items += 1
      br.open_ids.push(t.id)
      if (d && d < today) {
        br.overdue += 1
        if (String(t.priority) === '1') br.p1_overdue += 1
      }
      if (d && (br.soonest_due === null || iso(d) < br.soonest_due)) br.soonest_due = iso(d)
    }
    for (const br of branches.values()) br.state = br.p1_overdue ? 'red' : br.overdue ? 'amber' : 'green'
    let worst = 'green'
    for (const br of branches.values()) {
      if (br.state === 'red') {
        worst = 'red'
        break
      }
      if (br.state === 'amber') worst = 'amber'
    }
    const crit: CritItem[] = bound
      .slice()
      .sort((x, y) => ORD(x.due || '~', y.due || '~'))
      .map((t) => {
        const d = ymd(t.due)
        return {
          id: t.id,
          text: shortItem(t.text),
          due: t.due || '',
          slack_days: d ? days(d, today) : null,
          priority: t.priority || '',
          branch: anchorBranch(t.contexts, t.tags, a),
        }
      })
    outAnchors.push({
      id: a.id,
      name: a.name,
      kind: a.kind,
      track: a.track,
      date: a.date,
      window_end: a.window_end,
      immovable: a.immovable,
      days_out: aDate ? days(aDate, today) : null,
      attendees: a.attendees,
      depends_on: a.depends_on,
      confidential: a.confidential,
      doc: a.doc,
      risk: worst,
      branch_count: branches.size,
      item_count: bound.length,
      branches: [...branches.values()].sort((x, y) => STATE_RANK[x.state!] - STATE_RANK[y.state!]),
      critical_path: crit.slice(0, 12),
    })
  }

  const conv: unknown[] = []
  const pub = outAnchors.filter((a) => !a.confidential) // confidential anchors never enter a shared node
  for (let i = 0; i < pub.length; i++) {
    for (let j = i + 1; j < pub.length; j++) {
      const A = pub[i]
      const B = pub[j]
      const bAtt = new Set(B.attendees)
      const bDep = new Set(B.depends_on)
      const res = [...new Set(A.attendees.filter((x) => bAtt.has(x)))].sort(ORD)
      const dep = [...new Set(A.depends_on.filter((x) => bDep.has(x)))].sort(ORD)
      const mem = [...membership.entries()]
        .filter(([, s]) => s.has(A.id) && s.has(B.id))
        .map(([k]) => k)
        .sort(ORD)
      if (res.length || dep.length || mem.length) {
        conv.push({
          anchors: [A.id, B.id],
          names: [A.name, B.name],
          shared_resource: res,
          shared_dependency: dep,
          shared_membership_count: mem.length,
          shared_membership_ids: mem.slice(0, 12),
          note: 'convergence on a DECLARED shared axis (not date proximity)',
        })
      }
    }
  }

  return {
    anchors: outAnchors,
    convergence: conv,
    generated: iso(today),
    invariant: 'bind by declared anchor/dependency/resource; never by date proximity',
  }
}

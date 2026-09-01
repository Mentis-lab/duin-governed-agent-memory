// world_state() + revealed_risks() — TS port of server.py (brain unification,
// dependent routes 3). revealed_risks = tasks that READ as risks (near-term hard
// deadline on a high-stakes task, or explicit risk language). world_state = a
// read-only per-track situation rollup (open/due_soon/next_due + live risks +
// task-edge links + accepted situation/belief deltas + a forward timeline).
// Reuses the predicted-risks helpers over the same loaders. The Python side
// effect (persisting world-state.json) is NOT replicated. Verified live vs :8765.

import { readFileSync } from 'fs'
import { join, relative } from 'path'
import { taskFiles } from './throughput'
import { parseTaskLine } from './causal-substrate'
import {
  suppressedRisks,
  attachSynth,
  parseYMD,
  dayDiff,
  isoOf,
  RISK_KW,
  DEADLINE_KW
} from './predicted-risks-native'
// PER-VAULT ontology, not predicted-risks' module-level `WORLD_TRACKS`/`trackOf` (which are the
// BUILT-IN default). Cold-start A3 emptied the built-in track list, so binding to it would leave
// worldState permanently trackless with no way for an operator to configure their own lanes —
// exactly the surface A3's `.duin/ontology.json` override exists to feed. `loadOntology(null)`
// still returns the default, so the null-vault path is unchanged.
import { loadOntology, normalizeTrackKey } from './ontology'
import { telosEnabled, loadTelos, laneOf } from './telos-native'
import { CJK_CLASS } from './cjk-tokens'

export interface RevealedRisk {
  id: string
  title: string
  due: string
  priority: string
  reason: string
  project: string
  source: string
  confidence: number
  track: string
  key?: string
  summary?: string | null
  update?: string | null
}

interface Delta {
  status?: string
  type?: string
  summary?: string
  ts?: string
  track?: string
  affects?: string
}

const stateDir = (vaultDir: string): string => join(vaultDir, '.duin', '_state')
function loadJsonl<T = Record<string, unknown>>(path: string): T[] {
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as T
        } catch {
          return null
        }
      })
      .filter((x): x is T => x !== null)
  } catch {
    return []
  }
}

const STOP_TOK = new Set(['task', 'risk', 'with', 'that', 'this', 'from', 'into', 'biweekly', 'report', 'project', 'delivery'])
// CJK runs of >=2, with the tokenizer's full CJK class (kanji + KANA) rather than the bare
// ideograph range — kana bounded a run, so a Japanese subject produced no bigrams and could
// never be matched to its accepted delta.
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]{2,}`, 'g')
function sigTokens(s: string): Set<string> {
  const lc = (s || '').toLowerCase()
  const toks = new Set([...lc.matchAll(/[a-z0-9]{4,}/g)].map((m) => m[0]))
  for (const run of lc.matchAll(CJK_RUN_RE)) {
    const r = run[0]
    for (let i = 0; i < r.length - 1; i++) toks.add(r.slice(i, i + 2))
  }
  for (const st of STOP_TOK) toks.delete(st)
  return toks
}
function deltaForSubject(text: string, deltas: Delta[]): string | null {
  const tt = sigTokens(text)
  if (!tt.size) return null
  let best: Delta | null = null
  for (const d of deltas) {
    if (d.type === 'situation') {
      const dt = sigTokens(`${d.affects || ''} ${d.summary || ''}`)
      if ([...dt].some((x) => tt.has(x))) best = d // file order = append order → later wins
    }
  }
  return best ? best.summary ?? null : null
}

/** Tasks that READ as risks — deadline-imminent high-stakes or explicit risk
 *  language. Port of server.py:revealed_risks. */
export function revealedRisks(vaultDir: string | null, today: Date = new Date()): { risks: RevealedRisk[] } {
  if (!vaultDir) return { risks: [] }
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const trackOf = loadOntology(vaultDir).trackOf
  const suppressed = suppressedRisks(vaultDir)
  const out: RevealedRisk[] = []
  for (const fp of taskFiles(vaultDir)) {
    let txt: string
    try {
      txt = readFileSync(fp, 'utf-8')
    } catch {
      continue
    }
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    const lines = txt.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], rel, i)
      if (!t || t.done || suppressed.has(t.id)) continue
      const desc = t.text
      const due = t.due
      const prio = t.priority
      let reason: string | null = null
      if (due) {
        const d = parseYMD(due)
        if (d && dayDiff(d, t0) >= 0 && dayDiff(d, t0) <= 3 && (prio === '1' || DEADLINE_KW.test(desc))) {
          reason = `hard deadline in ${dayDiff(d, t0)}d (${due})`
        }
      }
      if (!reason && RISK_KW.test(`${desc} ${t.contexts.join(' ')}`)) reason = 'flagged risk language'
      if (reason) {
        out.push({
          id: t.id,
          title: desc.slice(0, 110),
          due,
          priority: prio,
          reason,
          project: t.project,
          source: t.source,
          confidence: reason.startsWith('hard deadline') ? 0.9 : 0.6,
          track: trackOf(`${desc} ${t.contexts.join(' ')} ${t.project}`) ?? ''
        })
      }
    }
  }
  out.sort((a, b) => {
    const ka = a.reason.includes('deadline') ? 0 : 1
    const kb = b.reason.includes('deadline') ? 0 : 1
    if (ka !== kb) return ka - kb
    return (a.due || '~') < (b.due || '~') ? -1 : 1
  })
  const risks = out.slice(0, 20)
  attachSynth(risks, vaultDir)
  const deltas = loadJsonl<Delta>(join(stateDir(vaultDir), 'world-state-deltas.jsonl')).filter((d) => d.status === 'accepted')
  if (deltas.length) for (const r of risks) r.update = deltaForSubject(`${r.title} ${r.project || ''}`, deltas)
  return { risks }
}

interface TrackAcc {
  key: string
  label: string
  open: number
  due_soon: number
  next_due: string | null
  risks: number
  top_risk: string | null
  risk_list: string[]
  risk_events: { date: string; label: string; kind: string; confidence: number }[]
  drivers: Set<string>
}
const WT_LABEL: Record<string, string> = {
  ProjectA: '《ProjectA》 BD',
  PartnerCo: 'PartnerCo · M&A',
  Tooling: 'Tooling / harness',
  ProjectB: 'ProjectB · Lane B',
  SupplierCo: 'SupplierCo / supplier',
  personal: 'Personal'
}

/** Read-only per-track situation rollup. Port of server.py:world_state. */
export function worldState(vaultDir: string | null, today: Date = new Date()): {
  tracks: Record<string, unknown>[]
  generated: string
  priors: string
} {
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  // WS0.1 (telos-read) — gated OFF by default. OFF ⇒ no GOALS read, no telos field,
  // byte-identical to today. ON ⇒ read + attach a lane-stamped destination per track.
  const telosOn = telosEnabled()
  const telosMap = telosOn ? loadTelos(vaultDir) : null
  const onto = loadOntology(vaultDir)
  const worldTracks = onto.tracks
  const trackOf = onto.trackOf
  const tr = new Map<string, TrackAcc>(
    worldTracks.map((t) => [
      t.key,
      { key: t.key, label: WT_LABEL[t.key] ?? t.key, open: 0, due_soon: 0, next_due: null, risks: 0, top_risk: null, risk_list: [], risk_events: [], drivers: new Set<string>() }
    ])
  )
  if (vaultDir) {
    for (const fp of taskFiles(vaultDir)) {
      let txt: string
      try {
        txt = readFileSync(fp, 'utf-8')
      } catch {
        continue
      }
      const rel = relative(vaultDir, fp).replace(/\\/g, '/')
      const lines = txt.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const t = parseTaskLine(lines[i], rel, i)
        if (!t || t.done) continue
        const key = trackOf(`${t.text} ${t.tags.join(' ')} ${t.project}`)
        if (!key) continue
        const d = tr.get(key)!
        d.open++
        d.drivers.add(t.source)
        if (t.due) {
          const due = parseYMD(t.due)
          if (due) {
            if (dayDiff(due, t0) >= 0 && dayDiff(due, t0) <= 7) d.due_soon++
            if (!d.next_due || t.due < d.next_due) d.next_due = t.due
          }
        }
      }
    }
  }
  for (const r of revealedRisks(vaultDir, today).risks) {
    const key = trackOf(`${r.title || ''} ${r.project || ''}`)
    if (!key) continue
    const d = tr.get(key)!
    d.risks++
    d.risk_list.push(r.summary || r.title)
    if (r.due) d.risk_events.push({ date: r.due, label: r.summary || r.title, kind: 'risk', confidence: r.confidence ?? 0.7 })
    if (!d.top_risk) d.top_risk = r.summary || r.title
  }

  const linksByTrack = new Map<string, Set<string>>()
  const updatesByTrack = new Map<string, { summary: string; ts: string; type: string }[]>()
  const beliefsByTrack = new Map<string, { summary: string; ts: string; type: string }[]>()
  if (vaultDir) {
    for (const e of loadJsonl<{ task?: string; target?: string }>(join(stateDir(vaultDir), 'task-edges.jsonl'))) {
      const tk = trackOf(`${e.task || ''} ${e.target || ''}`)
      if (tk) (linksByTrack.get(tk) ?? linksByTrack.set(tk, new Set()).get(tk)!).add(e.target || '')
    }
    for (const u of loadJsonl<Delta>(join(stateDir(vaultDir), 'world-state-deltas.jsonl'))) {
      if (u.status !== 'accepted') continue
      const item = { summary: u.summary || '', ts: u.ts || '', type: u.type || 'situation' }
      const bucket = u.type === 'belief' || u.type === 'intent' ? beliefsByTrack : updatesByTrack
      const k = normalizeTrackKey(u.track || '') // deltas written under a legacy key still land on their lane
      ;(bucket.get(k) ?? bucket.set(k, []).get(k)!).push(item)
    }
  }

  const tracks: Record<string, unknown>[] = []
  for (const t of worldTracks) {
    const d = tr.get(t.key)!
    const status =
      `${d.open} open` +
      (d.due_soon ? ` · ${d.due_soon} due ≤7d` : '') +
      (d.next_due ? ` · next ${d.next_due}` : '') +
      (d.risks ? ` · ${d.risks} live risk${d.risks !== 1 ? 's' : ''}` : '')
    const trackUpdates = updatesByTrack.get(t.key) ?? []
    const events: { date: string; label: string; kind: string; confidence: number }[] = trackUpdates
      .filter((u) => u.ts)
      .map((u) => ({ date: (u.ts || '').slice(0, 10), label: u.summary, kind: 'update', confidence: 0.85 }))
    events.push(...d.risk_events)
    if (d.next_due) events.push({ date: d.next_due, label: 'next deadline', kind: 'deadline', confidence: 1.0 })
    const sortedEvents = events.filter((e) => e.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const track: Record<string, unknown> = {
      key: d.key,
      label: d.label,
      open: d.open,
      due_soon: d.due_soon,
      next_due: d.next_due,
      risks: d.risks,
      top_risk: d.top_risk,
      status: status || 'quiet',
      drivers: [...d.drivers].sort().slice(0, 8),
      linked: [...(linksByTrack.get(t.key) ?? [])].sort().slice(0, 6),
      risk_list: d.risk_list.slice(0, 8),
      updates: trackUpdates.slice(-5),
      beliefs: (beliefsByTrack.get(t.key) ?? []).slice(-5),
      events: sortedEvents.slice(0, 14),
      trajectory: trackUpdates.length ? trackUpdates[trackUpdates.length - 1].summary : null
    }
    // WS0.1: append the lane-stamped telos only when the flag is ON (appended last
    // so the OFF object is byte-identical to today's shape).
    if (telosOn && telosMap) track.telos = telosMap[d.key] ?? { text: null, lane: laneOf(d.key) }
    tracks.push(track)
  }
  return { tracks, generated: isoOf(t0), priors: 'me.md · GOALS.md (canonical — read, not copied)' }
}

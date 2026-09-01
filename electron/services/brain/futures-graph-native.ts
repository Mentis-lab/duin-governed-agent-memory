// futures-graph-native — TS port of server.py:futures_graph. The FUTURE as a
// force-directed graph: tracks are hubs; upcoming revealed risks, predictions, owed
// calls, and due-soon actions orbit them, causally linked. Composed from the already-
// parity-verified natives (worldState / revealedRisks / predictedRisks / listProblems)
// + the task scan (taskFiles + parseTaskLine + trackOf). Pure read.
import { readFileSync } from 'fs'
import { relative } from 'path'
import { worldState, revealedRisks } from './world-state-native'
import { predictedRisks, trackOf } from './predicted-risks-native'
import { listProblems } from './problems-native'
import { parseTaskLine } from './causal-substrate'
import { taskFiles } from './throughput'

const iso = (d: Date): string => d.toISOString().slice(0, 10)

interface GNode {
  id: string
  label: string
  kind: string
  [k: string]: unknown
}
interface GLink {
  source: string
  target: string
  type: string
}

export function futuresGraph(vaultDir: string | null, today: Date = new Date()): { nodes: GNode[]; links: GLink[]; today: string; generated: string } {
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const todayIso = iso(t0)
  if (!vaultDir) return { nodes: [], links: [], today: todayIso, generated: todayIso }
  const horizon = iso(new Date(t0.getTime() + 21 * 86400000))
  const nodes: GNode[] = []
  const links: GLink[] = []
  const seen = new Set<string>()
  const add = (nid: string, label: string, kind: string, kw: Record<string, unknown> = {}): boolean => {
    if (seen.has(nid)) return false
    seen.add(nid)
    nodes.push({ id: nid, label, kind, ...kw })
    return true
  }

  const ws = worldState(vaultDir, today).tracks as { key: string; label: string; open: number; risks: number }[]
  for (const t of ws) if (t.open > 0 || t.risks > 0) add(`track:${t.key}`, t.label, 'track', { val: 10 })

  for (const r of revealedRisks(vaultDir, today).risks) {
    const tk = r.track
    if (!tk || !seen.has(`track:${tk}`)) continue
    const rid = `risk:${r.id}`
    add(rid, (r.summary || r.title || '').slice(0, 64), 'risk', { val: 5, when: r.due ?? '', confidence: r.confidence ?? 0.7 })
    links.push({ source: rid, target: `track:${tk}`, type: 'threatens' })
  }

  for (const p of predictedRisks(vaultDir, today).risks) {
    const tk = p.track
    const pid = `pred:${p.id}`
    add(pid, (p.title || '').slice(0, 64), 'prediction', { val: 6, when: p.due ?? '', confidence: 0.8 })
    if (tk && seen.has(`track:${tk}`)) links.push({ source: pid, target: `track:${tk}`, type: 'forecasts' })
  }

  // actions that need doing — open tasks due within the horizon, capped per track (≤6)
  const perTrack: Record<string, number> = {}
  for (const fp of taskFiles(vaultDir)) {
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    let lines: string[]
    try {
      lines = readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n').split('\n')
    } catch {
      continue
    }
    lines.forEach((line, i) => {
      const t = parseTaskLine(line, rel, i)
      if (!t || t.done || !t.due || !(todayIso <= t.due && t.due <= horizon)) return
      const tk = trackOf(`${t.text} ${t.tags.join(' ')} ${t.project}`)
      if (!tk || !seen.has(`track:${tk}`) || (perTrack[tk] ?? 0) >= 6) return
      perTrack[tk] = (perTrack[tk] ?? 0) + 1
      const aid = `task:${t.id}`
      add(aid, t.text.slice(0, 54), 'action', { val: 3, when: t.due })
      links.push({ source: aid, target: `track:${tk}`, type: 'needs' })
    })
  }

  // owed decisions / calls coming up
  for (const n of listProblems(vaultDir).nodes) {
    if (n.kind === 'owed' || n.state === 'to-make' || n.state === 'made-not-executed') {
      const tk = trackOf(`${n.title ?? ''} ${n.detail ?? ''}`)
      const oid = `owed:${n.id}`
      add(oid, (n.title || '').slice(0, 60), 'decision', { val: 6 })
      if (tk && seen.has(`track:${tk}`)) links.push({ source: oid, target: `track:${tk}`, type: 'awaits-call' })
    }
  }

  return { nodes, links, today: todayIso, generated: todayIso }
}

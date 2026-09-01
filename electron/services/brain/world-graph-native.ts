// Native port of resources/brain/server.py :: world_graph (1084) — the world model
// as a temporal causal graph: per-track projected trajectories that dip at each
// upcoming risk and fork into addressed/unaddressed scenarios, plus typed causal
// nodes/edges. A PURE transform of world_state (already native + parity-verified),
// so feeding the byte-exact worldState through this yields a byte-exact world_graph.
import { worldState } from './world-state-native'

type Rec = Record<string, unknown>
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** Python round(x, n), round-half-to-even. */
function pyRound(x: number, n: number): number {
  const f = Math.pow(10, n)
  const scaled = x * f
  const fl = Math.floor(scaled)
  const diff = scaled - fl
  const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1
  return r / f
}
function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

export function worldGraph(vaultDir: string | null, now: Date = new Date()): Rec {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const ws = worldState(vaultDir, today) as unknown as { tracks: Rec[] }
  return buildWorldGraph(ws.tracks, today)
}

/** The pure world_graph transform over world_state's tracks (injected so it's
 *  testable without a full vault). `today` must be a local-midnight Date. */
export function buildWorldGraph(tracks: Rec[], today: Date): Rec {
  const todayIso = isoDate(today)
  const ws = { tracks }
  const nodes: Rec[] = []
  const edges: Rec[] = []
  const trajectories: Record<string, Rec> = {}
  for (const t of ws.tracks) {
    const tk = str(t.key)
    const tnode = `track:${tk}`
    nodes.push({ id: tnode, kind: 'track', track: tk, label: str(t.label), date: todayIso })
    const events = (t.events as Rec[]) || []
    events.forEach((e, i) => {
      const kind = str(e.kind)
      const nid = `${tk}:${kind}:${i}`
      nodes.push({ id: nid, kind, track: tk, label: str(e.label), date: str(e.date), confidence: num(e.confidence, 0.7) })
      const etype = kind === 'risk' ? 'threatens' : kind === 'deadline' ? 'due' : kind === 'update' ? 'updates' : 'affects'
      edges.push({ source: nid, target: tnode, type: etype })
    })
    const linked = ((t.linked as string[]) || []).slice(0, 4)
    linked.forEach((l, j) => {
      const did = `${tk}:driver:${j}`
      nodes.push({ id: did, kind: 'decision', track: tk, label: str(l).replace(/\[\[/g, '').replace(/\]\]/g, ''), date: todayIso })
      edges.push({ source: did, target: tnode, type: 'shapes' })
    })
    // trajectory: baseline, then dip at each future risk (weighted by confidence)
    const future = events
      .filter((e) => str(e.kind) === 'risk' && str(e.date) >= todayIso)
      .sort((a, b) => (str(a.date) < str(b.date) ? -1 : str(a.date) > str(b.date) ? 1 : 0))
    let v = 0.66
    const line: Rec[] = [
      { date: isoDate(addDays(today, -12)), v: 0.72 },
      { date: todayIso, v }
    ]
    for (const r of future) {
      v = Math.max(0.12, v - 0.16 * num(r.confidence, 0.7))
      line.push({ date: str(r.date), v: pyRound(v, 3), risk: str(r.label) })
    }
    const end = [...future.map((r) => str(r.date)), isoDate(addDays(today, 16))].reduce((a, b) => (a > b ? a : b))
    trajectories[tk] = {
      line,
      end,
      addressed: { date: end, v: pyRound(Math.min(0.75, v + 0.28), 3) },
      unaddressed: { date: end, v: pyRound(Math.max(0.05, v - 0.14), 3) }
    }
  }
  return {
    tracks: ws.tracks.map((t) => str(t.key)),
    labels: Object.fromEntries(ws.tracks.map((t) => [str(t.key), str(t.label)])),
    nodes,
    edges,
    trajectories,
    generated: todayIso
  }
}

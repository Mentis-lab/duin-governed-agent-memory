// detectors-native — TS port of server.py:list_detectors. The detector layer made
// visible: each scheduled routine that FOUND things, with its latest run + grouped
// findings (from its `<routine>.json` / `<routine>-findings.json` state file). Pure
// reads over decisionLoop's routine pulse + the finding files.
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { decisionLoop } from './decision-loop-native'

const BRAIN_DIR = '.duin'
const NOISE = new Set(['params', 'scan_dirs', 'queries', 'doc_types'])

/** Port of _finding_label — a display string for one finding item. */
function findingLabel(it: unknown): string {
  if (typeof it === 'string') return it
  if (it && typeof it === 'object') {
    const o = it as Record<string, unknown>
    for (const k of ['title', 'name', 'text', 'headline', 'doc', 'file', 'path', 'entity', 'cluster', 'mention', 'id']) {
      if (o[k]) return String(o[k])
    }
    return JSON.stringify(it).slice(0, 90)
  }
  return String(it).slice(0, 90)
}

interface DetectorGroup {
  key: string
  label: string
  count: number
  items: string[]
}
export interface DetectorOut {
  name: string
  path: string
  lastRun: string
  total: number
  groups: DetectorGroup[]
  stateFile: string
}

export function listDetectors(vaultDir: string | null): { detectors: DetectorOut[] } {
  if (!vaultDir) return { detectors: [] }
  const sd = join(vaultDir, BRAIN_DIR, '_state')
  const routines = decisionLoop(vaultDir).routines
  const out: DetectorOut[] = []
  for (const meta of routines) {
    const name = meta.routine
    const cand = [`${name}.json`, `${name}-findings.json`].map((fn) => join(sd, fn)).find((p) => existsSync(p))
    if (!cand) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(readFileSync(cand, 'utf-8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue
    const groups: DetectorGroup[] = []
    for (const [k, v] of Object.entries(d)) {
      if (!Array.isArray(v) || !v.length || NOISE.has(k)) continue
      const first = v[0]
      if (!(typeof first === 'string' || typeof first === 'number' || (first && typeof first === 'object'))) continue
      groups.push({ key: k, label: k.replace(/_/g, ' '), count: v.length, items: v.slice(0, 15).map(findingLabel) })
    }
    if (!groups.length) continue
    groups.sort((a, b) => b.count - a.count)
    out.push({
      name,
      path: meta.path ?? '',
      lastRun: String(d.generated ?? d.ts ?? meta.lastTs ?? ''),
      total: groups.reduce((s, g) => s + g.count, 0),
      groups,
      stateFile: `${BRAIN_DIR}/_state/${cand.split(/[\\/]/).pop()}`
    })
  }
  out.sort((a, b) => (a.lastRun < b.lastRun ? 1 : a.lastRun > b.lastRun ? -1 : 0))
  return { detectors: out }
}

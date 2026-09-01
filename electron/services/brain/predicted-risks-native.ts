// predicted_risks() — TS port of server.py:predicted_risks (brain unification,
// dependent route #1). Deterministic leading-indicator detector over the SAME
// loaders the causal-substrate already ports: deadline-collision (≥2 high-stakes
// tasks stacking within 5d) + decision-window-closing (an open stream whose
// decide_by is ≤21d out). Adds a cached one-line `summary` + md5 `key`. Read-only
// (the Python side-effects — ledger logging, background synthesis — are NOT
// replicated; they don't affect the response body). Verified live vs :8765.

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join, relative } from 'path'
import { loadFutures, parseDeadline, shortItem, parseTaskLine, type FutureStream } from './causal-substrate'
import { taskFiles, computeThroughput, type Throughput } from './throughput'
import { defaultOntology, loadOntology } from './ontology'
import { loadKindRates } from './calibration-weight'
import { calibrateConfidence } from './calibration'

export interface PredictedRisk {
  id: string
  kind: string
  title: string
  detail: string
  due: string
  leading_indicator: string
  subjects: string[]
  sources: string[]
  track: string
  reason: string
  confidence?: number
  key?: string
  summary?: string | null
  /** 'forecast' = a real (falsifiable) prediction; 'signal' = a decision-window
   *  reminder (a deadline clock, not a forecast). Consumers lead with forecasts;
   *  signals are demoted below them. Mirrors the engine's own kind-mode. */
  mode?: 'forecast' | 'signal'
}

// Ontology (tracks, keyword sets, decision nouns) now lives in ./ontology.ts so a
// vault can override it via .duin/ontology.json. These module-level exports keep
// their historical names, types and values (the built-in DEFAULT_ONTOLOGY) for the
// callers that use them vault-agnostically (world-state, futures-graph, etc.). The
// primary detector below loads the PER-VAULT ontology so overrides take effect.
export const RISK_KW = defaultOntology().riskKw
export const DEADLINE_KW = defaultOntology().deadlineKw
export const WORLD_TRACKS: { key: string; match: RegExp }[] = defaultOntology().tracks

export const trackOf = (text: string): string | null => defaultOntology().trackOf(text)
export const parseYMD = (s: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}
export const dayDiff = (a: Date, b: Date): number => Math.floor((a.getTime() - b.getTime()) / 86400000)
export const isoOf = (d: Date): string => d.toISOString().slice(0, 10)

export function suppressedRisks(vaultDir: string): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(join(vaultDir, '_agui_suppressed_risks.json'), 'utf-8')) as string[])
  } catch {
    return new Set()
  }
}
function loadSynth(vaultDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(vaultDir, '_agui_risk_synth.json'), 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}
const synthKey = (title: string, reason: string): string =>
  createHash('md5').update(`${title}|${reason}`).digest('hex').slice(0, 12)

/** Attach cached `summary` + md5 `key` to each risk (port of _attach_synth; the
 *  background synthesis kick-off is a side effect we skip). Structural over any
 *  risk-like object so both predicted + revealed risks reuse it. */
export function attachSynth(
  risks: { title: string; reason: string; key?: string; summary?: string | null }[],
  vaultDir: string
): void {
  const cache = loadSynth(vaultDir)
  for (const r of risks) {
    r.key = synthKey(r.title, r.reason)
    r.summary = cache[r.key] ?? null
  }
}

export function predictedRisks(vaultDir: string | null, today: Date = new Date()): {
  risks: PredictedRisk[]
  throughput: Throughput
} {
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  if (!vaultDir) return { risks: [], throughput: computeThroughput(null, t0) }
  const suppressed = suppressedRisks(vaultDir)
  const onto = loadOntology(vaultDir) // per-vault tracks/keywords/thresholds (falls back to defaults)
  const out: PredictedRisk[] = []

  // (A) deadline-collision — ≥2 high-stakes tasks due on the same day within 5d.
  const byday = new Map<string, ReturnType<typeof parseTaskLine>[]>()
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
      if (!t || t.done || !t.due) continue
      const d = parseYMD(t.due)
      if (!d) continue
      const stakes = t.priority === '1' || onto.deadlineKw.test(t.text) || onto.riskKw.test(t.text)
      if (d.getTime() >= t0.getTime() && dayDiff(d, t0) <= onto.thresholds.collisionWindowDays && stakes) {
        const arr = byday.get(t.due) ?? []
        arr.push(t)
        byday.set(t.due, arr)
      }
    }
  }
  for (const due of [...byday.keys()].sort()) {
    const ts = byday.get(due)!.filter(Boolean) as NonNullable<ReturnType<typeof parseTaskLine>>[]
    if (ts.length < 2) continue
    const pid = `collision::${due}`
    if (suppressed.has(pid)) continue
    const days = dayDiff(parseYMD(due)!, t0)
    const labels = ts.map((x) => shortItem(x.text))
    const named = labels.slice(0, 2).join(' · ') + (ts.length > 2 ? ` +${ts.length - 2} more` : '')
    out.push({
      id: pid,
      kind: 'deadline-collision',
      mode: 'forecast',
      title: `${named} — ${ts.length} due ${due}`,
      detail: labels.slice(0, 4).join(' · '),
      due,
      leading_indicator: 'deadline cluster',
      subjects: ts.map((x) => x.id),
      sources: [...new Set(ts.map((x) => x.source).filter(Boolean))].sort(),
      track: onto.trackOf(ts.map((x) => x.text).join(' ')) ?? '',
      reason: `${ts.length} hard deadlines stack on ${due} (${days}d out) — unlikely all clear`
    })
  }

  // (B) decision-window-closing — an open/engaged stream whose decide_by is ≤21d out.
  // P4b — CONSUME the now-honest (P4a) decision-window signal: calibrate each nudge's
  // stated confidence toward the KIND's empirical efficacy rate (bounded). This is the
  // real behavioural wire — the calibrated confidence reranks nudges downstream (e.g.
  // keyless-answer sorts risks by due then confidence). GATED below min_n (keeps the
  // prior) and BOUNDED so a single rate can never swing or silence a nudge.
  const dwRate = loadKindRates(vaultDir).get('decision-window')
  for (const s of loadFutures(vaultDir) as FutureStream[]) {
    if (s.status !== 'open' && s.status !== 'engaged') continue
    const trk = s.track || ''
    const sid = s.id || ''
    const label = shortItem(s.title || '') || (s.title || '').slice(0, 24)
    const tgt = s.target || '?'
    const dby = parseDeadline(s.decide_by)
    if (dby) {
      const ddays = dayDiff(dby, t0)
      if (ddays <= onto.thresholds.decisionWindowDays) {
        const pid = `decide::${sid}`
        if (suppressed.has(pid)) continue
        const overdue = ddays < 0
        const noun = onto.decideNoun[trk] ?? 'decision window'
        const when = overdue ? `overdue by ${-ddays}d` : `in ${ddays}d`
        const fullTitle = (s.title || label).trim()
        out.push({
          id: pid,
          kind: 'decision-window',
          mode: 'signal', // a deadline reminder, not a forecast — demoted below forecasts
          title: `${noun}: ${fullTitle.slice(0, 80)} — decide by ${s.decide_by}`,
          detail: (s.objective || s.decision || s.title || '').trim(),
          due: isoOf(dby),
          leading_indicator: 'decide_by reached',
          subjects: [sid],
          sources: [],
          track: trk,
          confidence: calibrateConfidence(
            overdue ? 0.85 : ddays <= 7 ? 0.8 : 0.65,
            dwRate?.rate ?? null,
            dwRate?.observed ?? 0
          ),
          reason: `decision for «${label}» is due ${when} (${s.decide_by}); miss it and target ${tgt} slips`
        })
      }
    }
  }

  // Demote decision-window SIGNALS below real FORECASTS on the surface (then by due).
  const rank = (r: PredictedRisk): number => (r.mode === 'signal' ? 1 : 0)
  out.sort((a, b) => rank(a) - rank(b) || ((a.due || '~') < (b.due || '~') ? -1 : 1))
  const risks = out.slice(0, 16)
  attachSynth(risks, vaultDir)
  return { risks, throughput: computeThroughput(vaultDir, t0) }
}

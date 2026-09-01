// Native port of resources/brain/server.py :: list_futures (1818) and
// calibrate_streams (2112) — the §4b capstone (the /state/futures route).
//
// calibrate_streams is called FIRST by list_futures and HAS A WRITE SIDE-EFFECT:
// it appends passed-decision / grounded-step verdicts to the stream-verdicts
// ledger on every read, so the standing state self-corrects. The port replicates
// that append (mkdir + appendFile) — dropping it would silently stop calibration.
//
// list_futures then convergence-weights each open/engaged stream (mentions +
// importance + conv confidence), drops dormant KB-only streams, groups into
// objectives with roll-up levels, and returns everything soonest-deadline-first.
import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { loadFutures } from './causal-substrate'
import { loadTaskCorpus } from './task-corpus-native'
import { loadJsonl, convergencePool } from './futures-pool-native'
import { convergence } from './convergence-native'

type Stream = Record<string, unknown>

/** Python round(x, n), round-half-to-even, on the same IEEE double. */
function pyRound(x: number, n: number): number {
  const f = Math.pow(10, n)
  const scaled = x * f
  const fl = Math.floor(scaled)
  const diff = scaled - fl
  const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1
  return r / f
}
/** date.today().isoformat() — local YYYY-MM-DD. */
function isoToday(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
/** Python str.title(): upper-case the first letter of each alpha run, lower the rest. */
function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
}

const VERDICTS_REL = ['.duin', '_state', 'stream-verdicts.jsonl']
const MONTH = /^\d{4}-\d{2}/

export interface CalibrateResult {
  new: number
  hit_rate: number | null
  scored: number
}

/** Port of calibrate_streams. Deterministic; APPENDS new verdicts to the ledger. */
export function calibrateStreams(vaultDir: string, now: Date = new Date()): CalibrateResult {
  const today = isoToday(now)
  const streams = loadFutures(vaultDir) as Stream[]
  const ledgerPath = join(vaultDir, ...VERDICTS_REL)
  const ledger = loadJsonl(ledgerPath)
  const key = (id: unknown, what: unknown): string => JSON.stringify([id ?? null, what ?? null])
  const logged = new Set(ledger.map((v) => key(v.id, v.what)))
  const fresh: Record<string, unknown>[] = []
  const hasLinks = streams.some((s) => ((s.steps as Stream[]) || []).some((st) => st.task_id))
  const taskDone: Record<string, boolean> = {}
  if (hasLinks) for (const t of loadTaskCorpus(vaultDir)) taskDone[t.id] = !!t.done
  for (const s of streams) {
    if (s.status !== 'open' && s.status !== 'engaged') continue
    const db = str(s.decide_by)
    if (MONTH.test(db) && db.slice(0, 7) < today.slice(0, 7)) {
      if (!logged.has(key(s.id, `decide:${db}`))) {
        fresh.push({
          id: s.id,
          what: `decide:${db}`,
          kind: 'decision',
          outcome: s.status === 'engaged' ? 'hit' : 'unobserved',
          ts: today
        })
      }
    }
    for (const st of (s.steps as Stream[]) || []) {
      const tid = st.task_id as string | undefined
      const wh = str(st.when)
      if (!tid || !(tid in taskDone) || !MONTH.test(wh) || wh.slice(0, 7) >= today.slice(0, 7)) continue
      if (!logged.has(key(s.id, `step:${tid}`))) {
        fresh.push({ id: s.id, what: `step:${tid}`, kind: 'step', outcome: taskDone[tid] ? 'hit' : 'miss', ts: today })
      }
    }
  }
  if (fresh.length) {
    mkdirSync(dirname(ledgerPath), { recursive: true })
    // Match Python json.dumps(v, ensure_ascii=False) default separators (", ", ": ")
    // so native-appended ledger rows are byte-identical to sidecar-written ones.
    // (Functionally moot — consumers parse via loadJsonl — but keeps the file uniform.)
    const dumps = (v: Record<string, unknown>): string =>
      '{' + Object.entries(v).map(([k, val]) => JSON.stringify(k) + ': ' + JSON.stringify(val)).join(', ') + '}'
    appendFileSync(ledgerPath, fresh.map(dumps).join('\n') + '\n', 'utf-8')
  }
  const observed = [...ledger, ...fresh].filter((v) => v.outcome === 'hit' || v.outcome === 'miss')
  const hits = observed.filter((v) => v.outcome === 'hit').length
  return { new: fresh.length, hit_rate: observed.length ? pyRound(hits / observed.length, 2) : null, scored: observed.length }
}

const OBJECTIVE_LABELS: Record<string, string> = {
  'projecta-launch': 'ProjectA — international multi-platform launch',
  'projecta-gtm': 'ProjectA — game marketing (channels · events · launch)'
}

/** Port of list_futures. */
export function listFutures(vaultDir: string | null, now: Date = new Date()): Record<string, unknown> {
  if (!vaultDir) return { objectives: [], streams: [], dormant: [], dismissed: [], today: isoToday(now), accuracy: { hit_rate: null, scored: 0 } }
  const cal = calibrateStreams(vaultDir, now) // write side-effect + accuracy
  const streams = (loadFutures(vaultDir) as Stream[]).filter((s) => s.status === 'open' || s.status === 'engaged')
  const pool = convergencePool(vaultDir, now)
  for (const s of streams) {
    const steps = ((s.steps as Stream[]) || []).map((x) => str(x.event)).join(' ')
    const subj = `${str(s.title)} ${str(s.objective)} ` + steps
    const [m, act, grnd] = convergence(subj, pool)
    s.mentions = m
    const curated = s.source === 'synced' || s.status === 'engaged' || s.kept
    if (act === 0 && !curated) {
      s.dormant = true
      s.importance = 0.0
    } else {
      const baseAct = act > 0 ? act : 0.6
      s.importance = pyRound(baseAct * (1 + grnd / 6.0), 1)
    }
    const levels = (s.levels as Record<string, unknown>) || {}
    const base = num(levels.confidence, num(s.confidence, 0.5))
    const convConf = pyRound(Math.min(1.0, 0.45 * base + 0.55 * Math.min(1.0, num(s.importance) / 12.0)), 2)
    if (!s.levels) s.levels = {}
    ;(s.levels as Record<string, unknown>).confidence = convConf
  }
  const dormant = streams
    .filter((s) => s.dormant)
    .map((s) => ({ id: s.id, title: str(s.title), track: str(s.track), mentions: num(s.mentions) }))
  const live = streams.filter((s) => !s.dormant)
  live.sort((a, b) => {
    const ea = a.status === 'engaged' ? 0 : 1
    const eb = b.status === 'engaged' ? 0 : 1
    if (ea !== eb) return ea - eb
    const ia = num(a.importance)
    const ib = num(b.importance)
    if (ia !== ib) return ib - ia // -importance
    const da = str(a.decide_by) || '9999'
    const db = str(b.decide_by) || '9999'
    return da < db ? -1 : da > db ? 1 : 0
  })
  const groups = new Map<string, Stream[]>()
  for (const s of live) {
    const pkey = s.track === 'ProjectA' ? 'projecta-gtm' : str(s.parent)
    if (!groups.has(pkey)) groups.set(pkey, [])
    groups.get(pkey)!.push(s)
  }
  const objectives: Record<string, unknown>[] = []
  for (const [pkey, members] of groups) {
    if (!pkey) continue
    const lv = members.map((m) => (m.levels as Record<string, unknown>) || {})
    const decidebys = members.map((m) => str(m.decide_by)).filter(Boolean)
    const label =
      OBJECTIVE_LABELS[pkey] ||
      str(members.find((m) => m.parent_label)?.parent_label) ||
      titleCase(pkey.replace(/-/g, ' '))
    objectives.push({
      key: pkey,
      label,
      count: members.length,
      engaged: members.filter((m) => m.status === 'engaged').length,
      risk: pyRound(lv.length ? Math.max(...lv.map((x) => num(x.risk))) : 0, 2),
      progress: pyRound(sum(lv.map((x) => num(x.progress))) / Math.max(lv.length, 1), 2),
      confidence: pyRound(sum(lv.map((x) => num(x.confidence))) / Math.max(lv.length, 1), 2),
      decide_by: decidebys.length ? decidebys.reduce((a, b) => (b < a ? b : a)) : '',
      mentions: sum(members.map((m) => num(m.mentions))),
      importance: pyRound(sum(members.map((m) => num(m.importance))), 2),
      members: members.map((m) => m.id)
    })
  }
  objectives.sort((a, b) => num(b.importance) - num(a.importance))
  const dismissed = (loadFutures(vaultDir) as Stream[])
    .filter((s) => s.status === 'declined')
    .map((s) => ({ id: s.id, title: str(s.title), track: str(s.track) }))
  return {
    objectives,
    streams: live,
    dormant,
    dismissed,
    today: isoToday(now),
    accuracy: { hit_rate: cal.hit_rate, scored: cal.scored }
  }
}

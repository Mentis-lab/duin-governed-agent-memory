// Home — the one operator surface, as a PURE model.
//
// Every monitoring surface the right panel used to spread across Status (Needs you, Brain
// status, Calibration), Learning, Automations, Background tasks and After action answers one
// of three questions: what needs me, is the machine alive, what changed. This module takes
// what those surfaces read and composes ONE answer with ONE focal item; HomePanel only
// renders it. Pure so the ranking and the wording can be pinned in node tests: no React, no
// window, no i18n import (the translator is passed in, and the English source is the key).
//
// Copy rule for everything here: short, plain, no dashes in UI strings.

export type Tone = 'ok' | 'warn' | 'crit' | 'muted'

/** Where a line takes you. Tools are the detailed panels this surface folds; settings tabs
 *  are where a problem is fixed; a deep link is what a notice carried. */
export type Target =
  | { type: 'tool'; tool: string }
  | { type: 'settings'; tab: string }
  | { type: 'deepLink'; link: string }
  | { type: 'none' }

export interface NoticeLike {
  id: string
  kind: string
  severity: 'info' | 'warning' | 'error'
  title: string
  body: string
  deepLink: string | null
  createdAt: number
  readAt: number | null
  needsDecision: boolean
  resolvedAt: number | null
}

export interface EngineInput {
  resolution: { modelId: string; provider: string; source?: string } | null
  health: { provider: string; healthy: boolean; reason: string; detail?: string; hint?: string; latencyMs?: number }[]
  /** Human names for provider ids and model ids (cosmetic; ids are fine). */
  providerLabels?: Record<string, string>
  modelNames?: Record<string, string>
}

export interface ScheduleInput {
  name: string
  enabled: boolean
  paused?: boolean
  /** True when the engine says this schedule is due to fire now (the /state/schedules shape). */
  due?: boolean
  /** Last run summary string, when the engine knows it. */
  last?: string | null
}

export interface DigestInput {
  returnReason?: string
  returnReasonIsDefault?: boolean
  insights?: { id: string; title: string; why?: string }[]
  away?: string | null
}

export interface Snapshot {
  at: number
  docCount: number
  nodes: number
  facts: number
  resolvedForecasts: number
  runsDone: number
  runsFailed: number
}

export interface HomeInputs {
  now: number
  notices: NoticeLike[] | null
  counts: { unread: number; needsDecision: number }
  awaitingFacts: number
  digest: DigestInput | null
  engine: EngineInput | null
  index: { indexing: boolean; docCount: number; dir: string } | null
  graph: { nodes: number; links: number; stale?: boolean } | null
  hasModel: boolean | null
  schedules: { schedules: ScheduleInput[]; runnerEnabled: boolean } | null
  automations: { total: number; enabled: number; lastRunAt: number | null; failing: number } | null
  running: { agents: number; toolCalls: number; wakeups: number } | null
  stalls: { count: number; totalMs: number; sinceMs: number } | null
  cost: { costUsd: number; calls: number; estimated: boolean } | null
  backend: { integrityOk: boolean | null; backupAgeHours: number | null; stuckRuns: number; ts: string } | null
  connections: { id: string; label: string; configured: boolean; enabled: boolean; lastSyncMs: number | null; lastError: string | null }[] | null
  learning: { awaiting: number; proving: number; confirmed: number; latestFact: string | null; correctionsQueued: number } | null
  calibration: { predictions: number; resolved: number; open: number; falseAlarms: number } | null
  runs: { done: number; failed: number } | null
  afterAction: { toolErrors: number; chatErrors: number } | null
  /** The last snapshot from a PREVIOUS app session; deltas read against it. */
  lastSeen: Snapshot | null
  /** Sources that could not be read this round (labels). */
  unreadable: string[]
}

export interface FocalItem {
  kind: 'need' | 'machine' | 'fresh' | 'insight' | 'return' | 'calm'
  title: string
  why: string | null
  action: { label: string; to: Target } | null
  tone: Tone
}

export interface NeedRow {
  id: string
  title: string
  why: string
  createdAt: number
  severity: 'info' | 'warning' | 'error'
  needsDecision: boolean
  deepLink: string | null
}

export interface AliveLine {
  id: 'engine' | 'brain' | 'loops' | 'running' | 'harness' | 'sources'
  label: string
  value: string
  why: string | null
  tone: Tone
  to: Target
}

export interface ChangedLine {
  id: string
  text: string
  to: Target
}

export interface HomeModel {
  focal: FocalItem
  needs: NeedRow[]
  needsTotal: number
  alive: AliveLine[]
  changed: ChangedLine[]
  /** When the "what changed" window opened (the last snapshot), or null for "this session". */
  since: number | null
  unreadable: string[]
}

export type T = (text: string) => string
export type TF = (template: string, params: Record<string, string | number>) => string

const MAX_NEEDS = 5
const MAX_CHANGED = 6
/** The stall monitor's window must be this old before its blocked fraction means anything. */
export const STALL_JUDGE_AFTER_MS = 10 * 60 * 1000

export function fmtN(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** "3m", "2h", "4d": the age of a timestamp, for a row's trailing meta. */
export function ageShort(now: number, ts: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

function tool(toolId: string): Target {
  return { type: 'tool', tool: toolId }
}

function firstSentence(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim()
  const cut = s.search(/[.!?。！？]\s|[.!?。！？]$/)
  const out = cut > 0 ? s.slice(0, cut + 1) : s
  return out.length > 140 ? out.slice(0, 139).trimEnd() + '…' : out
}

// ── Needs you ─────────────────────────────────────────────────────────────────

/** Owed first (a decision waiting), then unread, newest first; resolved rows never show. */
export function rankNeeds(notices: NoticeLike[]): NoticeLike[] {
  const live = notices.filter((n) => n.resolvedAt === null && (n.needsDecision || n.readAt === null))
  return live.sort((a, b) => {
    if (a.needsDecision !== b.needsDecision) return a.needsDecision ? -1 : 1
    return b.createdAt - a.createdAt
  })
}

// ── Alive ─────────────────────────────────────────────────────────────────────

function engineLine(i: HomeInputs, t: T, tf: TF): AliveLine {
  const e = i.engine
  const to = tool('homeStatus')
  if (!e) {
    return { id: 'engine', label: t('Engine'), value: t('unknown'), why: t('could not read the router'), tone: 'muted', to }
  }
  const res = e.resolution
  const healthyProviders = e.health.filter((h) => h.healthy)
  if (!res) {
    const keyed = e.health.filter((h) => h.reason !== 'no-key')
    const why = keyed.length === 0
      ? t('no model connected')
      : keyed.map((h) => `${e.providerLabels?.[h.provider] ?? h.provider}: ${h.hint ?? h.detail ?? h.reason}`).join(' · ')
    return {
      id: 'engine',
      label: t('Engine'),
      value: t('nothing answers'),
      why,
      tone: 'crit',
      to: { type: 'settings', tab: 'models' }
    }
  }
  // Ollama models are not in the catalog list, so their id carries the provider prefix.
  const name = e.modelNames?.[res.modelId] ?? res.modelId.replace(/^ollama:/, '')
  const providerName = e.providerLabels?.[res.provider] ?? res.provider
  const h = e.health.find((x) => x.provider === res.provider) ?? null
  if (h && !h.healthy) {
    return {
      id: 'engine',
      label: t('Engine'),
      value: `${name} · ${providerName}`,
      why: tf('{provider} is failing: {reason}', { provider: providerName, reason: h.hint ?? h.detail ?? h.reason }),
      tone: healthyProviders.length > 0 ? 'warn' : 'crit',
      to
    }
  }
  const latency = h?.latencyMs != null ? ` · ${(h.latencyMs / 1000).toFixed(1)}s` : ''
  return {
    id: 'engine',
    label: t('Engine'),
    value: `${name} · ${providerName}`,
    why: h ? t('answering') + latency : t('not probed yet'),
    tone: h ? 'ok' : 'muted',
    to
  }
}

function brainLine(i: HomeInputs, t: T, tf: TF): AliveLine {
  const idx = i.index
  const g = i.graph
  if (idx && !idx.dir) {
    return { id: 'brain', label: t('Brain'), value: t('no folder yet'), why: t('point DUIN at a folder of notes'), tone: 'crit', to: { type: 'settings', tab: 'general' } }
  }
  const notes = idx ? fmtN(idx.docCount) : '?'
  const nodes = g ? fmtN(g.nodes) : '?'
  const value = tf('{notes} notes · {nodes} nodes', { notes, nodes })
  if (idx?.indexing) return { id: 'brain', label: t('Brain'), value, why: t('indexing now'), tone: 'ok', to: tool('brain') }
  if (i.hasModel === false) return { id: 'brain', label: t('Brain'), value, why: t('graph waits for a model'), tone: 'warn', to: { type: 'settings', tab: 'models' } }
  // A stale graph is a rebuild in flight, not a fault: activity, so it never leads the surface.
  if (g?.stale) return { id: 'brain', label: t('Brain'), value, why: t('graph is stale, rebuilding'), tone: 'ok', to: tool('homeStatus') }
  if (!idx && !g) return { id: 'brain', label: t('Brain'), value: t('unknown'), why: t('could not read the index'), tone: 'muted', to: tool('brain') }
  return { id: 'brain', label: t('Brain'), value, why: t('indexed and built'), tone: 'ok', to: tool('brain') }
}

function loopsLine(i: HomeInputs, t: T, tf: TF): AliveLine {
  const to = tool('automations')
  const s = i.schedules
  const a = i.automations
  if (!s && !a) return { id: 'loops', label: t('Loops'), value: t('unknown'), why: t('could not read the schedules'), tone: 'muted', to }
  const scheduled = (s?.schedules ?? []).filter((x) => x.enabled && !x.paused).length
  const automations = a?.enabled ?? 0
  const total = scheduled + automations
  if (total === 0) return { id: 'loops', label: t('Loops'), value: t('none scheduled'), why: null, tone: 'muted', to }
  const value = total === 1 ? t('1 scheduled') : tf('{n} scheduled', { n: total })
  if (s && !s.runnerEnabled) {
    return { id: 'loops', label: t('Loops'), value, why: t('runner is off, nothing fires'), tone: 'warn', to: { type: 'settings', tab: 'loops' } }
  }
  if (a && a.failing > 0) {
    return { id: 'loops', label: t('Loops'), value, why: a.failing === 1 ? t('1 automation failing') : tf('{n} automations failing', { n: a.failing }), tone: 'warn', to }
  }
  const dueNow = (s?.schedules ?? []).filter((x) => x.enabled && !x.paused && x.due === true).length
  const parts: string[] = []
  if (dueNow > 0) parts.push(dueNow === 1 ? t('1 due now') : tf('{n} due now', { n: dueNow }))
  if (a?.lastRunAt) parts.push(tf('last ran {ago} ago', { ago: ageShort(i.now, a.lastRunAt) }))
  return { id: 'loops', label: t('Loops'), value, why: parts.join(' · ') || t('armed'), tone: 'ok', to }
}

function runningLine(i: HomeInputs, t: T, tf: TF): AliveLine {
  const to = tool('background')
  const r = i.running
  if (!r) return { id: 'running', label: t('Running now'), value: t('unknown'), why: null, tone: 'muted', to }
  const live = r.agents + r.toolCalls
  if (live === 0 && r.wakeups === 0) return { id: 'running', label: t('Running now'), value: t('quiet'), why: null, tone: 'muted', to }
  const parts: string[] = []
  if (r.agents > 0) parts.push(r.agents === 1 ? t('1 agent') : tf('{n} agents', { n: r.agents }))
  if (r.toolCalls > 0) parts.push(r.toolCalls === 1 ? t('1 tool call') : tf('{n} tool calls', { n: r.toolCalls }))
  if (r.wakeups > 0) parts.push(r.wakeups === 1 ? t('1 wakeup pending') : tf('{n} wakeups pending', { n: r.wakeups }))
  return { id: 'running', label: t('Running now'), value: parts.join(' · '), why: null, tone: live > 0 ? 'ok' : 'muted', to }
}

function harnessLine(i: HomeInputs, t: T, tf: TF): AliveLine {
  const to = tool('homeStatus')
  const b = i.backend
  const st = i.stalls
  const c = i.cost
  if (!b && !st && !c) return { id: 'harness', label: t('Harness'), value: t('unknown'), why: t('could not read the health monitors'), tone: 'muted', to }
  const problems: string[] = []
  let tone: Tone = 'ok'
  if (b?.integrityOk === false) { problems.push(t('database integrity check failed')); tone = 'crit' }
  if (b && b.backupAgeHours !== null && b.backupAgeHours > 26) { problems.push(tf('last backup {n}h ago', { n: Math.round(b.backupAgeHours) })); if (tone === 'ok') tone = 'warn' }
  if (b && b.stuckRuns > 0) { problems.push(b.stuckRuns === 1 ? t('1 stuck run') : tf('{n} stuck runs', { n: b.stuckRuns })); if (tone === 'ok') tone = 'warn' }
  // Main-thread stalls: the window freezes whenever the main process blocks; a busy fraction
  // above a few percent is what the operator feels as lag. Not judged in the first minutes
  // after launch, when indexing and the graph build legitimately own the thread and the
  // fraction reads 70% over a window ten seconds long.
  if (st && st.sinceMs >= STALL_JUDGE_AFTER_MS) {
    const pct = (st.totalMs / st.sinceMs) * 100
    if (pct >= 5) { problems.push(tf('window blocked {pct}% of the time', { pct: pct.toFixed(1) })); if (tone === 'ok') tone = 'warn' }
  }
  const spend = c ? (c.calls > 0 ? tf('{usd} today', { usd: fmtUsd(c.costUsd) + (c.estimated ? '~' : '') }) : t('no spend today')) : null
  if (problems.length > 0) {
    return { id: 'harness', label: t('Harness'), value: problems[0], why: problems.slice(1).join(' · ') || null, tone, to }
  }
  return { id: 'harness', label: t('Harness'), value: t('calm'), why: spend, tone: 'ok', to }
}

function sourcesLine(i: HomeInputs, t: T, tf: TF): AliveLine | null {
  const cs = (i.connections ?? []).filter((c) => c.configured && c.enabled)
  if (cs.length === 0) return null
  const failing = cs.filter((c) => c.lastError)
  const to: Target = { type: 'settings', tab: 'general' }
  if (failing.length > 0) {
    return { id: 'sources', label: t('Sources'), value: tf('{name} sync failed', { name: failing[0].label }), why: failing[0].lastError, tone: 'warn', to }
  }
  const parts = cs.map((c) => (c.lastSyncMs ? tf('{name} synced {ago} ago', { name: c.label, ago: ageShort(i.now, c.lastSyncMs) }) : tf('{name} never synced', { name: c.label })))
  return { id: 'sources', label: t('Sources'), value: parts.join(' · '), why: null, tone: cs.some((c) => !c.lastSyncMs) ? 'muted' : 'ok', to }
}

export function composeAlive(i: HomeInputs, t: T, tf: TF): AliveLine[] {
  const lines = [engineLine(i, t, tf), brainLine(i, t, tf), loopsLine(i, t, tf), runningLine(i, t, tf), harnessLine(i, t, tf)]
  const src = sourcesLine(i, t, tf)
  if (src) lines.push(src)
  return lines
}

// ── What changed ──────────────────────────────────────────────────────────────

export function composeChanged(i: HomeInputs, t: T, tf: TF): ChangedLine[] {
  const out: ChangedLine[] = []
  const seen = i.lastSeen
  const notesDelta = seen && i.index ? i.index.docCount - seen.docCount : 0
  const nodesDelta = seen && i.graph ? i.graph.nodes - seen.nodes : 0
  if (notesDelta > 0 || nodesDelta > 0) {
    const parts: string[] = []
    if (notesDelta > 0) parts.push(notesDelta === 1 ? t('1 note read') : tf('{n} notes read', { n: fmtN(notesDelta) }))
    if (nodesDelta > 0) parts.push(nodesDelta === 1 ? t('1 node added') : tf('{n} nodes added', { n: fmtN(nodesDelta) }))
    out.push({ id: 'ingest', text: parts.join(' · '), to: tool('brain') })
  }
  const l = i.learning
  if (l) {
    const parts: string[] = []
    if (l.awaiting > 0) parts.push(l.awaiting === 1 ? t('1 belief awaits your ratification') : tf('{n} beliefs await your ratification', { n: l.awaiting }))
    if (l.proving > 0) parts.push(l.proving === 1 ? t('1 fact proving out') : tf('{n} facts proving out', { n: l.proving }))
    if (l.correctionsQueued > 0) parts.push(l.correctionsQueued === 1 ? t('1 correction queued') : tf('{n} corrections queued', { n: l.correctionsQueued }))
    if (parts.length > 0) out.push({ id: 'learning', text: parts.join(' · '), to: tool('learning') })
    if (l.latestFact) out.push({ id: 'latest-fact', text: tf('Learned: {fact}', { fact: l.latestFact }), to: tool('learning') })
  }
  const r = i.runs
  if (r && (r.done > 0 || r.failed > 0)) {
    const parts: string[] = []
    if (r.done > 0) parts.push(r.done === 1 ? t('1 run finished') : tf('{n} runs finished', { n: r.done }))
    if (r.failed > 0) parts.push(r.failed === 1 ? t('1 run failed') : tf('{n} runs failed', { n: r.failed }))
    out.push({ id: 'runs', text: parts.join(' · '), to: tool('background') })
  }
  const cal = i.calibration
  if (cal) {
    const resolvedDelta = seen ? cal.resolved - seen.resolvedForecasts : 0
    if (resolvedDelta > 0) {
      out.push({ id: 'forecasts', text: resolvedDelta === 1 ? t('1 forecast resolved') : tf('{n} forecasts resolved', { n: resolvedDelta }), to: tool('homeStatus') })
    } else if (cal.open > 0 && !seen) {
      out.push({ id: 'forecasts', text: cal.open === 1 ? t('1 forecast open') : tf('{n} forecasts open', { n: cal.open }), to: tool('homeStatus') })
    }
  }
  const aa = i.afterAction
  if (aa && (aa.toolErrors > 0 || aa.chatErrors > 0)) {
    const parts: string[] = []
    if (aa.toolErrors > 0) parts.push(aa.toolErrors === 1 ? t('1 tool error') : tf('{n} tool errors', { n: aa.toolErrors }))
    if (aa.chatErrors > 0) parts.push(aa.chatErrors === 1 ? t('1 chat error') : tf('{n} chat errors', { n: aa.chatErrors }))
    out.push({ id: 'after-action', text: tf('Last conversation: {what}', { what: parts.join(' · ') }), to: tool('afterAction') })
  }
  if (i.digest?.away) out.push({ id: 'away', text: i.digest.away, to: tool('homeStatus') })
  return out.slice(0, MAX_CHANGED)
}

// ── Focal ─────────────────────────────────────────────────────────────────────

/** ONE thing first. A decision waiting beats a machine problem beats news beats an insight
 *  beats a reason to come back beats calm. The machine rule reads the alive lines so the two
 *  never disagree about what is wrong. */
export function pickFocal(i: HomeInputs, needs: NoticeLike[], alive: AliveLine[], t: T, tf: TF): FocalItem {
  const owed = needs.filter((n) => n.needsDecision)
  const owedTotal = owed.length + i.awaitingFacts
  if (owedTotal > 0) {
    const first = owed[0]
    return {
      kind: 'need',
      // "needs you" and not "decision": the Decisions surface is the decision LEDGER, a
      // different store entirely, so a Home line calling this a decision sends people to a
      // page that can never hold it. This is the Needs-you tab's own language.
      title: owedTotal === 1 ? t('1 thing needs you') : tf('{n} things need you', { n: owedTotal }),
      why: first ? `${first.title}${first.body ? ': ' + firstSentence(first.body) : ''}` : t('a belief DUIN learned about you needs your word'),
      action: { label: t('Decide'), to: first?.deepLink ? { type: 'deepLink', link: first.deepLink } : tool(first ? 'homeStatus' : 'learning') },
      tone: 'warn'
    }
  }
  const crit = alive.find((l) => l.tone === 'crit')
  if (crit) {
    return {
      kind: 'machine',
      title: crit.id === 'engine' ? t('No model is answering') : crit.id === 'brain' ? t('No brain folder yet') : crit.value,
      why: crit.why,
      action: { label: crit.id === 'engine' ? t('Connect a model') : crit.id === 'brain' ? t('Choose a folder') : t('Open'), to: crit.to },
      tone: 'crit'
    }
  }
  const fresh = needs.filter((n) => !n.needsDecision)
  if (fresh.length > 0) {
    const first = fresh[0]
    return {
      kind: 'fresh',
      title: fresh.length === 1 ? t('1 new thing since you looked') : tf('{n} new things since you looked', { n: fresh.length }),
      why: `${first.title}${first.body ? ': ' + firstSentence(first.body) : ''}`,
      action: { label: t('Open'), to: first.deepLink ? { type: 'deepLink', link: first.deepLink } : tool('homeStatus') },
      tone: 'ok'
    }
  }
  const insight = i.digest?.insights?.[0]
  if (insight) {
    return { kind: 'insight', title: insight.title, why: insight.why ?? t('the brain noticed this in your notes'), action: null, tone: 'ok' }
  }
  if (i.digest?.returnReason && !i.digest.returnReasonIsDefault) {
    return { kind: 'return', title: i.digest.returnReason, why: null, action: null, tone: 'ok' }
  }
  // A warning leads only when nothing else does. The line's reason is the headline (that is
  // the problem); its label and value are the context.
  const warn = alive.find((l) => l.tone === 'warn')
  if (warn) {
    const problem = warn.why ?? warn.value
    return {
      kind: 'machine',
      title: problem.charAt(0).toUpperCase() + problem.slice(1),
      why: `${warn.label}: ${warn.value}`,
      action: { label: t('Open'), to: warn.to },
      tone: 'warn'
    }
  }
  return {
    kind: 'calm',
    title: t('Nothing needs you'),
    why: i.index && i.index.docCount > 0 ? t('the brain is turning; ask it anything') : t('add notes or connect a source to give it something to work with'),
    action: null,
    tone: 'ok'
  }
}

export function composeHome(i: HomeInputs, t: T, tf: TF): HomeModel {
  const ranked = rankNeeds(i.notices ?? [])
  const alive = composeAlive(i, t, tf)
  const focal = pickFocal(i, ranked, alive, t, tf)
  // The focal item is not repeated in the list below it.
  const listed = focal.kind === 'need' || focal.kind === 'fresh' ? ranked.slice(1) : ranked
  const needs: NeedRow[] = listed.slice(0, MAX_NEEDS).map((n) => ({
    id: n.id,
    title: n.title,
    why: firstSentence(n.body),
    createdAt: n.createdAt,
    severity: n.severity,
    needsDecision: n.needsDecision,
    deepLink: n.deepLink
  }))
  return {
    focal,
    needs,
    needsTotal: ranked.length + i.awaitingFacts,
    alive,
    changed: composeChanged(i, t, tf),
    since: i.lastSeen?.at ?? null,
    unreadable: i.unreadable
  }
}

/** The snapshot this session leaves for the next one, so "what changed" has a baseline. */
export function snapshotOf(i: HomeInputs): Snapshot {
  return {
    at: i.now,
    docCount: i.index?.docCount ?? 0,
    nodes: i.graph?.nodes ?? 0,
    facts: i.learning ? i.learning.confirmed + i.learning.proving + i.learning.awaiting : 0,
    resolvedForecasts: i.calibration?.resolved ?? 0,
    runsDone: i.runs?.done ?? 0,
    runsFailed: i.runs?.failed ?? 0
  }
}

// keyless-answer.ts — when no LLM is available (no provider key, no Ollama), the
// local brain still gives a USEFUL, grounded reply instead of a dead-end. It
// composes a deterministic answer from what the keyless engines already compute:
// the retrieved notes, the foresight (predicted risks), the cross-cutting
// insights, and the per-track situation. The reply ends with a plain-language
// call to connect a model for a conversational answer (the guided "Connect AI"
// flow lives in onboarding + Settings).
//
// Pure + unit-tested: no I/O, no electron import. The server passes in the hits
// (already searched) and the engine state.

import type { CausalGraph, Insight, OpenLoop, PredictedRisk } from '../brain/types'
import type { WorldState } from '../brain/world-state'

export interface KeylessEngineState {
  insights: Insight[]
  risks: PredictedRisk[]
  world: WorldState
  /** Whole-vault causal structure (nodes + edges). OPTIONAL: when the caller can
   *  cheaply supply it (no LLM needed — it's the fs-native substrate), the keyless
   *  answer surfaces a richer structural insight (most-connected note / orphan hub).
   *  Absent → the insight falls back to the world-state rollup. */
  graph?: CausalGraph
  /** Open loops (owed decisions / risks) off the same substrate. OPTIONAL — see graph. */
  openLoops?: OpenLoop[]
}

export interface NoteHit {
  file: string
  snippet: string
  score: number
}

// The renderer-agnostic call to action appended to every keyless answer. Plain
// markdown so it renders fine without any chat-renderer change; the guided
// "Connect AI" step (Ollama one-click / paste a free key) is reachable from
// first-run onboarding and Settings → API Keys.
export const CONNECT_AI_CTA =
  '_Want a conversational answer? **Connect an AI model** — one click with a local ' +
  'model (Ollama), or paste a free provider key in Settings → API Keys._'

function trimSnippet(s: string, max = 160): string {
  // Strip a leading YAML frontmatter block from the DISPLAY snippet (the chunk
  // store keeps it so graph-derive can still type nodes). Keeps answers clean.
  const noFm = s.replace(/^\s*---[\s\S]*?\r?\n---\s*/, '')
  const one = noFm.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
}

function dueLabel(due: string): string {
  const d = Date.parse(due)
  if (Number.isNaN(d)) return due
  const days = Math.round((d - Date.now()) / 86_400_000)
  if (days < 0) return `overdue ${-days}d`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `in ${days}d`
}

/**
 * The unprompted "first insight" — a genuinely useful fact computed from STRUCTURE
 * ALONE (no LLM, no query). This is what gives a keyless session-one a reason to
 * come back: even before any model is connected, the brain notices something TRUE
 * about the shape of your notes. Tries the richest available source first and
 * degrades gracefully to nothing when the vault is too sparse to say anything true.
 *
 * Priority:
 *   1. Open decisions (openLoops) — the most-overdue call you owe yourself.
 *   2. Graph shape — your most-connected note, or a hub referenced but never expanded.
 *   3. World rollup — open items across tracks / the most at-risk lane.
 * PURE.
 */
export function computeFirstInsight(engine: KeylessEngineState): string | null {
  // 1 — Open decisions you owe yourself (most actionable, if the caller supplies loops).
  const owed = (engine.openLoops ?? []).filter((l) => l.kind === 'owed')
  if (owed.length) {
    const now = Date.now()
    const s = owed.length === 1 ? '' : 's'
    const withDue = owed
      .map((l) => ({ l, t: Date.parse(l.due ?? '') }))
      .filter((x) => !Number.isNaN(x.t))
    const overdue = withDue
      .map((x) => ({ l: x.l, days: Math.floor((now - x.t) / 86_400_000) }))
      .filter((x) => x.days > 0)
      .sort((a, b) => b.days - a.days)
    if (overdue.length) {
      const { l, days } = overdue[0]
      return `You have ${owed.length} open decision${s} waiting on you — the most overdue, **${l.title}**, is ${days} day${days === 1 ? '' : 's'} past its decide-by.`
    }
    const soonest = withDue.sort((a, b) => a.t - b.t)[0]
    if (soonest) {
      return `You have ${owed.length} open decision${s} on the table; the next, **${soonest.l.title}**, is ${dueLabel(soonest.l.due as string)}.`
    }
    return `You have ${owed.length} open decision${s} with no set decide-by — **${owed[0].title}** is one worth timeboxing.`
  }

  // 2 — Graph shape: the most-connected note (or a hub referenced but never expanded).
  const nodes = engine.graph?.nodes ?? []
  const edges = engine.graph?.edges ?? []
  if (nodes.length) {
    const outDeg = new Map<string, number>()
    for (const e of edges) outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1)
    const hub = nodes
      .map((n) => ({ n, deg: n.in_degree ?? 0 }))
      .filter((x) => x.deg >= 2)
      .sort((a, b) => b.deg - a.deg)[0]
    if (hub) {
      const out = outDeg.get(hub.n.id) ?? 0
      if (out === 0) {
        return `**${hub.n.label}** is referenced by ${hub.deg} of your notes but links out to none — a hub you keep pointing at without expanding.`
      }
      return `Your most-connected note is **${hub.n.label}** — ${hub.deg} notes point to it. Worth a look to keep it current.`
    }
  }

  // 3 — World rollup: open items across tracks, else the most at-risk lane.
  const tracks = engine.world?.tracks ?? []
  const withOpen = tracks.filter((t) => (t.open ?? 0) > 0)
  const totalOpen = withOpen.reduce((sum, t) => sum + (t.open ?? 0), 0)
  if (totalOpen > 0) {
    const top = [...withOpen].sort((a, b) => (b.open ?? 0) - (a.open ?? 0))[0]
    const m = withOpen.length
    let line =
      `You have ${totalOpen} open item${totalOpen === 1 ? '' : 's'} across ${m} track${m === 1 ? '' : 's'}` +
      (m > 1 ? `; **${top.label}** carries the most (${top.open}).` : ` in **${top.label}**.`)
    const nearest = tracks
      .map((t) => t.next_due)
      .filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    if (nearest) line += ` The nearest deadline is ${dueLabel(nearest)}.`
    return line
  }
  const risky = tracks
    .filter((t) => (t.risks ?? 0) > 0)
    .sort((a, b) => (b.risks ?? 0) - (a.risks ?? 0))[0]
  if (risky) {
    const r = risky.risks
    return `**${risky.label}** is your most at-risk lane — ${r} open risk${r === 1 ? '' : 's'}${risky.top_risk ? `, starting with ${risky.top_risk}` : ''}.`
  }

  return null
}

/**
 * Build a deterministic, grounded answer from the keyless engine state + the
 * retrieved notes. Always returns non-empty text ending with CONNECT_AI_CTA.
 */
export function composeKeylessAnswer(
  query: string,
  hits: NoteHit[],
  engine: KeylessEngineState
): string {
  const parts: string[] = []
  const topHits = [...hits].sort((a, b) => b.score - a.score).slice(0, 3)
  const topRisks = [...engine.risks]
    .sort((a, b) => Date.parse(a.due || '') - Date.parse(b.due || '') || b.confidence - a.confidence)
    .slice(0, 2)
  const topInsights = [...engine.insights].sort((a, b) => b.confidence - a.confidence).slice(0, 2)
  const liveTracks = (engine.world?.tracks ?? [])
    .filter((t) => t.due_soon > 0 || t.risks > 0)
    .slice(0, 2)

  // The unprompted, structure-only insight — the reason to come back even before a
  // model is connected. Computed from the whole vault, not the query.
  const firstInsight = computeFirstInsight(engine)

  const hasAnything =
    topHits.length || topRisks.length || topInsights.length || liveTracks.length || firstInsight

  if (!hasAnything) {
    return (
      "I don't have anything in your brain on that yet. Add a few notes to your knowledge folder " +
      "(or connect your governed brain) and I'll start noticing patterns — open decisions, deadlines " +
      "closing in, notes that connect. Check back and I'll have something for you.\n\n" +
      CONNECT_AI_CTA
    )
  }

  parts.push("Here's what's in your brain related to that:")

  // Lead with the unprompted insight so session-one always sees the brain "notice"
  // something true and self-standing, distinct from the query-driven note hits.
  if (firstInsight) {
    parts.push('\n**One thing I already notice**\n- ' + firstInsight)
  }

  if (topHits.length) {
    parts.push(
      '\n**Relevant notes**\n' +
        topHits.map((h) => `- **${h.file}** — ${trimSnippet(h.snippet)}`).join('\n')
    )
  }
  if (topRisks.length) {
    parts.push(
      '\n**On your radar (foreseen)**\n' +
        topRisks.map((r) => `- ${r.title} — ${trimSnippet(r.reason, 120)} (${dueLabel(r.due)})`).join('\n')
    )
  }
  if (topInsights.length) {
    parts.push(
      '\n**Patterns I notice**\n' +
        topInsights.map((i) => `- ${i.headline} — ${trimSnippet(i.why, 120)}`).join('\n')
    )
  }
  if (liveTracks.length) {
    parts.push(
      '\n**Where things stand**\n' +
        liveTracks.map((t) => `- **${t.label}**: ${trimSnippet(t.status, 120)}`).join('\n')
    )
  }

  parts.push('\n' + CONNECT_AI_CTA)
  return parts.join('\n')
}

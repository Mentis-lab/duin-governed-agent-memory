// turn-beats — WS2′ Phase A: the LOG-ONLY turn-beat measurement harness.
//
// ONE job: measure whether a per-turn next-beat prediction BEATS a dumb baseline
// ("the operator stays on the current track"). It logs + scores but INJECTS NOTHING
// into the reply — the AI answers exactly as today; a background pass writes + grades
// predictions. That kills the self-fulfilling-prophecy trap by construction: nothing
// the predictor emits ever steers the reply it is scored against.
//
// ── The mechanical template is WS1 recall-efficacy ──────────────────────────────────
// The prediction is made on turn N (predicting turn N+1's track); the ground truth
// arrives on turn N+1 (the operator's actual next query). We therefore STAGE the beat
// in a per-thread map on turn N and GRADE it at turn N+1's turn-open — exactly how
// `stageRecalledKinds` / `recallEfficacyTick` hold a turn's state until the next turn
// resolves it. Persistence mirrors recall-efficacy: append-only jsonl at
// `.duin/_state/turn-beats.jsonl`, single-writer (the electron process), one atomic
// append per GRADED beat (an un-followed-up prediction is never scored — silence is not
// evidence, same honesty as the recall ledger).
//
// ── The scorer (structural, prediction-independent, no LLM-judge) ───────────────────
//   • PRIMARY scored signal = track-match. actual_track = trackOf(query_{N+1}); a beat
//     HITS when predicted_track === actual_track.
//   • BASELINE = "stay on the current track" (baseline_track = trackOf(query_N)). Logged
//     alongside every beat so hit-rate is read vs the base-rate, not in a vacuum (users
//     mostly stay on-topic → the predictor must beat "predict continue" to earn its keep).
//   • predicted_action_class + next_beat are LOGGED for later analysis but NOT scored in
//     Phase A (action-class ground-truth is best-effort; keep the MVP tight).
//
// Kill-switch: `DUIN_TURN_BEATS` (default OFF) is checked by the CALLER (server.ts). OFF
// ⇒ neither `turnBeatTick` nor `gradeStagedTurnBeat` is ever called ⇒ no map entry, no
// model call, no file → byte-identical to today. Mirrors DUIN_RECALL_CAL / DUIN_SKILL_EMBED.

import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { CAL_MIN_N } from '../brain/calibration-resolve-native'
import { properScore, type ScoredForecast, type ProperScore } from '../brain/calibration-scoring'
import { fitPlatt, recalibrate, type PlattParams } from '../brain/calibration-recalibrate'
import { routeModel, chatOnce } from '../providers/registry'
import { messageOf } from '../guarded'

/** One turn-beat: a turn-N prediction of turn N+1's track, graded once N+1 arrives. */
export interface TurnBeat {
  id: string
  threadId: string
  turnIndex: number
  created: number
  /** The predicted track for the NEXT turn (an ontology key, or null = "no track"). */
  predicted_track: string | null
  /** Logged-not-scored in Phase A. */
  predicted_action_class: string
  /** Logged-not-scored in Phase A — a short natural-language next-beat guess. */
  next_beat: string
  confidence: number
  /** The dumb baseline: the CURRENT turn's track ("predict continue"). */
  baseline_track: string | null
  // ── filled at grade time (turn N+1) ──
  actual_track?: string | null
  hit?: boolean
  baseline_hit?: boolean
  graded?: boolean
}

/** Aggregate outcome over graded beats — the KindRate analogue (rate / observed / gated),
 *  carrying BOTH the predictor rate and the baseline it must beat. */
export interface TurnBeatRate {
  /** predictor hit-rate over graded beats; null if none observed. */
  hitRate: number | null
  /** "stay on current track" baseline hit-rate; null if none observed. */
  baselineRate: number | null
  observed: number // graded beats
  hits: number
  misses: number
  baselineHits: number
  gated: boolean // observed < minN → too thin to trust
}

/** The kill-switch. Phase-1 moat-sprint (2026-07-09): flipped to default ON so the fast
 *  self-resolving signal ACCRUES on the live instance — this is the cheapest path to a real,
 *  growing Brier (turn-beats resolve in one turn vs weeks for slow convergence forecasts).
 *  Set `DUIN_TURN_BEATS=0` to restore the old byte-identical-to-today behavior (explicit OFF).
 *  Still side-effect-free on the reply by construction: the pass is log-only, never injected. */
export function turnBeatsEnabled(): boolean {
  const v = (process.env.DUIN_TURN_BEATS ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

function ledgerPath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'turn-beats.jsonl')
}

/** Read the beat ledger (skipping blank/corrupt lines). Pure fs — missing file → []. */
export function readBeats(vaultDir: string | null): TurnBeat[] {
  if (!vaultDir) return []
  let text: string
  try {
    text = readFileSync(ledgerPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const out: TurnBeat[] = []
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      out.push(JSON.parse(ln) as TurnBeat)
    } catch (e) { console.debug('[turn-beats] skip corrupt line:', messageOf(e)) }
  }
  return out
}

/** Append one beat row. Single-writer, atomic (one appendFileSync = one O_APPEND
 *  syscall). Best-effort — never throws into the caller (measurement must never break a
 *  turn). Only GRADED beats are persisted (mirrors recall-efficacy's write-at-grade). */
export function writeBeat(vaultDir: string | null, beat: TurnBeat): void {
  if (!vaultDir) return
  try {
    const p = ledgerPath(vaultDir)
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(beat) + '\n', 'utf-8')
  } catch (e) { console.debug('[turn-beats] measurement accrual is upkeep  never affects the turn:', messageOf(e)) }
}

/** PURE grade: stamp a staged beat with the turn-N+1 ground truth. hit = predictor got
 *  the track; baseline_hit = "stay on current track" got it. */
export function gradeBeat(beat: TurnBeat, actualTrack: string | null): TurnBeat {
  return {
    ...beat,
    actual_track: actualTrack,
    hit: beat.predicted_track === actualTrack,
    baseline_hit: beat.baseline_track === actualTrack,
    graded: true
  }
}

/**
 * Aggregate graded beats → predictor hit-rate vs baseline-rate, gated below minN. PURE —
 * the whole scoring model lives here (a richer signal is a change to THIS function
 * alone). Ungraded rows are ignored (only graded beats carry ground truth).
 */
export function aggregateTurnBeats(beats: TurnBeat[], minN = CAL_MIN_N): TurnBeatRate {
  let observed = 0
  let hits = 0
  let baselineHits = 0
  for (const b of beats) {
    if (!b.graded) continue
    observed += 1
    if (b.hit) hits += 1
    if (b.baseline_hit) baselineHits += 1
  }
  return {
    hitRate: observed > 0 ? hits / observed : null,
    baselineRate: observed > 0 ? baselineHits / observed : null,
    observed,
    hits,
    misses: observed - hits,
    baselineHits,
    gated: observed < minN
  }
}

/** kind → rate helper: expose the aggregate as a single-entry `turn-beat` reference class
 *  in the same shape `loadRecallEfficacy` / `loadKindRates` return, WITHOUT touching the
 *  WS1 calibration files. Callers that want the beat rate on the unified surface read
 *  this; nothing pools it with the slow forecast kinds. */
export function loadTurnBeatRate(vaultDir: string | null, minN = CAL_MIN_N): TurnBeatRate {
  return aggregateTurnBeats(readBeats(vaultDir), minN)
}

// ──────────────────── proper score (the moat instrument, turn-beat namespace) ────────────────────
// Phase-1 A1: track-match hit-rate answers "does the predictor beat 'stay on track'?" — but it
// says nothing about whether the CONFIDENCE is calibrated. That's what the moat needs. Each graded
// beat is a probabilistic claim (confidence) with a binary outcome (hit), so it is directly
// proper-scorable by the SAME instrument the slow forecast ledger uses — no new math, a separate
// namespace (turn-beats.jsonl), so it never pollutes the slow convergence north-star Brier.

/** The unified turn-beat score: the structural track-match rate + a PROPER score (Brier/log-loss/
 *  Murphy skill/ECE) over the predictor's stated confidence vs its hit/miss. */
export interface TurnBeatScore {
  trackMatch: TurnBeatRate
  calibration: ProperScore
}

/** Map graded beats → (confidence, outcome=hit) proper-scorable pairs. Ungraded rows carry no
 *  ground truth and are excluded (same honesty as aggregateTurnBeats). PURE. */
export function beatsToScored(beats: TurnBeat[]): ScoredForecast[] {
  const out: ScoredForecast[] = []
  for (const b of beats) {
    if (!b.graded) continue
    const c = typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? Math.max(0, Math.min(1, b.confidence)) : null
    if (c == null) continue
    out.push({ confidence: c, outcome: b.hit ? 1 : 0 })
  }
  return out
}

/** Read side for /state/turn-beats: structural track-match rate + a proper Brier over confidence.
 *  Reuses the forecast ledger's `properScore` (skillScore gated below minN, identical discipline). */
export function scoreTurnBeats(vaultDir: string | null, minN = CAL_MIN_N): TurnBeatScore {
  const beats = readBeats(vaultDir)
  return {
    trackMatch: aggregateTurnBeats(beats, minN),
    calibration: properScore(beatsToScored(beats), minN)
  }
}

// ──────────────────── recalibration (Phase-1: turn a negative skill score positive) ────────────────────
// The live beat stream is OVERconfident (says 0.9, right ~0.4) → skillScore < 0. The fix is a fitted
// Platt squash toward the base rate (a<1 = shrink), NOT extremization (a>1 = sharpen, the fix for an
// UNDERconfident / aggregated stream). We DON'T use `fitRecalibration` here: its `skill>0` gate is
// right for the forecast/extremize path (never sharpen a cold ledger) but wrong for over-confidence
// repair, where shrinking a sub-baseline predictor toward the base rate STRICTLY helps. Honesty is
// enforced instead by LEAVE-ONE-OUT scoring: each point is recalibrated by a Platt fit that never saw
// it, so the reported improvement can't be in-sample optimism. The raw beat ledger is never mutated
// (the logged confidence stays the model's actual claim — recalibration is a read-time transform).

export interface RecalibratedScore {
  raw: ProperScore
  /** Leave-one-out recalibrated proper score — leakage-free (each point scored by a fit that
   *  excluded it). The honest "what a fitted recalibration achieves out-of-sample" number. */
  recalibrated: ProperScore
  /** Global Platt params over ALL rows (diagnostic): a<1 ⇒ OVERconfident, fix = shrink toward base
   *  rate; a>1 ⇒ underconfident, fix = extremize. b shifts the curve. null if too thin. */
  params: PlattParams | null
  /** Honest gate: recommend applying only if LOO recalibration actually lowers Brier. */
  improves: boolean
  n: number
}

/** PURE leave-one-out recalibration over already-extracted (confidence, outcome) pairs. Reuses
 *  fitPlatt/recalibrate — no new calibration math. Cheap at these n (n fits × bounded iters). */
export function recalibrateScored(scored: ScoredForecast[], minN = CAL_MIN_N): RecalibratedScore {
  const n = scored.length
  const raw = properScore(scored, minN)
  if (n < minN) return { raw, recalibrated: raw, params: null, improves: false, n }
  const loo: ScoredForecast[] = scored.map((pt, i) => ({
    confidence: recalibrate(pt.confidence, fitPlatt(scored.filter((_, j) => j !== i))),
    outcome: pt.outcome
  }))
  const recalibrated = properScore(loo, minN)
  const params = fitPlatt(scored)
  const improves = raw.brier != null && recalibrated.brier != null && recalibrated.brier < raw.brier
  return { raw, recalibrated, params, improves, n }
}

/** The unified turn-beat report: structural rate + raw proper score + the LOO-recalibrated score.
 *  Reads the ledger ONCE. Read side for /state/turn-beats. */
export interface TurnBeatReport {
  trackMatch: TurnBeatRate
  calibration: ProperScore
  recalibration: RecalibratedScore
}
export function turnBeatReport(vaultDir: string | null, minN = CAL_MIN_N): TurnBeatReport {
  const beats = readBeats(vaultDir)
  const scored = beatsToScored(beats)
  return {
    trackMatch: aggregateTurnBeats(beats, minN),
    calibration: properScore(scored, minN),
    recalibration: recalibrateScored(scored, minN)
  }
}

// ──────────────────── the prediction pass (cheap, structured, keyless-safe) ────────────────────

/** Grounding for the prediction pass. GOALS text is DUMPED (read, not graph-walked). */
export interface BeatGrounding {
  goalsText: string
  /** The last 6 turns, oldest→newest, as {role, content}. */
  recentTurns: { role: string; content: string }[]
  /** Operator facts, dumped as short lines (the memory index). */
  operatorFacts: { fact: string }[]
  /** The current turn's track (baseline) + the known track keys to choose from. */
  currentTrack: string | null
  trackKeys: string[]
}

export interface BeatPrediction {
  predicted_track: string | null
  predicted_action_class: string
  next_beat: string
  confidence: number
}

const BEAT_SYSTEM =
  'You forecast the operator\'s NEXT conversational turn — one beat ahead. ' +
  'You are a silent background analyst: your output is logged and scored, NEVER shown to the user and NEVER added to any reply. ' +
  'Given the operator\'s goals, recent turns, learned facts, and the track the current turn is on, predict what the NEXT turn will be about. ' +
  'Reply with JSON ONLY, no prose: ' +
  '{"predicted_track": one of the provided track keys or null if none fits, ' +
  '"predicted_action_class": a short verb-noun class e.g. "ask-followup" | "decide" | "switch-topic" | "provide-info" | "close", ' +
  '"next_beat": one short sentence naming the likely next move, ' +
  '"confidence": a number 0..1}.'

/** PURE — build the two-message prompt for the prediction pass. Unit-testable; no I/O. */
export function buildBeatPrompt(g: BeatGrounding): { role: 'system' | 'user'; content: string }[] {
  const goals = g.goalsText.trim() ? g.goalsText.trim().slice(0, 4000) : '(no goals on record)'
  const turns = g.recentTurns.length
    ? g.recentTurns.map((t) => `${t.role}: ${(t.content || '').slice(0, 500)}`).join('\n')
    : '(no prior turns)'
  const facts = g.operatorFacts.length
    ? g.operatorFacts.slice(0, 30).map((f) => `- ${f.fact}`).join('\n')
    : '(none learned yet)'
  const keys = g.trackKeys.length ? g.trackKeys.join(', ') : '(no tracks defined)'
  return [
    { role: 'system', content: BEAT_SYSTEM },
    {
      role: 'user',
      content:
        `KNOWN TRACK KEYS: ${keys}\n` +
        `CURRENT TURN IS ON TRACK: ${g.currentTrack ?? 'none'}\n\n` +
        `OPERATOR GOALS (dumped):\n${goals}\n\n` +
        `RECENT TURNS (oldest→newest):\n${turns}\n\n` +
        `LEARNED OPERATOR FACTS:\n${facts}\n\n` +
        'Predict the NEXT turn as JSON.'
    }
  ]
}

/** PURE — parse a model reply into a BeatPrediction, or null if unusable. Tolerant:
 *  finds the first JSON object, coerces fields, normalizes empty/"none" track → null. */
export function parseBeatResponse(text: string | null, validKeys: string[]): BeatPrediction | null {
  if (!text) return null
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
  const rawTrack = typeof j.predicted_track === 'string' ? j.predicted_track.trim() : ''
  const norm = rawTrack.toLowerCase()
  // Accept only a known track key (case-insensitive); everything else → null ("no track").
  const matched = validKeys.find((k) => k.toLowerCase() === norm) ?? null
  const predicted_track = norm && norm !== 'none' && norm !== 'null' ? matched : null
  let confidence = Number(j.confidence)
  if (!Number.isFinite(confidence)) confidence = 0
  confidence = Math.max(0, Math.min(1, confidence))
  return {
    predicted_track,
    predicted_action_class: typeof j.predicted_action_class === 'string' ? j.predicted_action_class.trim().slice(0, 60) : '',
    next_beat: typeof j.next_beat === 'string' ? j.next_beat.trim().slice(0, 200) : '',
    confidence
  }
}

/** The model seam (mirrors decision-simulator's injectable runModel). Default routes a
 *  CHEAP extraction model + chatOnce; null/keyless → null → NO beat, no throw. */
export type RunBeatModel = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string | null>

async function defaultRunBeatModel(messages: { role: 'system' | 'user'; content: string }[]): Promise<string | null> {
  const model = routeModel('extraction')
  if (!model) return null
  try {
    const r = await chatOnce(messages as never, model, undefined, { purpose: 'other', role: 'turn-beat' })
    return r.content
  } catch {
    return null
  }
}

// ──────────────────── per-thread staging (the recall-efficacy mirror) ────────────────────
// Turn N's beat awaits turn N+1's actual track. Held per thread, bounded, evicted oldest.

const stagedByThread = new Map<string, TurnBeat>()
const MAX_THREADS = 200

function evict(): void {
  if (stagedByThread.size > MAX_THREADS) {
    const oldest = stagedByThread.keys().next().value
    if (oldest !== undefined) stagedByThread.delete(oldest)
  }
}

export interface TurnBeatTickInput {
  vaultDir: string | null
  threadId: string
  turnIndex: number
  grounding: BeatGrounding
  /** Test seam — inject a model runner; omitted → the real cheap extraction call. */
  runModel?: RunBeatModel
}

/**
 * STORE side (call in the post-turn tick cluster, beside successTick / recallEfficacyTick):
 * run the cheap prediction pass for THIS turn and STAGE the beat for the next turn to
 * grade. Keyless / null model / unparseable reply → returns null (NO beat staged, no
 * throw — the honest "flat pass" skips rather than fabricates). Best-effort throughout.
 */
export async function turnBeatTick(input: TurnBeatTickInput): Promise<TurnBeat | null> {
  const { vaultDir, threadId, turnIndex, grounding } = input
  const run = input.runModel ?? defaultRunBeatModel
  try {
    const text = await run(buildBeatPrompt(grounding))
    const pred = parseBeatResponse(text, grounding.trackKeys)
    if (!pred) return null
    const beat: TurnBeat = {
      id: randomUUID(),
      threadId: threadId || 'default',
      turnIndex,
      created: Date.now(),
      predicted_track: pred.predicted_track,
      predicted_action_class: pred.predicted_action_class,
      next_beat: pred.next_beat,
      confidence: pred.confidence,
      baseline_track: grounding.currentTrack,
      graded: false
    }
    stagedByThread.set(beat.threadId, beat)
    evict()
    return beat
  } catch {
    /* measurement pass — never break the turn */
    return null
  }
}

/**
 * GRADE side (call near turn-open on turn N+1): if a beat is staged for this thread,
 * grade it against THIS turn's actual track, persist the graded row, and clear the
 * staging slot. Returns the graded beat (for tests/telemetry) or null. Best-effort.
 */
export function gradeStagedTurnBeat(vaultDir: string | null, threadId: string, actualTrack: string | null): TurnBeat | null {
  const key = threadId || 'default'
  try {
    const staged = stagedByThread.get(key)
    if (!staged) return null
    stagedByThread.delete(key)
    const graded = gradeBeat(staged, actualTrack)
    writeBeat(vaultDir, graded)
    return graded
  } catch {
    return null
  }
}

/** Test seam — clear the per-thread staging state. */
export function __resetTurnBeats(): void {
  stagedByThread.clear()
}

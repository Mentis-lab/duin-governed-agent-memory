// turn-watchdog.ts — progress-aware per-turn budget for the brain path. PURE +
// unit-testable off the HTTP server.
//
// The old budget was a single flat wall-clock cap (DUIN_TURN_DEADLINE_MS=180s):
// it guillotined a legitimately long "dispatch agents" turn at 3 min even while
// it was productively streaming tool results. This replaces it with TWO
// independent limits so long-but-productive turns finish while true hangs and
// slow-runaways are still bounded:
//
//   • stallMs — cut when there has been NO forward progress (streamed tokens or
//     tool results) for this long. Catches a genuine hang fast, regardless of
//     total time. Heartbeats are NOT progress (a stalled turn still heartbeats,
//     so counting them would let it live forever). Each tool is separately
//     capped (R4 per-tool timeout, 60s default), so a healthy agent task keeps
//     producing tool results inside the stall window and never false-cuts.
//   • maxMs — an ABSOLUTE wall-clock ceiling. A hard backstop so a turn that
//     dribbles a token every few seconds forever can't run unbounded.
//
// Both env-tunable; 0 disables that limit. Back-compat: DUIN_TURN_DEADLINE_MS,
// if explicitly set, overrides the ceiling (so an operator who pinned 300s or
// disabled it with 0 keeps that behavior).

export interface WatchdogConfig {
  /** Idle cut: ms of no progress (tokens/tools) before the turn is stalled. 0 disables. */
  stallMs: number
  /** Absolute wall-clock ceiling in ms. 0 disables. */
  maxMs: number
}

export type WatchdogReason = 'stalled' | 'max-wallclock'

/** How often the server polls the watchdog. Small enough to react promptly,
 *  large enough to be negligible overhead. */
export const WATCHDOG_TICK_MS = 5_000

function envNum(v: string | undefined, def: number): number {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? n : def
}

/** Was DUIN_TURN_DEADLINE_MS explicitly set (to any finite number, including 0)? */
function legacyDeadlineSet(env: NodeJS.ProcessEnv): boolean {
  const v = env.DUIN_TURN_DEADLINE_MS
  return v != null && v !== '' && Number.isFinite(Number(v))
}

export function watchdogConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  // No hard time CEILING by default — modern multi-agent turns legitimately run
  // for an hour+, so a fixed wall-clock cap would guillotine real work. The STALL
  // cut is the real hang protection (it fires regardless of total time, and
  // sub-agent activity counts as progress), plus the operator can always Cancel.
  // Set DUIN_TURN_MAX_MS (or the legacy DUIN_TURN_DEADLINE_MS) to opt into a cap.
  const maxMs = legacyDeadlineSet(env)
    ? Number(env.DUIN_TURN_DEADLINE_MS) // legacy override wins (incl. 0 = disable ceiling)
    : envNum(env.DUIN_TURN_MAX_MS, 0) // 0 = no absolute ceiling by default
  return {
    stallMs: envNum(env.DUIN_TURN_STALL_MS, 90_000),
    maxMs: maxMs < 0 ? 0 : maxMs
  }
}

/**
 * Decide whether to cut the turn. The ceiling is checked before the stall so a
 * turn that is both over-time AND stalled reports 'max-wallclock' (the stronger,
 * clearer signal). Uses >= so an exactly-at-limit tick fires.
 */
export function watchdogVerdict(
  now: number,
  turnStart: number,
  lastProgressAt: number,
  cfg: WatchdogConfig
): { cut: boolean; reason?: WatchdogReason } {
  if (cfg.maxMs > 0 && now - turnStart >= cfg.maxMs) return { cut: true, reason: 'max-wallclock' }
  if (cfg.stallMs > 0 && now - lastProgressAt >= cfg.stallMs) return { cut: true, reason: 'stalled' }
  return { cut: false }
}

// ── Long-turn notices ────────────────────────────────────────────────────────────────────
// Property 8, in the one place it costs the operator most: with no absolute ceiling (the
// deliberate choice above — real multi-agent turns run for an hour), "still working" and
// "wedged" are the SAME observation from outside. The turn is not unbounded (the round loop
// caps at MAX_TOOL_ROUNDS), but nothing ever SAYS so, and a request that takes 90s with the
// reasoning panel scrolling is indistinguishable from one that will never return.
//
// Measured 2026-08-02 on the deployed build: a 双周报 request ran past 240s emitting reasoning
// and tool calls the whole time. Neither limit above should have fired — it was making
// progress — and neither did. What was missing was not a cut. It was a sentence.
//
// The remedy is the one property 8 prescribes: one more value. An explicit "working, round N,
// Xs elapsed" state, distinct from silence, so a long turn is legible while it is still long.
// Notices are advisory only — they never abort, never touch progress, and never gate anything.

/** First notice at this elapsed ms, then one every `everyMs`. 0 on either disables notices. */
export interface NoticeConfig {
  firstMs: number
  everyMs: number
}

export function noticeConfig(env: NodeJS.ProcessEnv = process.env): NoticeConfig {
  // Deliberately longer than a normal turn (most close well inside 45s) so this stays silent
  // on healthy work and only speaks when the operator has started to wonder.
  return {
    firstMs: envNum(env.DUIN_TURN_NOTICE_FIRST_MS, 45_000),
    everyMs: envNum(env.DUIN_TURN_NOTICE_EVERY_MS, 30_000)
  }
}

/**
 * Is notice number `sent + 1` due at `elapsedMs`? Notice k (1-based) is due at
 * firstMs + (k-1)*everyMs. Returns false when either bound is <= 0 (disabled), which keeps
 * "notices off" distinguishable from "notice not yet due" at the call site rather than
 * collapsing both into a bare false-by-arithmetic.
 */
export function noticeDue(elapsedMs: number, sent: number, cfg: NoticeConfig): boolean {
  if (cfg.firstMs <= 0 || cfg.everyMs <= 0) return false
  // BACK OFF on repeats. A flat interval turns a two-minute tool call into a wall of
  // near-identical lines — observed verbatim, five consecutive "round 4/32" notices at
  // 75/105/135/165/195s, which reads as malfunction rather than as reassurance. The gap
  // doubles each time (30s, 60s, 120s, …) and is capped, so a turn that really is long
  // still shows life without narrating every half minute.
  //
  // Gap k (1-based) = everyMs * 2^(k-1), capped at NOTICE_MAX_GAP_MS. Notice k is due at
  // firstMs + the sum of the gaps before it.
  let due = cfg.firstMs
  for (let k = 0; k < sent; k++) {
    due += Math.min(cfg.everyMs * 2 ** k, NOTICE_MAX_GAP_MS)
  }
  return elapsedMs >= due
}

/** Ceiling on the backed-off notice gap, so a very long turn still speaks every few minutes. */
export const NOTICE_MAX_GAP_MS = 240_000

/**
 * Is a heartbeat WORTH sending right now?
 *
 * The notice exists to separate "working" from "hung". When tokens are actively
 * streaming, the operator can already see it is working — the reasoning panel is
 * scrolling — so a status line saying the same thing is pure noise laid on top of the
 * content it is describing. Stay quiet unless the turn has gone visibly quiet.
 *
 * `quietMs` is deliberately shorter than the stall cut: the point is to speak while the
 * turn is still healthy but silent (a long tool call), not to duplicate the stall alarm.
 */
export function noticeWorthSending(
  now: number,
  lastProgressAt: number,
  quietMs: number = NOTICE_QUIET_MS
): boolean {
  return now - lastProgressAt >= quietMs
}

/** How silent a turn must be before a heartbeat adds information. */
export const NOTICE_QUIET_MS = 10_000

/** The operator-facing line. Round is 1-based; `cap` 0 means the loop has not started yet. */
export function noticeLabel(elapsedMs: number, round: number, cap: number): string {
  const secs = Math.round(elapsedMs / 1000)
  const where = cap > 0 ? `round ${Math.min(round, cap)}/${cap}` : 'preparing'
  return `still working — ${where} · ${secs}s elapsed`
}

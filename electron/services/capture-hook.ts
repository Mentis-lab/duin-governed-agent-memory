// capture-hook — the DETERMINISTIC learning-capture arrow.
//
// Why this exists: the `capture` skill (operator-brain plugin) relies on the chat
// model choosing to `skill_open` → read → curl on a correction turn. Live testing
// (2026-07-03, GLM 5.2) showed that is unreliable — the model acknowledges the
// correction in prose, or even claims "Persisted" while making no tool call, and
// the learn ledger never moves. So the always-on capture step must NOT depend on
// model self-invocation.
//
// This module fires deterministically on every user turn: if the turn is
// correction/validation-shaped AND reacts to the prior assistant output, it
// extracts {correction, why, candidate_rule, polarity} and records it into the
// same learn loop the app already uses (POST /learn/correction → corrections.jsonl
// → reflect + taste). It mirrors CorrectionRow exactly and never sends `source`
// (the engine 400s on machine rows — this stream is operator-only).
//
// The `why` extraction here is heuristic (reasoning-connective clauses). It is the
// field the existing native verdict path leaves empty by design; capturing even a
// heuristic `why` is strictly better than the current empty-`why` rows. Production
// can swap `extractCorrection` for a focused extraction call — the TRIGGER and the
// WRITE stay deterministic either way; only the semantic extraction gets richer.

export interface CaptureRow {
  ts: string
  session: string
  skill: string
  artifact: string
  ai_output: string
  correction: string
  why: string
  candidate_rule: string
  polarity: 'correction' | 'positive'
}

export interface DetectResult {
  hit: boolean
  polarity?: 'correction' | 'positive'
  reason: string
}

// ──────────────────── detection (precision gate + signal) ────────────────────
//
// LANGUAGE POLICY — every gate below decides on natural-language MEANING, so every
// gate carries BOTH an ASCII and a CJK alternation (PLANNING/DUIN_LOOP_AND_SURFACE_
// COMPLETION.md §0.0 and item 3.0). `\b` is deliberately absent from all six: a JS
// word boundary needs a \w on exactly one side, and Han characters are not \w, so a
// `\b`-anchored alternation can never match inside Chinese text. That was half the
// original defect — measured 6/6 Chinese corrections DROPPED against 4/4 English
// CAPTURED, while the very same loop's `isEndorsement` was already bilingual. Where
// the ASCII half genuinely needs a boundary it uses (?<![A-Za-z]) / (?![A-Za-z]),
// which constrain the Latin script only and leave CJK matching untouched.
//
// The CJK vocabulary is distributed across STRONG/WEAK/RULE by the SAME strength
// rule the ASCII half already encodes, not dumped into one gate: a marker that
// asserts a correction on its own goes in STRONG, a bare imperative that is equally
// common in ordinary instructions goes in WEAK (where it needs a lead or a rule/why
// clause to count), and an ambiguous marker goes only in IMPERATIVE_RULE, which
// qualifies another signal but never fires a capture by itself.

// Negation leads — "no/nope/wrong…" · 不对 / 错了 / 不是 / 别.
const CORRECTION_LEAD =
  /^\s*(no+(?![A-Za-z])|nope(?![A-Za-z])|not quite|not really|actually,|wrong(?![A-Za-z])|incorrect(?![A-Za-z])|that'?s not|that isn'?t|不对劲|不对|错了|不是|别(?!的))/i
// STRONG correction signals — override/rule phrasing that carries judgment on its own.
// CJK: obligation 应该/必须 (the "should be" analogue) plus the standing-rule markers
// that are unambiguous in isolation — 以后/今后 mirror "from now on"/"going forward",
// which the ASCII half likewise carries in BOTH this gate and IMPERATIVE_RULE.
// 下次/每次/默认 are NOT here: "下次再说" and "默认是关闭的" are ordinary talk.
const CORRECTION_STRONG =
  /(?<![A-Za-z])(instead(?![A-Za-z])|rather than|should(?:'ve| have)? (?:be|been|lead|say)|from now on|going forward|make (?:that|this) a (?:standing )?rule|standing rule|persist this|remember (?:this|that)|not the(?![A-Za-z]))|应该|必须|以后|今后|一律|都要/i
// WEAK correction signals — bare imperatives that are just as common in ordinary
// instructions ("don't forget to commit", "stop the dev server"). They count as a
// correction ONLY alongside a lead or a reasoning/rule clause, never on their own.
// CJK: obligation 要/请 belong here for exactly that reason. The lookarounds strip the
// compounds where the character is not an imperative at all — 重要/需要/只要/主要/想要,
// 要求/要是, 申请/邀请.
const CORRECTION_WEAK =
  /(?<![A-Za-z])(don'?t(?![A-Za-z])|do not(?![A-Za-z])|never(?![A-Za-z])|always(?![A-Za-z])|stop(?![A-Za-z]))|不要|别|(?<![重需只主想])要(?![求是])|(?<![申邀])请/i
// The rule clause. Its tail also stops at CJK sentence enders — `[^.!?]*` runs straight
// through 。！？ and would swallow the rest of a Chinese turn into candidate_rule.
const IMPERATIVE_RULE =
  /(?<![A-Za-z])(always(?![A-Za-z])[^.!?。！？\n]*|never(?![A-Za-z])[^.!?。！？\n]*|from now on[^.!?。！？\n]*|going forward[^.!?。！？\n]*|make (?:that|this) a (?:standing )?rule[^.!?。！？\n]*|persist this[^.!?。！？\n]*|standing rule[^.!?。！？\n]*|remember (?:this|that)[^.!?。！？\n]*)|(?:以后|今后|下次|每次|都要|一律|默认)[^.!?。！？\n]*/i
// VALIDATION — a substantive endorsement clause (fires anywhere), or a leading
// acknowledgment ("Yes,"/"Right,") that is NOT merely a pivot into a new question.
const VALIDATION_SUBSTANTIVE =
  /(?<![A-Za-z])(keep doing|that'?s exactly|that framing was|nailed it|spot on|good call|that'?s right)(?![A-Za-z])|就是这样|说得对|没错|很好/i
// 对 needs a boundary of its own: bare 对 is an endorsement, but it opens 对方/对比/
// 对不起 too, so it only counts when a punctuation mark or the end of the turn follows.
const VALIDATION_LEAD =
  /^\s*(yes(?![A-Za-z])|yep(?![A-Za-z])|yeah(?![A-Za-z])|exactly(?![A-Za-z])|correct(?![A-Za-z])|right(?![A-Za-z])|perfect(?![A-Za-z])|great(?![A-Za-z])|没错|就是这样|很好|说得对|对(?=[，,。.！!？?\s]|$))/i
const isValidationText = (x: string): boolean => VALIDATION_LEAD.test(x) || VALIDATION_SUBSTANTIVE.test(x)

// Precision gate — turns that are NOT operator judgment. These two match machine-emitted
// markers (`system:`, `[hook]`, `cron`, the harness's own English probes) rather than
// operator language, so they stay ASCII. NOT a claim that they are complete: a Chinese
// scheduled-task preamble is still unfiltered — a residual precision gap, not this gate's
// deafness, and it can only cause over-capture, never the silent drop this file fixes.
const INJECTED =
  /(connectivity test|role[- ]?prompt|engine[- ]?prompt|^system:|\[hook\]|scheduled task|cron\b|this is a test\b|are you (?:there|online|connected))/i
const META_LOOP =
  /^\s*(approve|reject|veto)\b.*\b(all|rest|everything)\b|rest (?:is|are) (?:fine|approved|good|ok)|a\d+ (?:not relevant|approved)/i

// Reasoning connectives — the `why` lives in clauses like these.
const REASONING =
  /(?<![A-Za-z])(because|since|as they|so that|so they|so you|so leadership|otherwise|at our stage|the reason|that way|to avoid|in order to|else|too late|reads? the|needs? the|means? the|leads? to)(?![A-Za-z])|因为|由于|所以|否则|避免|不然|以免/i

// Chinese is not whitespace-delimited, so the previous `(s.match(/\S+/g)||[]).length`
// scored an entire Chinese sentence as ONE token and the `< 6` bare-fix gate below then
// discarded it. That is a SECOND language barrier, independent of the regexes above and
// surviving them: bilingual gates alone still leave a short Chinese correction unreachable.
// A Han character carries roughly half a word of information, so CJK codepoints are counted
// separately and worth half each, alongside the Latin word count.
// language: structural — these two match SCRIPT RANGES, not vocabulary; there is no
// meaning to translate and no alternation to add.
const CJK_CHAR = /[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/g
// language: structural
// Ranges written as escapes, not literals: the literal U+3000 IDEOGRAPHIC SPACE that used
// to open this class is invisible in an editor and trips no-irregular-whitespace.
const CJK_PUNCT = /[\u3000-\u303F\uFF00-\uFFEF]/g

/** How much judgment a turn carries, in word-equivalents, in any script. PURE. */
export function significance(s: string): number {
  const t = (s ?? '').trim()
  const cjk = (t.match(CJK_CHAR) || []).length
  // Strip CJK punctuation as well as the glyphs before counting Latin words: a lone
  // "，" left behind is a \S+ run and would otherwise be counted as an English word.
  const latin = (t.replace(CJK_CHAR, ' ').replace(CJK_PUNCT, ' ').match(/\S+/g) || []).length
  return latin + Math.ceil(cjk / 2)
}

/** Decide whether a user turn is a capture-worthy reaction to the prior assistant output. */
export function detectCorrection(prevAssistant: string | null, userMsg: string): DetectResult {
  const msg = (userMsg || '').trim()
  if (!prevAssistant || !prevAssistant.trim()) return { hit: false, reason: 'no-prior-assistant' }
  if (!msg) return { hit: false, reason: 'empty' }
  if (INJECTED.test(msg)) return { hit: false, reason: 'machine-injected' }
  if (META_LOOP.test(msg)) return { hit: false, reason: 'loop-admin' }

  const isLead = CORRECTION_LEAD.test(msg)
  const hasRuleOrWhy = IMPERATIVE_RULE.test(msg) || REASONING.test(msg)
  // A bare weak imperative (don't/never/always/stop) is only a correction with a lead or
  // an explicit rule/reasoning clause — otherwise ordinary instructions get mis-captured.
  const isCorrection = isLead || CORRECTION_STRONG.test(msg) || (CORRECTION_WEAK.test(msg) && hasRuleOrWhy)
  // A leading acknowledgment that pivots straight into a question ("Right, so what about…?")
  // is not an endorsement — require a substantive endorsement or a non-question ack.
  const isQuestionPivot = /\?\s*$/.test(msg)
  const isValidation = VALIDATION_SUBSTANTIVE.test(msg) || (VALIDATION_LEAD.test(msg) && !isQuestionPivot)
  if (!isCorrection && !isValidation) return { hit: false, reason: 'no-signal' }

  // Bare factual fix: terse, no reasoning, no reusable rule → not judgment worth keeping.
  if (isCorrection && significance(msg) < 6 && !REASONING.test(msg) && !IMPERATIVE_RULE.test(msg)) {
    return { hit: false, reason: 'bare-fix' }
  }
  // Correction wins over validation when both fire (an override carries more signal).
  return { hit: true, polarity: isCorrection ? 'correction' : 'positive', reason: 'signal' }
}

// ──────────────────── extraction (heuristic why + rule) ────────────────────

function splitSentences(s: string): string[] {
  // CJK sentences are not whitespace-delimited: `(?<=[.!?])\s+` never fires on 。！？，
  // so a whole Chinese turn arrived here as ONE sentence and the why/override split
  // collapsed. The zero-width `(?<=[。！？；])\s*` arm splits after a CJK ender whether
  // or not a space follows.
  return s
    .split(/(?<=[.!?])\s+|(?<=[。！？；])\s*|\s*[—–]\s*|\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

export interface Extracted {
  correction: string
  why: string
  candidate_rule: string
}

/** Pull the override, the reasoning (why), and any explicit reusable rule from the turn. */
export function extractCorrection(userMsg: string, polarity: 'correction' | 'positive'): Extracted {
  const sentences = splitSentences(userMsg)
  const whyParts = sentences.filter((x) => REASONING.test(x))
  const why = whyParts.join(' ').trim()

  const ruleMatch = userMsg.match(IMPERATIVE_RULE)
  const candidate_rule = ruleMatch ? ruleMatch[0].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '') : ''

  if (polarity === 'positive') {
    // Endorsement — the confirmed rule is the signal; correction stays empty.
    const rule = candidate_rule || sentences.filter((x) => !isValidationText(x)).join(' ').trim()
    return { correction: '', why, candidate_rule: rule }
  }
  // Correction — the override sentence(s), preferring ones that aren't purely the why.
  const overrideParts = sentences.filter((x) => !whyParts.includes(x))
  const correction = (overrideParts.length ? overrideParts : sentences).join(' ').trim()
  return { correction, why, candidate_rule }
}

// ──────────────────── build + post ────────────────────

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

export interface CaptureOpts {
  session?: string
  artifact?: string
  today?: string // YYYY-MM-DD; injected for testability
}

/** Build the CorrectionRow, or null if this turn isn't capture-worthy. */
export function buildCaptureRow(
  prevAssistant: string | null,
  userMsg: string,
  opts: CaptureOpts = {}
): CaptureRow | null {
  const det = detectCorrection(prevAssistant, userMsg)
  if (!det.hit || !det.polarity) return null
  const ex = extractCorrection(userMsg, det.polarity)
  return {
    ts: opts.today ?? new Date().toISOString().slice(0, 10),
    session: opts.session ?? '',
    skill: 'capture-hook',
    artifact: opts.artifact ?? '',
    ai_output: clip((prevAssistant || '').trim(), 400),
    correction: clip(ex.correction, 400),
    why: clip(ex.why, 400),
    candidate_rule: clip(ex.candidate_rule, 200),
    polarity: det.polarity
  }
}

/** The brain ORIGIN to hang `/learn/...` off.
 *
 *  This read DUIN_BRAIN_URL as though it were already a bare origin, while duin-bridge
 *  reads the SAME variable as a full ENDPOINT (its default ends in `/agui`) and also
 *  coerces the retired :8765 stub port back to :8799. One env var, two meanings — so
 *  setting DUIN_BRAIN_URL to the endpoint shape duin-bridge documents made this build
 *  `http://host/agui/learn/correction`, which is not a route, and left the :8765 footgun
 *  unguarded on this path.
 *
 *  Parsed and reduced to `.origin` here, with the same port coercion. Deliberately
 *  inline rather than importing duin-bridge's resolveBrainUrl: this module has no
 *  imports at all by design, and pulling in that graph to share five lines would cost
 *  more than it saves. duin-bridge remains the authority on the variable's shape; if its
 *  coercion changes, this comment is the pointer. */
const STUB_SIDECAR_PORT = '8765'
import { LOCAL_BRAIN_ORIGIN as DEFAULT_BRAIN_ORIGIN } from '../shared/brain-port'

export function origin(): string {
  const raw = (process.env.DUIN_BRAIN_URL || '').trim()
  if (!raw) return DEFAULT_BRAIN_ORIGIN
  try {
    const u = new URL(raw)
    // The legacy stub engine never served these routes.
    if (u.port === STUB_SIDECAR_PORT) return DEFAULT_BRAIN_ORIGIN
    return u.origin
  } catch {
    // Not a URL — hand back what was set, as before, so a caller-side error names it.
    return raw
  }
}

// ──────────────────── one turn, one row (the double-seam guard) ────────────────────
//
// Capture now fires from TWO seams: the renderer's ipc/chat.ts (before the turn runs) and the
// /agui turn boundary (recall-efficacy's tick, after the answer completes). The second seam is
// what finally makes headless, channel and CRON turns audible to Learn — the paths DUIN runs
// UNATTENDED were precisely the ones it never learned from. But a RENDERER turn crosses BOTH
// seams, and both run in the electron main process, so without a guard every renderer correction
// would land in corrections.jsonl twice and one-directionally inflate the very ledger this loop
// exists to keep honest.
//
// The discriminator is the OPERATOR'S TURN TEXT, not the assembled row. The two seams read the
// prior assistant answer from different places — the conversation store vs. the streamed
// accumulator — so their `ai_output` can differ by a trailing newline or a citation while
// describing the SAME turn. The user's message is what they provably share, byte for byte.
//
// TTL-bounded rather than permanent: repeating a judgment later is real signal (recurrence is how
// a theme reaches MIN_BIND), so this only collapses fires close enough in time to be one turn seen
// twice. learn-store's content dedupe is the durable backstop for the cross-restart case an
// in-memory map cannot see.
const TURN_MEMO_TTL_MS = 10 * 60 * 1000
const TURN_MEMO_MAX = 500
const recentTurns = new Map<string, number>()

function sweepTurnMemo(now: number): void {
  for (const [k, t] of recentTurns) if (now - t > TURN_MEMO_TTL_MS) recentTurns.delete(k)
  while (recentTurns.size > TURN_MEMO_MAX) {
    const oldest = recentTurns.keys().next().value
    if (oldest === undefined) break
    recentTurns.delete(oldest)
  }
}

/** Test seam — forget which turns were already captured. */
export function __resetCaptureMemo(): void {
  recentTurns.clear()
}

/**
 * Fire-and-forget: if the turn is correction-shaped, record it into the learn loop.
 * Never throws (best-effort); returns what it did for logging/tests.
 */
export async function runCaptureHook(
  prevAssistant: string | null,
  userMsg: string,
  opts: CaptureOpts = {}
): Promise<{ posted: boolean; reason: string; row?: CaptureRow }> {
  const row = buildCaptureRow(prevAssistant, userMsg, opts)
  if (!row) return { posted: false, reason: detectCorrection(prevAssistant, userMsg).reason }
  // One turn, one row — see the double-seam guard above. Claimed BEFORE the await so the second
  // seam, which fires while this POST is still in flight, sees the claim rather than racing it.
  const memoKey = (userMsg || '').trim()
  const now = Date.now()
  sweepTurnMemo(now)
  if (recentTurns.has(memoKey)) return { posted: false, reason: 'duplicate-turn', row }
  recentTurns.set(memoKey, now)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(origin().replace(/\/$/, '') + '/learn/correction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row), // NB: no `source` field — operator-only stream
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
    // A rejected post captured NOTHING, so it must not keep the claim: releasing it lets the other
    // seam (or a retry) still get this turn into the ledger. Suppression is for rows that LANDED.
    if (!res.ok) recentTurns.delete(memoKey)
    return { posted: res.ok, reason: res.ok ? 'posted' : `http-${res.status}`, row }
  } catch (err) {
    recentTurns.delete(memoKey)
    return { posted: false, reason: `error:${(err as Error)?.message ?? 'post-failed'}`, row }
  }
}

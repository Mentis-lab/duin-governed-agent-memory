// Grounding assembly — relocated verbatim from server.ts (pure move).
// buildGroundedMessages + its exclusive helpers (hitsToContext, readPinnedNote,
// buildBeatGrounding). handleAgui imports readPinnedNote/buildBeatGrounding/
// buildGroundedMessages back. readSettings/recallCalEnabled/docAbspath are shared
// server infra imported from ./server.
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { type AguiMessage, readSettings, recallCalEnabled, docAbspath } from './server'
import { type BeatGrounding } from './turn-beats'
import { buildMemoryIndexBlock } from '../memory-store'
import { searchSessions, type SessionSearchHit } from '../conversation-store'
import { runLearningShadow } from '../brain/learning-metabolism'
import { stalenessTrust, shouldFuseStaleness } from '../brain/grounding-eval-live'
import { buildOperatorBlock, getOperatorFacts, isQuarantinedExternal, groundingReliability, isLowTrustDerived } from '../brain/operator-model'
import { loadBrain, buildBrainGroundingBlock } from '../brain/brain-root'
import { getSkillGrounding, getSkillGroundingAsync, tokens, scoreOverlap } from '../brain/skill-library'
import { selectSkills, renderNamedSkills } from '../brain/named-skill'
import { loadNamedSkills, recordSkillReuse } from '../brain/named-skill-store'
import { readRsiTunables } from '../brain/rsi-tunables'
import { embedForRecall, resolveEmbedderId, search } from './index-store'
import { assessEvidence, evidenceCaveat, evidenceGateEnabled } from './evidence-gate'
// F2 (bounded-context): relevance-bound an over-budget raw source to the turn query instead of a
// blind head-slice. Fail-open (cold embedder ⇒ head-slice), so no regression when embeddings are cold.
import { boundToBudget } from './output-bound'
// F2 (bounded-context, whole-prompt): assemble the grounding blocks within a token budget — floor
// blocks kept, CONTEXT relevance-compressed, low-value blocks dropped least-relevant-first. Gated by
// DUIN_CONTEXT_COMPILER=1; OFF (default) keeps the exact legacy concat below (byte-identical, zero regression).
import { compilePrompt, DEFAULT_CONTEXT_BUDGET_TOKENS, type ContextUnit } from './prompt-compiler'
// F3 (prefill-cache): the byte-stable-prefix layout. Pure + prod-imported — see prompt-layout.ts.
// Gated by DUIN_STABLE_PREFIX=1; OFF (default) keeps the exact legacy layout below.
import { layoutStablePrefixMessages, stableCoreOf, type PromptMessage } from './prompt-layout.mjs'
import { getTaste } from '../brain/learn-native'
import { loadRecallEfficacy, stageRecalledKinds } from './recall-efficacy'
import { shouldInjectRecall } from './uncertainty-gate'
import { escalateToRaw, renderRawEscalation } from './raw-escalation'
import {
  operatorCandidates,
  tasteCandidates,
  failureCandidates,
  rankRecall,
  renderRecallBlock,
  normalizeRuleText
} from './personalization-recall'
import { listFailures } from '../failure-ledger'
import { renderTasteBlock, renderFailureBlock, renderCalibrationBlock, renderOwedForecastsBlock } from './personalization-blocks'
import type { OwedForecastLite } from './personalization-blocks'
import { forecastOwed } from '../brain/simple-reads-native'
import { decisionTrackRecord, renderDecisionTrackRecord } from './decision-outcomes-native'
import { loadKindRatesWithCurrency } from '../brain/calibration-metabolism'
import { loadKindRates } from '../brain/calibration-weight'
import { loadOntology } from '../brain/ontology'
import { messageOf } from '../guarded'
import type { LanguageChoice, ResolvedSkill } from '../../shared/chat-send-contract'
import { renderActiveSkills } from './active-skills'
import { renderLanguageDirective } from './language-directive'

// ── Absolute-relevance backfill for the answer-path evidence gate (G1) ───────────────
//
// THE DEFECT. `server.ts:citationsToHits` returns `{ file, snippet, score }` with NO
// `rawScore`, because "a model citation has no absolute relevance scale — inventing one
// would be a lie". That objection is correct about INVENTING a number and wrong about
// the conclusion: the note the model cited is a real file in the vector index, and the
// index can be ASKED what this query's best chunk cosine against that file actually is.
// That is a measurement, not a fabrication. Without it every hit on the default agentic
// path reaches `assessEvidence` with no absolute signal, so the gate returns
// 'no-absolute-signal' and fails open — i.e. the gate is inert on exactly the path it
// most needs to judge.
//
// WHY THE MEASUREMENT IS TAKEN HERE and not at the `hits = citationsToHits(...)` call
// site, which is where it is FREE (server.ts already holds the fused search result with
// `rawScore` on it, one function earlier, and throws it away): server.ts belongs to a
// different lane in this wave. Taking it here costs one extra `search()` per agentic
// turn — see backfillAbsoluteScores for the cost note and the self-disarming guard.

/** Attach measured ABSOLUTE relevance to hits that arrived without any. PURE.
 *
 *  A hit that already carries `rawScore` is never touched (the fallback retrieval path
 *  measured it properly), and a file with no vector rows for this query is left
 *  `undefined` rather than given a 0 — `assessEvidence` reads absent as "no signal" and
 *  fails OPEN, which is the correct posture for a note the vector leg cannot score.
 *  Returns the SAME array identity when there is nothing to attach, so the common case
 *  allocates nothing. */
export function attachAbsoluteScores<T extends { file: string; rawScore?: number }>(
  hits: T[],
  absByFile: Map<string, number>
): T[] {
  if (absByFile.size === 0) return hits
  let needed = false
  for (const h of hits) {
    if (h.rawScore === undefined && absByFile.has(h.file)) {
      needed = true
      break
    }
  }
  if (!needed) return hits
  return hits.map((h) =>
    h.rawScore === undefined && absByFile.has(h.file)
      ? ({ ...h, rawScore: absByFile.get(h.file) } as T)
      : h
  )
}

/** Ask the vector index for each wanted file's best chunk cosine against `query`.
 *
 *  `search()` emits one fused row per file whose `rawScore` IS that file's best chunk
 *  cosine (index-store builds `absByFile` from the vector leg's descending hits), so
 *  this is the same number the item asks for, read back through the public API.
 *
 *  HOT PATH COST, stated plainly (house rule 11): one extra `search()` on an agentic
 *  turn — ~110 ms on this operator's 13,310-chunk index, against a turn that already
 *  spends seconds in the multi-step agentic retrieval loop. It is bought by G1, and it
 *  is SELF-DISARMING: the caller skips it entirely the moment any hit already carries a
 *  rawScore, so the day server.ts attaches it at `citationsToHits` (free, no extra
 *  search) this probe stops running on its own with no code change here. */
async function measureAbsoluteScores(query: string, files: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const want = new Set(files.filter(Boolean))
  if (want.size === 0 || !query.trim()) return out
  // Over-fetch relative to the cited set: a cited note can rank below the shipped
  // searchK and would otherwise go unmeasured (left undefined ⇒ fail-open, correct but
  // uninformative). Bounded so a large citation set cannot widen the probe without limit.
  const probe = await search(query, Math.min(24, Math.max(8, want.size * 3)))
  for (const h of probe) {
    const s = h.rawScore
    if (!want.has(h.file) || !Number.isFinite(s)) continue
    const prev = out.get(h.file)
    if (prev === undefined || (s as number) > prev) out.set(h.file, s as number)
  }
  return out
}

/** Best-effort wrapper: measure + attach, or return `hits` untouched. Never throws — a
 *  cold/absent index must leave the gate exactly as fail-open as it was before.
 *  Set DUIN_EVIDENCE_BACKFILL=0 to skip the probe (staging switch for the added
 *  latency, not a safety gate — it governs one measurement, never enactment). */
async function backfillAbsoluteScores<T extends { file: string; rawScore?: number }>(
  query: string,
  hits: T[]
): Promise<T[]> {
  if (process.env.DUIN_EVIDENCE_BACKFILL === '0') return hits
  if (hits.length === 0) return hits
  // Already measured (the fallback retrieval path) ⇒ nothing to do, and no probe cost.
  if (hits.some((h) => Number.isFinite(h.rawScore))) return hits
  try {
    return attachAbsoluteScores(hits, await measureAbsoluteScores(query, hits.map((h) => h.file)))
  } catch (e) {
    console.debug('[agui-grounding] no absolute signal available  gate stays fail-open:', messageOf(e))
    return hits
  }
}

/** Does `contextOverride` actually DESCRIBE `hits` — i.e. was it rendered FROM them?
 *
 *  This is the question the evidence gate's old `!contextOverride` skip was reaching for
 *  and getting wrong (see the gate site in buildGroundedMessages). It is answered by
 *  VERIFICATION, not by guessing which branch ran: `citationsToContext` prints each
 *  citation's note path (`[n] (note.md:3-9)` or `[n] (note.md)`) and
 *  `orderCitationsByHits` emits exactly one citation per hit file, so on the citation
 *  path every hit's `file` is literally present in the rendered block. A context built
 *  from a DIFFERENT note set (graph-expand, whole-note) will not name them all.
 *
 *  Conservative in the right direction: any hit the context does not name ⇒ false ⇒ the
 *  gate is skipped exactly as before. Zero hits behind a supplied override ⇒ false, since
 *  there is no evidence to judge it by and 'no-hits' would be a verdict on the wrong
 *  thing. No override at all ⇒ true, because `context` then IS `hitsToContext(hits)`.
 *
 *  This derivation is the FALLBACK. The authoritative answer is the explicit
 *  `contextDescribedByHits` argument, which the three context writers in server.ts
 *  should pass (true at the citation write, false at the graph-expand and whole-note
 *  writes) — that edit is out of this lane and is reported as a cross-lane dependency.
 *  PURE. */
export function contextRenderedFromHits(
  contextOverride: string | undefined,
  hits: { file: string }[]
): boolean {
  if (contextOverride === undefined) return true
  if (hits.length === 0) return false
  for (const h of hits) {
    if (!h.file || !contextOverride.includes(h.file)) return false
  }
  return true
}

function hitsToContext(hits: { file: string; snippet: string; score: number }[]): string {
  if (hits.length === 0) return '(no relevant notes found in the local index)'
  return hits
    // Strip leading YAML frontmatter from the displayed snippet (chunk store
    // keeps it for graph-derive); keeps the grounding context clean.
    .map((h, i) => `[${i + 1}] (${h.file})\n${h.snippet.replace(/^\s*---[\s\S]*?---\s*/, '')}`)
    .join('\n\n')
}

// DUIN_SESSION_RECALL (default-OFF, additive) — cross-session recall. Pull the most relevant
// excerpts from the operator's PAST conversations (SQLite FTS over titles + message bodies) and
// ground them as a labelled, budgeted block. Returns '' when the flag is off, the query is blank,
// or nothing survives dedup — so the concat guard (and the compiler's empty-unit skip) leaves the
// prompt byte-identical to today. Mirrors buildMemoryIndexBlock: budget, skip-empty, one label.
function buildSessionsBlock(
  query: string,
  history: AguiMessage[],
  threadId: string,
  topN = 6,
  budgetTokens = 600
): string {
  if (process.env.DUIN_SESSION_RECALL !== '1') return ''
  const q = query.trim()
  if (!q) return ''
  const ftsQuery = toFtsQuery(q)
  if (!ftsQuery) return '' // query was all stopwords/punctuation ⇒ nothing meaningful to match
  let hits: SessionSearchHit[]
  try {
    hits = searchSessions(ftsQuery, topN * 4) // lenient OR-of-tokens; over-fetch, then dedup/filter
  } catch (e) {
    console.debug('[agui-grounding] session recall unavailable:', messageOf(e))
    return ''
  }
  if (!hits.length) return ''
  const norm = (s: string): string =>
    s.replace(/[<>…]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  // Dedup against the CURRENT thread: those turns appear verbatim below, so re-injecting wastes
  // budget; the same Set also drops within-block duplicates as they're picked.
  const seen = new Set(
    history
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .map(norm)
  )
  const picked: SessionSearchHit[] = []
  for (const h of hits) {
    if (h.conversationId === threadId) continue // same thread ⇒ already in history
    const snip = norm(h.snippet)
    if (!snip || looksLikeToolNoise(h.snippet) || seen.has(snip)) continue
    seen.add(snip)
    picked.push(h)
    if (picked.length >= topN) break
  }
  if (!picked.length) return ''
  const render = (rows: SessionSearchHit[]): string =>
    rows
      .map((h, i) => `[${i + 1}] (earlier chat)\n${h.snippet.replace(/[<>]{2}/g, '').trim()}`)
      .join('\n\n')
  // Budget to ~budgetTokens via the file's len/4 token heuristic; trim least-relevant first
  // (searchSessions returns rank-ascending = best-first).
  let body = render(picked)
  while (picked.length > 1 && Math.ceil(body.length / 4) > budgetTokens) {
    picked.pop()
    body = render(picked)
  }
  return (
    'FROM YOUR PAST CHATS — relevant excerpts from EARLIER conversations with this operator ' +
    '(not the current thread). Treat as recall, not authority: use it for continuity, but the ' +
    'current thread and the notes CONTEXT above win on conflict.\n' + body
  )
}

// Most of a session is low-signal — assistant prose, tool-call arguments, tool outputs. Skip
// snippets that read as structured/tool noise (brace/quote-dense) rather than substantive
// conversation. Conservative threshold so genuine prose is never dropped; the durable fix is
// Phase-2 recall over distilled session SUMMARIES, not raw turns.
function looksLikeToolNoise(snippet: string): boolean {
  const s = snippet.trim()
  if (!s) return true
  const structural = (s.match(/[{}[\]"`]/g) ?? []).length
  return structural / s.length > 0.25
}

// FTS5 MATCH parses its argument as a query, NOT a literal string: punctuation like '?' throws a
// syntax error, and bare words are implicitly AND-ed — so passing a raw natural-language question
// matches (almost) nothing and the recall silently returns empty. Turn the query into a lenient OR
// of its meaningful tokens, each quoted as a literal FTS term, so any token can surface a session
// (ranked by FTS relevance). Unicode-aware so CJK terms survive.
const FTS_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'at', 'for', 'and',
  'or', 'but', 'what', 'who', 'whom', 'when', 'where', 'why', 'how', 'which', 'with', 'without',
  'only', 'just', 'me', 'my', 'mine', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'do', 'did', 'does', 'done', 'can', 'could', 'would', 'should', 'will', 'shall', 'i', 'we', 'they',
  'about', 'from', 'get', 'got', 'tell', 'give', 'please', 'reply', 'answer', 'say', 'was', 'so'
])
function toFtsQuery(query: string): string {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !FTS_STOPWORDS.has(t)
  )
  const uniq = [...new Set(tokens)].slice(0, 12)
  return uniq.map((t) => `"${t}"`).join(' OR ')
}

/** Read the note a chat is PINNED to (the "asking in context" node), bounded in
 *  size, for use as an authoritative grounding block. Returns null when the node
 *  isn't a readable vault note (a person/decision/synthetic node, a missing file,
 *  or a path that fails the traversal/extension guard) — the caller then falls
 *  back to retrieval-only grounding, exactly as before. */
export function readPinnedNote(
  context: { id: string; label: string; kind: string } | undefined
): { label: string; kind: string; content: string } | null {
  if (!context?.id) return null
  const abs = docAbspath(context.id)
  if (!abs || !existsSync(abs)) return null
  try {
    let text = readFileSync(abs, 'utf8')
    // Cap so a huge note can't blow the context window — the head carries the
    // title / frontmatter / intro, which is what "about this note" questions need.
    const MAX = 12_000
    if (text.length > MAX) text = text.slice(0, MAX) + '\n…(truncated)'
    return { label: context.label, kind: context.kind, content: text }
  } catch {
    return null
  }
}

// WS2′ Phase A (turn-beats): assemble the LOG-ONLY prediction-pass grounding — GOALS.md
// text DUMPED (read, not graph-walked), the last 6 turns, the dumped operator facts, and
// the current track (baseline) + known track keys via the ontology. Pure gather; the
// prediction itself runs in turnBeatTick. Best-effort — any failure yields empty grounding
// (the pass then simply predicts from little, or the keyless model no-ops it). NEVER
// touches the reply or grounding of the live answer.
export function buildBeatGrounding(vaultDir: string | null, history: AguiMessage[], query: string): BeatGrounding {
  let goalsText = ''
  if (vaultDir) {
    try {
      goalsText = readFileSync(join(vaultDir, 'GOALS.md'), 'utf-8')
    } catch (e) { console.debug('[agui-grounding] no GOALS.md  predict from the rest:', messageOf(e)) }
  }
  const onto = loadOntology(vaultDir)
  let operatorFacts: { fact: string }[] = []
  try {
    operatorFacts = getOperatorFacts().map((f) => ({ fact: f.fact }))
  } catch (e) { console.debug('[agui-grounding] none learned yet:', messageOf(e)) }
  return {
    goalsText,
    recentTurns: history.slice(-6).map((m) => ({
      role: m.role,
      // turn-beats expects a string; if the last user turn carried vision
      // images its content is a multimodal array - extract just the text
      // parts so image data does not leak into the turn-beat predictor.
      content: typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p): p is { type: 'text'; text: string } => p?.type === 'text').map((p) => p.text).join(' ')
          : String(m.content ?? ''),
    })),
    operatorFacts,
    currentTrack: onto.trackOf(query),
    trackKeys: onto.tracks.map((t) => t.key)
  }
}

// The role preamble, split at the point where the per-turn `retrievalNote` is spliced in. The
// legacy/compiler paths join HEAD + retrievalNote + RULES (byte-identical to the former inline
// concat); the stable-prefix path keeps HEAD + RULES in the cached core and moves retrievalNote
// to the volatile tail, since it describes THIS turn's retrieval and would otherwise flip the
// core's bytes whenever a turn switched between the agentic and fallback retriever.
const PREAMBLE_HEAD =
  'You are DUIN, a local-first second-brain agent grounded in the user\'s notes and what you\'ve ' +
  'learned about them.'
// The rules body starts lowercase ("when a CONTEXT note…") so the legacy paths can prefix the
// literal 'So: ' they have always sent, while the stable core — where `retrievalNote` is no longer
// present for "So:" to draw its conclusion FROM — can open with a capitalised "When" instead of a
// dangling connective. Byte-identity of the legacy paths depends on this split; do not merge them.
const PREAMBLE_RULES_BODY =
  'when a CONTEXT note genuinely ' +
  'answers the question, treat it as authoritative, read it, and cite the filename in brackets. But when ' +
  'the CONTEXT is off-topic or doesn\'t address the question (e.g. a question about yourself/DUIN, or the ' +
  'notes simply don\'t cover it), IGNORE it and answer from general knowledge — do NOT force-fit it, do ' +
  'NOT cite a note that doesn\'t answer the question, and never tell the user their question "pulled" or ' +
  '"matched" an unrelated note (that retrieval detail is noise, not something to surface).'

export async function buildGroundedMessages(
  history: AguiMessage[],
  query: string,
  // rawScore must be declared here or the absolute relevance search() attaches is
  // structurally erased at this boundary and the escalation decision goes blind.
  hits: { file: string; snippet: string; score: number; rawScore?: number }[],
  contextOverride?: string,
  pinnedNote?: { label: string; kind: string; content: string } | null,
  threadId = '',
  budgetTokens?: number,
  activeSkills?: ResolvedSkill[],
  language?: LanguageChoice,
  /** Values the retrieval agent COMPUTED across the whole corpus (renderComputed). Prepended to the
   *  context on EVERY path, because a count is not a hit: it must survive both the contextOverride
   *  branch and the ranked-hits branch, and it must arrive even when there are zero citations —
   *  "how many notes mention X" is a legitimate turn with nothing to cite. Last parameter so no
   *  existing caller shifts. */
  computedBlock?: string,
  /** Does `contextOverride` DESCRIBE `hits` — was it rendered from them? Only the answer-path
   *  evidence gate reads this, and only to decide whether judging `hits` is judging the right
   *  evidence. The three context writers in server.ts know this for certain and should say so:
   *  TRUE at the agentic citation write (`citationsToContext(orderCitationsByHits(cits, hits))`
   *  is literally a rendering of `hits`), FALSE at the graph-expand and whole-note writes (those
   *  build context from a different note set). Left undefined ⇒ derived by verification, see
   *  contextRenderedFromHits. Appended last so no existing caller shifts. */
  contextDescribedByHits?: boolean,
  /** The operator's voice/tone preset, already RESOLVED to its directive text by the caller
   *  (ipc/chat.ts → agent-tones.resolveToneDirective) and carried on the /agui body as `voice`.
   *  Rendered as a floor-tier <voice> block — the SAME block buildSystemPrompt composes for the
   *  raw:/headless paths, which until now were the only paths that honoured the setting at all.
   *  Absent/'' ('balanced') → no block → prompt bytes unchanged. Appended last so no existing
   *  caller shifts. */
  voice?: string
): Promise<ChatCompletionMessageParam[]> {
  // Floor-tier: an explicitly-enabled skill must survive budget compression, or the toggle
  // silently does nothing again under a long conversation — the exact defect this fixes.
  const activeSkillBlock = renderActiveSkills(activeSkills)
  // Floor-tier, near the top: the response-language directive. '' for the auto/absent default →
  // every assembly path below filters the empty unit out → prompt bytes unchanged.
  const languageDirective = renderLanguageDirective(language)
  // Floor-tier, near the top: the voice/tone preset. Wrapped in the same <voice> tags
  // buildSystemPrompt uses so the default (brain) path and the raw:/headless path deliver a
  // byte-identical block — the preset used to exist ONLY on the latter, which is why picking
  // "Caveman" changed nothing in normal chat. '' for 'balanced'/absent → every assembly path
  // below filters the empty unit out → prompt bytes unchanged.
  const voiceDirective = voice && voice.trim() ? `<voice>\n${voice.trim()}\n</voice>` : ''
  let context = contextOverride ?? hitsToContext(hits)
  // Computed values go ABOVE the excerpts: they are whole-corpus facts, and the excerpts are a
  // sample the model would otherwise count from and get wrong.
  if (computedBlock) context = `${computedBlock}\n\n${context}`
  // Answer-path evidence gate (DUIN_EVIDENCE_GATE=0 to disable, default ON). Appends an honesty caveat when the
  // best ABSOLUTE hit relevance is below the measured floor, so a turn retrieval cannot support is
  // answered with "not in your notes" instead of a confident inference off the top noise hit — the
  // 53/53-confidently-wrong, zero-abstention failure mode.
  //
  // TWO WAYS IN, because "is this the right evidence to judge?" has two different true answers.
  //
  //  1. `evidenceGateEnabled() && !contextOverride` — the FALLBACK path. `context` IS
  //     `hitsToContext(hits)`, so the hits describe it by construction. Kept as its own named
  //     disjunct rather than folded into the condition below because it is not merely a special
  //     case: with ZERO hits it must still fire (that is where the "retrieval returned nothing"
  //     caveat comes from), whereas an override with zero hits behind it must not.
  //
  //  2. `evidenceGateEnabled() && describedByHits` — the CITATION path, and the reason this
  //     comment was rewritten. The old condition was JUST (1), on the stated grounds that "that
  //     context came from a different grounding path (whole-note / graph-expand) and `hits` does
  //     not describe it". True of those two paths — but both are OPT-IN and default OFF, while the
  //     agentic pass is default ON and writes `contextOverride` at the end of the turn whenever it
  //     returns citations. So on a DEFAULT install the skip fired on every citation turn and the
  //     gate never ran at all: off-corpus answers decorated with noise citations sailed through
  //     ungated, which is precisely the calibrated failure class the gate exists for.
  //     `citationsToContext(orderCitationsByHits(citations, hits))` is literally a rendering of
  //     `hits`, so judging them there is judging the RIGHT evidence.
  //
  // The graph-expand and whole-note contexts still skip the gate — they resolve `describedByHits`
  // to false (they name a different note set) and can also be told so explicitly.
  const describedByHits = contextDescribedByHits ?? contextRenderedFromHits(contextOverride, hits)
  const gateOnFallbackContext = evidenceGateEnabled() && !contextOverride
  const gateOnCitationContext = evidenceGateEnabled() && describedByHits
  if (gateOnFallbackContext || gateOnCitationContext) {
    // G1: hits that reached here with no absolute signal (the citation path, where
    // citationsToHits drops it) get one MEASURED from the vector index before the gate judges
    // them. No-op — and no probe cost — when they already carry rawScore, which is the fallback
    // path. See backfillAbsoluteScores for the cost + self-disarm note.
    const gateHits = await backfillAbsoluteScores(query, hits)
    context += evidenceCaveat(assessEvidence({ hits: gateHits, embedderId: resolveEmbedderId() }))
  }
  // DUIN_SESSION_RECALL: cross-session recall block (empty string unless the flag is on).
  // Computed once here and consumed by all three assembly paths below.
  const sessionsBlock = buildSessionsBlock(query, history, threadId)

  // Apply/Retrieval (TierMem): DUIN_RECALL_ESCALATE=1 → when the cheap index recall
  // is thin (weak top-hit score), deepen the top hits from snippet to RAW SOURCE.
  // DEFAULT ON (set DUIN_RECALL_ESCALATE=0 to disable). Only runs on the fallback
  // path (no agentic contextOverride, which already read the real notes).
  let rawEscalationBlock = ''
  if (process.env.DUIN_RECALL_ESCALATE !== '0' && !contextOverride && hits.length) {
    const decision = escalateToRaw({ query, hits })
    if (decision.escalate) {
      const sources: { file: string; content: string }[] = []
      for (const file of decision.files) {
        try {
          const abs = docAbspath(file)
          if (!abs || !existsSync(abs)) continue
          let text = readFileSync(abs, 'utf8').replace(/^\s*---[\s\S]*?---\s*/, '')
          const MAX = 8_000
          if (text.length > MAX) text = await boundToBudget(text, query, MAX, embedForRecall)
          sources.push({ file, content: text })
        } catch {
          /* unreadable source → skip; the snippet context still stands */
        }
      }
      rawEscalationBlock = renderRawEscalation(sources)
    }
  }

  // F1 (operator-learning) — ground the brain in what DUIN has learned about the
  // operator (the memory index). Empty for a brand-new user; grows as DUIN
  // accrues memories + calibration over time → answers get more personal.
  let memory = ''
  try {
    memory = buildMemoryIndexBlock()
  } catch (e) { console.debug('[agui-grounding] memory store not ready  answer without it:', messageOf(e)) }
  // F1 (operator-learning) — the durable operator profile DUIN has accrued.
  let operator = ''
  try {
    // FUSE (self-evolution Move 2, WS2.2): down-weight operator facts the learning-metabolism flags
    // as currency-stale. `DUIN_FUSE_STALENESS=0` reverts (mirrors the other default-on recall flags).
    // Fail-safe (down-weight-not-drop; the fact text stays). As of 2026-07-18 (F1-b) the fusion is
    // GATED on the MEASURED precision of the staleness signal: shouldFuseStaleness reads the per-vault
    // grounding-staleness calibration (Wilson-lo over materialized-vs-refuted outcomes) and only
    // suppresses when that precision clears the floor on enough samples. This makes the grounding-
    // staleness domain load-bearing on the real decision — an under-sampled or low-precision signal
    // (the small-n dogfood-vault case that capped this before) grounds with the FULL operator block, so a
    // valid preference is never buried on weak evidence. NOTE: the grounding-staleness ledger is
    // currently fed by the judge-keyed /debug/grounding-eval-live route (no background accrual tick
    // yet) — so on a keyless/un-exercised vault stalenessTrust is null and this correctly defaults to
    // no-fusion. It becomes self-sustaining once a metabolism tick accrues the judged eval.
    if (process.env.DUIN_FUSE_STALENESS !== '0') {
      const vd = (() => {
        try {
          const d = readSettings().localBrainNotesDir
          return typeof d === 'string' && d ? d : null
        } catch {
          return null
        }
      })()
      if (vd && shouldFuseStaleness(stalenessTrust(vd))) {
        const staleIds = new Set(runLearningShadow(vd).staleCandidates.map((c) => c.id))
        operator = buildOperatorBlock(staleIds)
      } else {
        operator = buildOperatorBlock()
      }
    } else {
      operator = buildOperatorBlock()
    }
  } catch (e) { console.debug('[agui-grounding] none learned yet:', messageOf(e)) }

  // The `.brain/` harness root — the user's DURABLE identity + memory (their
  // `me.md`/CLAUDE.md + accrued memory files, possibly imported from an
  // existing agent system). Prepended BEFORE the notes CONTEXT so every answer
  // is grounded in WHO the owner is, not just what their notes say. Empty/absent
  // `.brain/` → '' → the prompt is byte-for-byte the same as before.
  let brainGrounding = ''
  try {
    const dir = readSettings().localBrainNotesDir
    brainGrounding = buildBrainGroundingBlock(
      loadBrain(typeof dir === 'string' ? dir : null)
    )
  } catch (e) { console.debug('[agui-grounding] no .brain/ root  behave exactly as before:', messageOf(e)) }

  const vaultDir = (() => {
    try {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d ? d : null
    } catch {
      return null
    }
  })()

  // ── Retrieve-pull (Memory Architecture §2): QUERY-RELEVANT, β_conf-weighted,
  //    conflict-suppressed recall of the operator memory. Replaces the whole-dump of
  //    operator facts / taste / failures with ONLY what's relevant to THIS turn,
  //    ranked by how much each item has earned trust. Off-switch:
  //    settings.memoryRecall === 'off' (Memory Architecture §8 tripwire). On any
  //    failure / no embedder, rankRecall returns null and we fall back to the
  //    whole-dump blocks (item 1) — zero regression.
  const recallOn = (() => {
    try {
      return (readSettings() as { memoryRecall?: string }).memoryRecall !== 'off'
    } catch {
      return true
    }
  })()
  // Procedural memory (skill library): inject the past successes most relevant to this
  // request as few-shot grounding ("lean this way"). Best-effort, keyless.
  let skillBlock = ''
  if (query.trim()) {
    try {
      // WS4.3: DUIN_SKILL_EMBED=1 → semantic (embedding) skill ranker; default OFF = the
      // token-overlap ranker exactly as before (zero live change, no added embed latency).
      skillBlock =
        process.env.DUIN_SKILL_EMBED === '1'
          ? await getSkillGroundingAsync(query, embedForRecall)
          : getSkillGrounding(query)
    } catch {
      skillBlock = ''
    }
  }
  // Phase 1 (self-improve bridge): named-skill READ-BACK — distilled skills were written
  // (POST /state/skill-distill) but never retrieved. Close the Voyager loop: rank named skills
  // by description overlap, inject the top few as a "PROVEN PROCEDURES" block, and record a reuse
  // event (the loop-closed signal the self-improve bench reads). Best-effort, keyless, additive.
  let namedSkillBlock = ''
  if (query.trim()) {
    try {
      const qTok = tokens(query)
      // topK is the RSI-tunable knob (clamped [1,5]); floor stays the default. This is the one
      // brain-read parameter the self-improve loop may tune (rsi-tunables.ts).
      const picked = selectSkills(query, loadNamedSkills(vaultDir), (_q, text) => scoreOverlap(qTok, text), {
        topK: readRsiTunables(vaultDir).namedSkillTopK,
        floor: 0.2,
      })
      if (picked.length) {
        namedSkillBlock = renderNamedSkills(picked)
        recordSkillReuse(vaultDir, query, picked.map((s) => s.id))
      }
    } catch {
      namedSkillBlock = ''
    }
  }
  // Apply/Retrieval (ExpWeaver): DUIN_RECALL_UNCERTAINTY=1 → inject recall only at
  // uncertain/beneficial turns; suppress it on a trivial turn with confident/absent
  // retrieval. DEFAULT ON (set DUIN_RECALL_UNCERTAINTY=0 to disable → uncertaintySkip
  // as today (mirrors DUIN_FUSE_STALENESS / DUIN_RECALL_CAL). When ON, a suppressed
  // turn skips BOTH recall AND the whole-dump fallback (minimal grounding).
  const uncertaintySkip =
    process.env.DUIN_RECALL_UNCERTAINTY !== '0' && query.trim()
      ? !shouldInjectRecall({ query, hits }).inject
      : false

  let recallBlock = ''
  let recallActive = false
  let recallSelectedKinds: string[] = []
  // W2 (causal survival credit): the fact ids actually injected this turn, staged beside the
  // kinds so the next turn's endorsement credits the specific facts (not everything co-resident).
  let recallSelectedFactIds: string[] = []
  if (recallOn && query.trim() && !uncertaintySkip) {
    try {
      let taste
      try {
        taste = getTaste(vaultDir)
      } catch {
        taste = null
      }
      // WS1 Item 3a: DUIN_RECALL_CAL=1 → fold each recall-kind's empirical efficacy
      // (from the recall-efficacy ledger, Item 3b) into β_conf via calFactor. DEFAULT
      // OFF → `recallCal` undefined → operatorCandidates skips calFactor entirely →
      // byte-identical β_conf to today (mirrors DUIN_SKILL_EMBED/DUIN_CAL_CURRENCY/
      // DUIN_FUSE_STALENESS). Reversible by unsetting the env var. The gated→1.0 guard
      // in calFactor means an unobserved kind can NEVER reorder recall.
      const recallCalOn = recallCalEnabled()
      const recallCal = recallCalOn ? loadRecallEfficacy(vaultDir) : undefined
      // Phase 1b cross-source dedup: a bound rule now grounds as an operator fact, so exclude
      // its taste duplicate (else the same rule double-injects and can occupy two top-k slots).
      // Ingestion-trust tiering: drop un-promoted 'external' facts (de-privileged-turn captures) BEFORE
      // recall — this is the DEFAULT-ON grounding path, so the quarantine must gate it here too (not
      // only buildOperatorBlock's whole-dump fallback), else an external assertion recalls into the
      // prompt ungated. Same predicate as buildOperatorBlock + consolidation. AND (Stage 3/4) the
      // reliability gate: a fold that LAUNDERED external content (source relabelled 'machine', so
      // isQuarantinedExternal can't see the external premise underneath) is caught here too — the trust
      // semiring caps it ≤0.3, below TRUST_FLOOR, so isLowTrustDerived suppresses it from recall. This
      // closes the laundering gap on the primary recall path, not just the whole-dump fallback.
      const relRecall = groundingReliability()
      const recallFacts = getOperatorFacts().filter((f) => !isQuarantinedExternal(f) && !isLowTrustDerived(f, relRecall.get(f.id) ?? 1))
      const groundedRules = new Set(recallFacts.map((f) => normalizeRuleText(f.fact)))
      const candidates = [
        ...operatorCandidates(recallFacts, recallCal ? { kindRates: recallCal } : {}),
        ...tasteCandidates(taste, { excludeRules: groundedRules }),
        // recallFailureLimit is the 2nd RSI knob (rsi-tunables): the QD loop tunes how
        // broad the failure-recall pool is. Default 20 → byte-identical when unset.
        ...failureCandidates(listFailures({ limit: readRsiTunables(vaultDir).recallFailureLimit }))
      ]
      const selected = await rankRecall(query, candidates, embedForRecall)
      if (selected) {
        // Recall RAN (non-null) — trust it over the whole-dump even if it selected
        // nothing (an empty selection means nothing was relevant to this turn).
        recallBlock = renderRecallBlock(selected)
        recallActive = true
        recallSelectedKinds = selected.map((c) => c.recallKind ?? '').filter(Boolean)
        recallSelectedFactIds = selected.map((c) => c.factId ?? '').filter(Boolean)
      }
    } catch (e) { console.debug('[agui-grounding] recall unavailable  fall back to whole-dump below:', messageOf(e)) }
  }

  // Stage this turn's injected grounding-kinds so the NEXT turn's reaction grades them into the
  // recall-efficacy ledger (only when the flag is on → OFF stays inert). ONE staging call unions the
  // recall candidates with 'named-skill' when a named-skill block was injected — namedSkillTopK is an
  // RSI knob targeting the recall-efficacy:named-skill engine, so its usefulness MUST accrue as its own
  // kind (named skills ground in a separate block, outside the recall candidate assembly). Staged even
  // when recall was skipped/uncertain, since the named-skill block injects independently of recall.
  if (recallCalEnabled()) {
    const staged = [...recallSelectedKinds, ...(namedSkillBlock ? ['named-skill'] : [])]
    // Always stage (even an empty set) and stamp with THIS turn's query: a recall-free turn
    // must OVERWRITE the slot, else a prior turn whose tick was skipped (aborted/errored) leaves
    // its staged kinds for this turn's tick to roll forward and later misattribute. The query
    // stamp is the belt to this suspenders — the tick discards a slot stamped for a different turn.
    stageRecalledKinds(threadId, staged, query, recallSelectedFactIds)
  }

  // Whole-dump FALLBACK (item 1) — computed only when recall did not run; recall
  // otherwise covers operator facts + taste + failures, query-relevant.
  let tasteBlock = ''
  let failureBlock = ''
  if (!recallActive && !uncertaintySkip) {
    try {
      // Phase 1b cross-source dedup: the operator block (buildOperatorBlock) already carries any
      // bound rule as an operator fact, so exclude its taste duplicate from the fallback block.
      const groundedRules = new Set(getOperatorFacts().map((f) => normalizeRuleText(f.fact)))
      tasteBlock = renderTasteBlock(getTaste(vaultDir), groundedRules)
    } catch (e) { console.debug('[agui-grounding] no taste engine yet:', messageOf(e)) }
    try {
      failureBlock = renderFailureBlock(listFailures({ limit: 8 }))
    } catch (e) { console.debug('[agui-grounding] failure ledger unavailable:', messageOf(e)) }
  }
  // Calibration is a compact SUMMARY (not an item list), injected in both modes.
  let calibrationBlock = ''
  try {
    // FUSE WS2.3: DUIN_CAL_CURRENCY=1 → gate stale-evidence kinds via currency; default OFF = today.
    calibrationBlock = renderCalibrationBlock(
      process.env.DUIN_CAL_CURRENCY === '1' ? loadKindRatesWithCurrency(vaultDir) : loadKindRates(vaultDir)
    )
  } catch (e) { console.debug('[agui-grounding] no calibration track record yet:', messageOf(e)) }

  // Open loops the operator owes an outcome on. This was a NOTIFICATION ("2 forecasts are
  // past their review date") until it became clear that was the wrong instrument: a
  // forecast review is a question whose entire value is the answer, and a toast cannot
  // collect one — so it got dismissed and the loop stayed open. Asking mid-conversation
  // works because the operator is already here. renderOwedForecastsBlock carries the
  // restraint rules; the block is empty when nothing is owed, so the prompt is unchanged.
  let owedBlock = ''
  try {
    owedBlock = renderOwedForecastsBlock(
      (forecastOwed(vaultDir).owed as OwedForecastLite[] | undefined) ?? []
    )
  } catch (e) { console.debug('[agui-grounding] no owed forecasts:', messageOf(e)) }

  // Decision track record (Phase 2) — a compact SUMMARY of how the operator's resolved
  // decisions actually turned out, injected in both modes. Closes the decision-quality loop:
  // verdicts were captured + stored but never reached the prompt until now.
  let decisionBlock = ''
  try {
    decisionBlock = renderDecisionTrackRecord(decisionTrackRecord(vaultDir))
  } catch (e) { console.debug('[agui-grounding] no decision outcomes yet:', messageOf(e)) }

  // When recall is active it covers the operator facts (query-relevant), so drop the
  // whole operator profile and keep only the memory index; else the full profile.
  //
  // `uncertaintySkip` belongs in this condition too, and its absence WAS the defect. The
  // taste/failure fallback above already checks BOTH gates. This checked only
  // recallActive, so on a turn the uncertainty gate deliberately skipped — "thanks",
  // "ok", a thumbs-up: the highest-frequency, lowest-value turn there is — recall never
  // ran, recallActive stayed false, and the fallback injected the ENTIRE operator
  // profile. The gate that exists to spend LESS on trivial turns made them the most
  // expensive ones.
  const aboutOperator =
    recallActive || uncertaintySkip ? memory : [operator, memory].filter(Boolean).join('\n')

  // Describe the retrieval ACCURATELY so the answer model knows what it actually
  // has. The agentic pass (contextOverride present) did a real multi-step hybrid +
  // graph retrieval; the fallback is a one-shot keyword/semantic search. Framing
  // the former as the latter is what made DUIN undersell itself ("I can only do
  // semantic top-k, can't browse folders or multi-hop").
  const retrievalNote = contextOverride
    ? 'The CONTEXT below was gathered by an AGENTIC retrieval pass over the user\'s vault for this ' +
      'question: it searched semantically AND by keyword (rank-fused, so an exact term surfaces even when ' +
      'it ranks low semantically), followed note links across multiple hops, and read the actual notes — ' +
      'focused evidence from a real multi-step search, not the whole vault. It is organized below by topic ' +
      'cluster, and any note the search rescued by following a link is marked "(linked)". It is thorough but ' +
      'targeted, so it can still miss a note that uses none of the query\'s vocabulary and has no link to one ' +
      'that does.'
    : 'The CONTEXT below was retrieved from the user\'s notes by a keyword/semantic search for this ' +
      'question — a best-effort guess, NOT a curated selection, and a note can match on shared vocabulary ' +
      'without actually being about the question.'

  // The pinned-note block, hoisted to ONE source of truth (the legacy path re-adds its trailing
  // '\n\n' separator, so its bytes are unchanged).
  const pinnedBlock = pinnedNote
    ? `PINNED NOTE — the user is asking IN THE CONTEXT OF this specific note ` +
      `(${pinnedNote.kind} "${pinnedNote.label}"). Treat it as the AUTHORITATIVE subject of ` +
      `the conversation: read it, and when the user says "this", "it", "the bug", "fix it", ` +
      `etc. they mean THIS note unless they clearly say otherwise. Do NOT ask which note they ` +
      `mean.\n\n<<<PINNED NOTE "${pinnedNote.label}">>>\n${pinnedNote.content}\n<<<END PINNED NOTE>>>`
    : ''

  // F3 (prefill-cache, efficiency campaign §5.1): DUIN_STABLE_PREFIX=1 → emit a byte-STABLE
  // message[0] (static preamble + `.brain/` identity + durable memory index) and carry every
  // per-turn-volatile block on the LAST user message instead, so the cacheable prefix
  // [core, ...prior history] grows monotonically with the thread and the provider prefill cache
  // keeps hitting. DEFAULT-OFF: the two branches below are today's exact layout (zero regression).
  //
  // This is NOT a behavior-preserving change — the same content is REPOSITIONED (system → user
  // turn), which is a prompt-SEMANTIC change. Flipping the default is therefore gated on an
  // answer-QUALITY eval, not on the efficiency instrument. See the campaign handoff §5.1.
  //
  // Content parity with the legacy concat: `aboutOperator` is decomposed rather than dropped — the
  // memory index (always present, durable) goes to the stable core, and the operator whole-dump
  // (present only when recall did NOT run) goes to the tail. Together they carry exactly the legacy
  // `recallActive ? memory : operator + '\n' + memory` content. NOTE the two differences the split
  // forces, both deliberate: the two halves land in DIFFERENT messages, and the memory half now
  // precedes the operator half (the legacy order was operator-then-memory). The tail half therefore
  // gets its OWN header rather than repeating the core's, so the model never sees the same heading
  // twice introducing two different bodies.
  if (process.env.DUIN_STABLE_PREFIX === '1') {
    const stableCore = {
      // Turn-invariant, so it belongs in the byte-stable core rather than the volatile tail:
      // placing it here keeps the prefill cache intact within a thread. Empty ('auto'/absent) →
      // stableCoreOf filters it out → byte-identical to today's core.
      languageDirective,
      preamble:
        `${PREAMBLE_HEAD} ` +
        PREAMBLE_RULES_BODY.charAt(0).toUpperCase() +
        PREAMBLE_RULES_BODY.slice(1),
      brainGrounding,
      memoryIndex: memory
    }

    // Same units/tiers as the compiler path below, minus the two that moved into the stable core.
    const volatileUnits: ContextUnit[] = [
      // 'floor' + tail rather than the byte-stable core: the preset is settings-derived and can be
      // changed mid-thread, and a core that changes mid-thread destroys the prefill cache it exists
      // to protect. Floor tier guarantees delivery, so it is never budget-dropped either.
      { kind: 'voice', tier: 'floor', text: voiceDirective },
      { kind: 'retrievalNote', tier: 'floor', text: retrievalNote },
      // 'floor' + tail, NOT stable core: the operator explicitly enabled these, so budget
      // compression must never silently drop them — but active-skill SELECTION is per-turn, so it
      // rides the volatile tail (a byte-stable core cannot carry a value that changes each turn).
      // Was silently absent from this array while present on both other assembly paths (compiler
      // floor unit + legacy concat), so DUIN_STABLE_PREFIX=1 reintroduced the exact "toggle does
      // nothing" defect renderActiveSkills' floor treatment was created to eliminate.
      { kind: 'activeSkills', tier: 'floor', text: activeSkillBlock },
      {
        kind: 'aboutOperator',
        tier: 'drop',
        // Same pair of gates as aboutOperator above — see the note there.
        text:
          recallActive || uncertaintySkip || !operator
            ? ''
            : `THE OPERATOR — DURABLE PROFILE:\n${operator}`
      },
      { kind: 'recall', tier: 'drop', text: recallBlock },
      { kind: 'taste', tier: 'drop', text: tasteBlock },
      { kind: 'calibration', tier: 'drop', text: calibrationBlock },
      { kind: 'owedForecasts', tier: 'drop', text: owedBlock },
      { kind: 'decision', tier: 'drop', text: decisionBlock },
      { kind: 'failure', tier: 'drop', text: failureBlock },
      { kind: 'skill', tier: 'drop', text: skillBlock },
      { kind: 'namedSkill', tier: 'drop', text: namedSkillBlock },
      { kind: 'pinnedNote', tier: 'floor', text: pinnedBlock },
      { kind: 'rawEscalation', tier: 'drop', text: rawEscalationBlock },
      { kind: 'context', tier: 'compress', text: `CONTEXT (retrieved for: ${query}):\n${context}` },
      { kind: 'sessions', tier: 'drop', text: sessionsBlock }
    ]

    // COMPOSES WITH DUIN_CONTEXT_COMPILER rather than silently disarming it. An earlier draft
    // returned here before the compiler branch, so turning stable-prefix on would have quietly
    // removed the whole-prompt token bound — and DUIN_CONTEXT_COMPILER is durably armed in this
    // operator's environment, so the bound would have vanished without a warning. Instead the tail
    // is compiled under the SAME budget, less what the stable core already spends. Compiler OFF ⇒
    // budget 0 ⇒ compilePrompt returns the plain in-order join (today's exact tail bytes).
    const coreTokens = Math.ceil(stableCoreOf(stableCore).length / 4)
    const tailBudget =
      process.env.DUIN_CONTEXT_COMPILER === '1'
        ? Math.max(1, (budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS) - coreTokens)
        : 0
    const volatileTail = await compilePrompt(volatileUnits, query, tailBudget, embedForRecall)

    const priorTurns: PromptMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map((m) => ({ role: m.role as PromptMessage['role'], content: m.content }))

    return layoutStablePrefixMessages(
      stableCore,
      priorTurns,
      volatileTail
    ) as ChatCompletionMessageParam[]
  }

  // F2 (bounded-context, whole-prompt): DUIN_CONTEXT_COMPILER=1 → assemble the SAME blocks within a
  // token budget (floor kept, CONTEXT relevance-compressed, low-value blocks dropped least-relevant-
  // first). Each unit's `text` is exactly the corresponding wrapped block below MINUS its trailing
  // '\n\n' separator (compilePrompt's '\n\n' join re-adds it), so a no-op compile is byte-identical to
  // the legacy concat. DEFAULT-OFF: the else branch is today's exact concat (zero regression).
  let system: string
  if (process.env.DUIN_CONTEXT_COMPILER === '1') {
    const units: ContextUnit[] = [
      // Floor-tier and FIRST: the reply-language directive outranks the retrieval framing, and an
      // empty unit ('auto'/absent) is filtered out of the join → byte-identical to today.
      { kind: 'languageDirective', tier: 'floor', text: languageDirective },
      // Floor-tier alongside it: an explicitly-chosen voice must survive budget compression, or the
      // picker silently does nothing again on long conversations.
      { kind: 'voice', tier: 'floor', text: voiceDirective },
      {
        kind: 'preamble',
        tier: 'floor',
        text: `${PREAMBLE_HEAD} ${retrievalNote} So: ${PREAMBLE_RULES_BODY}`
      },
      { kind: 'brainGrounding', tier: 'floor', text: brainGrounding },
      // 'floor' on purpose: the operator explicitly enabled these, so budget compression must
      // never silently drop them (that would reproduce the "toggle does nothing" defect).
      { kind: 'activeSkills', tier: 'floor', text: activeSkillBlock },
      { kind: 'aboutOperator', tier: 'drop', text: aboutOperator ? `WHAT YOU KNOW ABOUT THE OPERATOR:\n${aboutOperator}` : '' },
      { kind: 'recall', tier: 'drop', text: recallBlock },
      { kind: 'taste', tier: 'drop', text: tasteBlock },
      { kind: 'calibration', tier: 'drop', text: calibrationBlock },
      { kind: 'owedForecasts', tier: 'drop', text: owedBlock },
      { kind: 'decision', tier: 'drop', text: decisionBlock },
      { kind: 'failure', tier: 'drop', text: failureBlock },
      { kind: 'skill', tier: 'drop', text: skillBlock },
      { kind: 'namedSkill', tier: 'drop', text: namedSkillBlock },
      { kind: 'pinnedNote', tier: 'floor', text: pinnedBlock },
      { kind: 'rawEscalation', tier: 'drop', text: rawEscalationBlock },
      { kind: 'context', tier: 'compress', text: `CONTEXT (retrieved for: ${query}):\n${context}` },
      { kind: 'sessions', tier: 'drop', text: sessionsBlock }
    ]
    system = await compilePrompt(units, query, budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS, embedForRecall)
  } else {
    system =
    (languageDirective ? `${languageDirective}\n\n` : '') +
    (voiceDirective ? `${voiceDirective}\n\n` : '') +
    `${PREAMBLE_HEAD} ${retrievalNote} So: ${PREAMBLE_RULES_BODY}\n\n` +
    (brainGrounding ? `${brainGrounding}\n\n` : '') +
    (aboutOperator ? `WHAT YOU KNOW ABOUT THE OPERATOR:\n${aboutOperator}\n\n` : '') +
    (recallBlock ? `${recallBlock}\n\n` : '') +
    (tasteBlock ? `${tasteBlock}\n\n` : '') +
    (calibrationBlock ? `${calibrationBlock}\n\n` : '') +
    (decisionBlock ? `${decisionBlock}\n\n` : '') +
    (failureBlock ? `${failureBlock}\n\n` : '') +
    (activeSkillBlock ? `${activeSkillBlock}\n\n` : '') +
    (skillBlock ? `${skillBlock}\n\n` : '') +
    (namedSkillBlock ? `${namedSkillBlock}\n\n` : '') +
    (pinnedBlock ? `${pinnedBlock}\n\n` : '') +
    (rawEscalationBlock ? `${rawEscalationBlock}\n\n` : '') +
    `CONTEXT (retrieved for: ${query}):\n${context}` +
    (sessionsBlock ? `\n\n${sessionsBlock}` : '')
  }

  const msgs: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
      // m.content is a string for normal turns; for the last user turn with
      // vision images it's a multimodal array (text + image_url parts).
      // Both are valid ChatCompletionMessageParam content shapes; pass through
      // without forcing a string cast so images reach the vision-capable model.
      msgs.push({ role: m.role, content: m.content } as ChatCompletionMessageParam)
    }
  }
  return msgs
}

// success-miner — the POSITIVE-signal half of the learning loop (legacy harness
// success_miner). The store learns from corrections (what went wrong); it must also
// learn from ENDORSEMENTS (what went right) or it only ever sharpens away from mistakes,
// never toward proven-good moves. When the operator's turn is a genuine endorsement of
// the prior answer — a short affirmation reacting to it, with no correction — we capture
// that (query, answer) as a success exemplar (the raw material for exemplars / few-shot
// / "do more of this"). Reaction-grounded like the harness's is_noise gate: a bare "yes"
// with no antecedent answer is dropped.
//
// Persistence mirrors operator-model: a small JSON in the local-brain userData dir.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { messageOf } from '../guarded'

export interface SuccessTrace {
  id: string
  ts: number
  query: string // the request that produced the endorsed answer
  answer: string // the endorsed answer (snippet)
}

const MAX_TRACES = 500
const ANSWER_SNIPPET = 600
let store: SuccessTrace[] = []
let storePath: string | null = null

/** Move an unreadable / wrong-shape success-traces.json aside to `<name>.<ISO-stamp>.corrupt` so the
 *  first persist() of the session cannot overwrite it. Never deletes; never overwrites in place.
 *  Returns false when the rename itself failed — the caller then clears `storePath` so persist()
 *  abstains rather than clobbering bytes we could not preserve. Twin of operator-model's
 *  `quarantineCorruptOperatorModel` / learn-store's `quarantineCorruptTaste`. */
function quarantineCorruptSuccessStore(path: string, cause: unknown): boolean {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[success-miner] UNUSABLE success-traces.json at ${path} (${messageOf(cause)}) — quarantined to ` +
        `${sidecar}; the in-memory store reset to EMPTY, so the endorsement exemplars in that file are NOT ` +
        'restored automatically and nothing regenerates them (moat-health counts them as the moat signal ' +
        'and skill-library distils named skills from them). Recover the sidecar by hand or via restoreLatestMoat.'
    )
    return true
  } catch (e) {
    console.error(
      `[success-miner] UNUSABLE success-traces.json at ${path} (${messageOf(cause)}) and quarantine ` +
        `FAILED (${messageOf(e)}) — persistence DISABLED for this session rather than overwriting bytes ` +
        'we could not preserve. Successes captured this session are in-memory only; fix or move the file and restart.'
    )
    return false
  }
}

/** Wire the persistence path (local-brain userData dir) + load existing success traces.
 *
 *  Why the failure branches quarantine instead of falling back to `store = []`: storePath is set
 *  BEFORE the read, so a failed load leaves persistence ARMED over an empty store, and the very next
 *  endorsing turn (server.ts → recordSuccess → persist) writes `{traces:[<1 trace>]}` over the whole
 *  file, destroying up to MAX_TRACES exemplars. The 5-minute projectMoatToVault flush in main.ts then
 *  copies that one-row file onto the durable vault mirror with no shape check and no shrink guard, so
 *  the backup is wiped too — and nothing regenerates endorsements.
 *
 *  The ABSENT and EMPTY file cases stay safe cold starts (nothing to lose) and a healthy file
 *  round-trips; only the TRUNCATED/drifted file destroys. The shape-drift variant is what made this
 *  invisible: `Array.isArray(raw.traces) ? … : []` reset the store with NO error thrown at all when
 *  the file held `{}`, a bare JSON array, or a drifted top-level key — so the wipe never even reached
 *  the catch, and there was nothing to notice. Hence the guard validates the SHAPE, not just the
 *  parse, exactly as operator-model's setOperatorModelPath and learn-store's readExistingTaste do. */
export function setSuccessStorePath(userDataDir: string): void {
  const path = join(userDataDir, 'success-traces.json')
  storePath = path
  try {
    if (!existsSync(path)) return // cold start: nothing on disk to lose
    const text = readFileSync(path, 'utf-8')
    if (!text.trim()) return // empty file holds nothing to preserve
    const parsed: unknown = JSON.parse(text)
    const shape =
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        ? `not a JSON object: ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`
        : !Array.isArray((parsed as { traces?: unknown }).traces)
          ? `missing/!array 'traces' key (top-level keys: ${Object.keys(parsed as object).slice(0, 8).join(', ') || 'none'})`
          : null
    if (shape) throw new Error(shape) // parses fine, but cannot be carried forward — preserve it
    store = (parsed as { traces: SuccessTrace[] }).traces.slice(-MAX_TRACES)
  } catch (e) {
    store = []
    if (!quarantineCorruptSuccessStore(path, e)) storePath = null
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(storePath, JSON.stringify({ traces: store }, null, 2), 'utf-8')
  } catch (e) { console.debug('[success-miner] best-effort:', messageOf(e)) }
}

// Short affirmations that endorse the prior answer (EN + CJK).
const ENDORSE = /\b(?:yes|yep|yeah|perfect|exactly|great|nice|awesome|correct|right|love it|works|ship it|lgtm)\b|👍|🙏|💯|对了?|对的|很好|完美|正是|没错|可以|不错|赞|搞定/i
// Markers that mean it is actually a correction / new instruction, NOT a pure endorsement.
const NEGATION = /\b(but|no|not|actually|wrong|instead|however|except|don'?t|isn'?t|doesn'?t)\b|但是?|不对|不是|错|其实|除了|不要|别/i

/** Is this operator turn a genuine endorsement (short, affirming, no correction)? PURE. */
export function isEndorsement(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || t.length > 120) return false // a long turn is a new request, not a "yes"
  if (NEGATION.test(t)) return false // "yes but…" / "对，不过…" is a correction
  return ENDORSE.test(t)
}

let idCounter = 0
const mkId = (): string => `sx-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

/** Record a success exemplar. Returns the trace. */
export function recordSuccess(query: string, answer: string): SuccessTrace {
  const trace: SuccessTrace = {
    id: mkId(),
    ts: Date.now(),
    query: (query ?? '').slice(0, 400),
    answer: (answer ?? '').slice(0, ANSWER_SNIPPET)
  }
  store.push(trace)
  if (store.length > MAX_TRACES) store = store.slice(-MAX_TRACES)
  persist()
  return trace
}

export function getSuccesses(): SuccessTrace[] {
  return [...store]
}
export function __resetSuccessStore(): void {
  store = []
  idCounter = 0
}

export interface TurnMessage {
  role: string
  content: string
}

/** If the operator's turn endorses the prior answer, capture (prior query, prior answer)
 *  as a success trace. Reaction-grounded: requires a real prior assistant answer, else
 *  returns null (a bare "yes" with no antecedent is dropped). */
export function captureSuccessFromTurn(userText: string, history: TurnMessage[]): SuccessTrace | null {
  if (!isEndorsement(userText)) return null
  // The endorsed answer = the last assistant message; the query = the user turn before it.
  let answerIdx = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && (history[i].content ?? '').trim()) {
      answerIdx = i
      break
    }
  }
  if (answerIdx < 0) return null
  let query = ''
  for (let i = answerIdx - 1; i >= 0; i--) {
    if (history[i].role === 'user' && (history[i].content ?? '').trim()) {
      query = history[i].content
      break
    }
  }
  return recordSuccess(query, history[answerIdx].content)
}

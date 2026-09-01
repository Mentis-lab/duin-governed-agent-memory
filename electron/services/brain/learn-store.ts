// learn-store — the WRITE side of the corrections→taste loop (the pure logic lives
// in learn-native). Owns corrections.jsonl (append-only capture) + taste-engine.json
// (atomic temp+rename). Completes the learn loop as a native unit, twin of
// calibration-store. Capture (appendCorrection) → reflect+recompute (runReflect writes
// taste) → consume (getTaste, in learn-native). Ready to be THE writer once the Python
// learn routine is retired (the coordinated flip).
import { appendFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { messageOf } from '../guarded'
import {
  loadCorrections,
  loadStatusOverlay,
  computeTaste,
  correctionKey,
  reflect,
  toks,
  CORRECTION_STATUS_FILE,
  LIFECYCLE_STATUSES,
  type Correction,
  type Taste,
  type Reflection
} from './learn-native'
import { correctionFailsBindings, type BindingRow } from './binding-ledger'
import { loadBindings, writeBindings } from './binding-store'

const stateDir = (vaultDir: string): string => join(vaultDir, '.duin', '_state')
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

function atomicWrite(path: string, content: string): void {
  atomicWriteFileSync(path, content, 0o644) // temp → fdatasync → rename: crash-durable (the moat file)
}
function countLines(path: string): number {
  try {
    return readFileSync(path, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

/** Every content-key already in the stream, plus the non-blank line count. ONE read serving both
 *  the append dedupe and the `total` the caller gets back — this REPLACES the post-append
 *  `countLines` read rather than adding a second pass, so the append path does the same amount of
 *  I/O it always did. Unparseable lines are counted but not keyed (they are residue to preserve,
 *  never something to interpret). */
function readStreamIndex(path: string): { keys: Set<string>; count: number } {
  const keys = new Set<string>()
  let count = 0
  let txt: string
  try {
    txt = readFileSync(path, 'utf-8')
  } catch {
    return { keys, count } // cold vault: nothing appended yet
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    count++
    try {
      keys.add(correctionKey(JSON.parse(line) as Correction))
    } catch {
      /* torn/unparseable line: it still counts toward the stream, but it cannot be keyed */
    }
  }
  return { keys, count }
}
/** Outcome of reading the prior taste-engine.json. `abstain` means we could not preserve
 *  the bytes that are there, so the caller must NOT write over them. */
type TasteRead =
  | { ok: true; taste: Partial<Taste>; warning?: string; quarantined?: string }
  | { ok: false; warning: string }

/** Move an unreadable/non-object taste-engine.json aside to `<name>.<ISO-stamp>.corrupt` so the
 *  recompute-and-write that follows cannot overwrite it. Never deletes; never overwrites in
 *  place. Returns the sidecar path, or null when the rename itself failed. Twin of
 *  capability-ledger's `quarantineCorruptStore` / import-agent-system's `quarantineCorruptConfig`. */
function quarantineCorruptTaste(path: string, cause: unknown): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[learn-store] UNREADABLE taste-engine.json at ${path} (${messageOf(cause)}) — quarantined to ` +
        `${sidecar}; taste was recomputed from corrections.jsonl ALONE, so seeded values/frameworks ` +
        '(and any other persisted keys) are NOT restored automatically — recover the sidecar by hand ' +
        'or via restoreLatestMoat.'
    )
    return sidecar
  } catch (e) {
    console.error(
      `[learn-store] UNREADABLE taste-engine.json at ${path} (${messageOf(cause)}) and quarantine ` +
        `FAILED (${messageOf(e)}) — refusing to write recomputed taste rather than overwrite bytes we ` +
        'could not preserve.'
    )
    return null
  }
}

/**
 * Read the prior taste for the recompute to carry forward.
 *
 * Why the corrupt branch is not a `return {}` fallback: `values` and `frameworks` are
 * OPERATOR-SEEDED (learn-native documents them as such) and NOTHING in this tree regenerates
 * them — computeTaste only ever forwards `existing.values ?? []`, and learn-store's atomicWrite
 * below is the only writer of the file. So collapsing a *partial* read failure into `{}` and
 * then writing that object back turns a truncated file (a crash, an editor save, a sync
 * conflict) into a total, permanent erasure of the seeded grounding that
 * personalization-blocks folds into every LLM turn — while both /learn/reflect and
 * /state/learn-loop/run happily return 200 ok.
 *
 * Pattern B: the ABSENT-file case is already safe (cold vault, nothing to lose) and the HEALTHY
 * case round-trips; only the PARTIAL/corrupt case destroys. Pattern A: the exact guard already
 * exists in two siblings — capability-ledger's `quarantineCorruptStore` and
 * import-agent-system's `quarantineCorruptConfig`, both at the identical
 * catch-an-unparseable-JSON-store site — and this call site was the one skipping it.
 *
 * Note the non-throwing variant is the nastier one: a file holding a JSON ARRAY parses fine, and
 * `existing.values` then resolves to `Array.prototype.values` (a FUNCTION, so `?? []` never
 * fires); JSON.stringify drops it and the written file ends up with NO `values` key at all while
 * `counts.values` records the function's arity. Hence the guard validates the shape (non-null,
 * non-array object), not just the parse.
 *
 * If the bytes cannot be preserved (read error, or the quarantine rename fails) we abstain from
 * the write entirely — proceeding blind over content we failed to save is the one outcome that
 * cannot be undone, and reflect is retryable.
 */
function readExistingTaste(sd: string): TasteRead {
  const path = join(sd, 'taste-engine.json')
  if (!existsSync(path)) return { ok: true, taste: {} } // cold vault: nothing to lose
  let raw: string
  try {
    // readFileSync, not a swallow-to-'' helper: "unreadable" must stay distinguishable from
    // "empty", or we would take the safe-to-clobber path over a file we never actually saw.
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    console.error(`[learn-store] taste-engine.json at ${path} could not be read (${messageOf(e)}) — refusing to overwrite it blind.`)
    return { ok: false, warning: `taste-engine.json could not be read (${messageOf(e)}), so taste was NOT rewritten (refusing to overwrite it blind); the prior file is untouched.` }
  }
  if (!raw.trim()) return { ok: true, taste: {} } // empty file holds nothing to preserve
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const sidecar = quarantineCorruptTaste(path, e)
    if (!sidecar) return { ok: false, warning: `taste-engine.json is unparseable and could not be quarantined, so taste was NOT rewritten (that would have destroyed it).` }
    return { ok: true, taste: {}, quarantined: sidecar, warning: `taste-engine.json was unparseable (${messageOf(e)}); its bytes were quarantined to ${sidecar} and taste was rebuilt from corrections.jsonl alone — seeded values/frameworks were NOT carried forward.` }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, taste: parsed as Partial<Taste> }
  // Parsed, but not a taste object (array / scalar / null). Same reasoning as unparseable:
  // we cannot carry it forward, so preserve it rather than clobber it.
  const sidecar = quarantineCorruptTaste(path, new Error(`not a JSON object: ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`))
  if (!sidecar) return { ok: false, warning: `taste-engine.json is not a taste object and could not be quarantined, so taste was NOT rewritten (that would have destroyed it).` }
  return { ok: true, taste: {}, quarantined: sidecar, warning: `taste-engine.json was not a taste object; its bytes were quarantined to ${sidecar} and taste was rebuilt from corrections.jsonl alone — seeded values/frameworks were NOT carried forward.` }
}

/** Capture arrow (port of append_correction). Operator-only contract: a row carrying
 *  `source` is a MACHINE row and is REJECTED (it must never pollute the learn stream). */
export function appendCorrection(
  vaultDir: string | null,
  row: Correction,
  today: Date = new Date()
): { ok: boolean; total: number; duplicate?: boolean } {
  if (!vaultDir) return { ok: false, total: 0 }
  if (!row || typeof row !== 'object') throw new Error('correction must be an object')
  if (row.source) throw new Error("operator corrections must omit 'source' (machine rows are not learning signal)")
  const rec = {
    ts: String(row.ts || isoDay(today)).slice(0, 10),
    session: row.session ?? '',
    skill: row.skill ?? '',
    artifact: row.artifact ?? '',
    ai_output: row.ai_output ?? '',
    correction: row.correction ?? '',
    why: row.why ?? '',
    candidate_rule: row.candidate_rule ?? '',
    touches: row.touches ?? {},
    polarity: row.polarity ?? 'correction',
    status: 'new'
  }
  const corrPath = join(stateDir(vaultDir), 'corrections.jsonl')
  mkdirSync(stateDir(vaultDir), { recursive: true }) // cold vault: the first correction must not ENOENT
  // ONE TURN, ONE ROW — the durable half of the double-seam guard.
  //
  // Capture fires from two seams now (the renderer's ipc/chat.ts and the /agui turn boundary), and
  // learn-bridge replays its queued rows after a restart. capture-hook's in-process turn memo
  // catches the same-process double-fire, but it cannot see across a restart, and it is not the
  // only producer that reaches this function. This is the ledger's own guarantee: the SAME
  // judgment, about the same prior answer, on the same DAY, is one row.
  //
  // Bounded by design, so recurrence — the signal a theme needs to reach MIN_BIND — is never
  // swallowed: `ts` is part of the key, so the same judgment repeated on a LATER day is a
  // different key and appends normally. Only a same-day byte-identical repeat collapses, and that
  // is the double-fire, not an operator saying something twice.
  const index = readStreamIndex(corrPath)
  const key = correctionKey(rec)
  if (index.keys.has(key)) {
    // Return ok:true — from the caller's point of view the judgment IS in the ledger. Reporting a
    // failure here would make chat.ts's best-effort arrow look broken on a turn it captured fine.
    return { ok: true, total: index.count, duplicate: true }
  }
  appendFileSync(corrPath, JSON.stringify(rec) + '\n', 'utf-8') // O_APPEND: atomic complete-line write
  // CLOSE THE LEARN LOOP.
  //
  // A confirmed binding carries a falsifiable prediction — "this theme will not recur" — and until
  // now NOTHING ever tested it. `checkRecurrence` and `correctionFailsBindings` existed, were pure,
  // were unit-tested, and had no production caller anywhere in the app. Every binding therefore sat
  // `status: 'open'` forever and the guarantee could not fail. The constitution opens by saying a
  // principle you cannot fail is decoration; this was the loop's own held-out test, decorative.
  //
  // A new correction IS that held-out evidence, and this is the single place one arrives. Operator
  // rows only — machine rows are not learning signal, enforced by the `row.source` guard above — and
  // the tokenizer is learn-native's own `toks` so tokens match the themes bindings were cut from.
  //
  // Best-effort and non-fatal by design: the correction is already durably appended by the line
  // above, and losing a falsification is bad while losing the capture would be worse.
  try {
    const bindings = loadBindings(vaultDir)
    const failed = correctionFailsBindings(bindings, rec, toks, Date.now())
    if (failed.length > 0) {
      writeBindings(vaultDir, bindings)
      console.log(
        `[learn-store] correction falsified ${failed.length} binding(s): ${failed.map((b) => b.id).join(', ')}`
      )
    }
  } catch (e) {
    console.warn('[learn-store] binding recurrence check failed (non-fatal):', messageOf(e))
  }
  return { ok: true, total: index.count + 1 } // the read above already counted the stream; +1 is this row
}

// ──────────────────── the correction status lifecycle (the missing WRITER) ────────────────────
//
// `status` had READERS and no writer. learn-native skips `status === 'dropped'`; computeTaste
// forwards the status onto every taste rule; and personalization-recall reads `status === 'bound'`
// TWICE — once to give a bound rule BETA_CONFIRMED instead of 1.0 in recall, and once to admit it
// into `confirmedJudgmentTexts`, the judgment corpus retrieval is re-ranked against. Because
// appendCorrection hard-codes 'new' and nothing ever moved it, both of those arms were inert: every
// taste rule carried the unconfirmed beta and the rerank corpus held no taste rules at all. The
// transition was structurally impossible, not merely idle.
//
// WHAT MAKES A CORRECTION 'bound'. A binding is minted only by a human confirm (POST
// /state/bind-candidate) and carries the THEME it was cut from. A correction belongs to that
// binding when it matches the theme by the ledger's own membership rule AND predates the bind.
// The `boundAt` half is not decoration — it is the whole distinction: binding-ledger's
// `checkRecurrence` uses the SAME token-overlap test to mean the opposite thing for a correction
// that arrives AFTER the bind (that one FALSIFIES the guarantee). Constituent before, falsifier
// after.
//
// Reconciled rather than event-sourced, and that is the deliberate choice: it is idempotent, it
// heals retroactively (bindings confirmed before this code existed get their constituents marked
// on the next reflect), and it needs no cooperation from the bind route — which lives in another
// lane. A revert flows through the same way: the binding stops contributing, the desired status
// falls back to 'new', and a 'new' row is appended.

/** Theme membership, mirroring binding-ledger's `checkRecurrence` threshold. Duplicated rather
 *  than imported because binding-ledger's `themeOverlap` is module-private and that file is not
 *  this lane's to edit; exporting it there is the tidier end state. */
const BOUND_OVERLAP_MIN = 2
function matchesTheme(theme: string[], correctionTokens: Set<string>): boolean {
  let n = 0
  for (const t of theme) if (correctionTokens.has(t)) n++
  return n >= BOUND_OVERLAP_MIN
}

// Statuses this reconciler owns live in learn-native as LIFECYCLE_STATUSES — ONE definition,
// shared with the overlay-join in loadCorrections. Anything else on a row (e.g. 'dropped') is
// somebody else's verdict and is left exactly as found: a reconciler that overwrote states it
// does not understand would silently resurrect rows another arm had retired.

/**
 * Move constituent corrections to 'bound' (and back to 'new' when their binding is reverted),
 * recording each transition in the append-only overlay sidecar. Mutates the in-memory rows too so
 * the SAME reflect pass computes taste from the fresh statuses instead of lagging a tick behind.
 * Returns the number of transitions written. Best-effort: a status is bookkeeping, and losing it
 * must never cost the caller its reflection.
 */
export function reconcileCorrectionStatus(
  vaultDir: string,
  corrections: Correction[],
  today: Date = new Date()
): number {
  const sd = stateDir(vaultDir)
  try {
    const live: BindingRow[] = loadBindings(vaultDir).filter((b) => b && b.reverted === null && Array.isArray(b.theme))
    const overlay = loadStatusOverlay(sd)
    const writes: string[] = []
    for (const r of corrections) {
      const current = String(r.status ?? '')
      if (!LIFECYCLE_STATUSES.has(current)) continue
      const text = [r.why ?? '', r.correction ?? '', r.candidate_rule ?? ''].join(' ')
      const tokens = toks(text)
      const day = String(r.ts ?? '').slice(0, 10)
      const bound = live.some((b) => matchesTheme(b.theme, tokens) && (!day || day <= isoDay(new Date(b.boundAt))))
      const desired = bound ? 'bound' : 'new'
      if (desired === (current || 'new')) continue
      const key = correctionKey(r)
      if (overlay.get(key) === desired) continue // already recorded; do not append a duplicate row
      writes.push(JSON.stringify({ key, status: desired, ts: today.toISOString() }))
      r.status = desired // same-pass consistency: computeTaste below must see the new status
    }
    if (writes.length) {
      mkdirSync(sd, { recursive: true })
      appendFileSync(join(sd, CORRECTION_STATUS_FILE), writes.join('\n') + '\n', 'utf-8')
    }
    return writes.length
  } catch (e) {
    console.warn('[learn-store] correction status reconcile failed (non-fatal):', messageOf(e))
    return 0
  }
}

/** Reflect + recompute + PERSIST taste (port of reflect→build_taste's write). Returns
 *  the reflection surface (themes + binding candidates). */
export function runReflect(vaultDir: string | null, today: Date = new Date()): Reflection {
  if (!vaultDir) return { stream_size: 0, themes: [], binding_candidates: [], taste_counts: {} }
  const sd = stateDir(vaultDir)
  const corr = loadCorrections(sd)
  // The status lifecycle's writer. Runs before computeTaste so a newly-bound correction reaches
  // taste-engine.json — and therefore personalization-recall's confirmed-judgment arms — in this
  // pass rather than the next one.
  reconcileCorrectionStatus(vaultDir, corr, today)
  const read = readExistingTaste(sd)
  const existing = read.ok ? read.taste : {}
  if (read.ok) {
    const taste = computeTaste(corr, existing)
    taste.generated_at = today.toISOString() // matches build_taste's utcnow+Z stamp (nondeterministic)
    mkdirSync(sd, { recursive: true }) // cold vault: ensure _state exists before the atomic write
    atomicWrite(join(sd, 'taste-engine.json'), JSON.stringify(taste, null, 2))
  }
  // Abstain path: the prior bytes could not be preserved, so the recompute is NOT persisted —
  // the reflection surface is still returned (it is pure), carrying the warning to the route.
  const out = reflect(corr, today, existing)
  if (read.warning) out.warning = read.warning
  if (read.ok && read.quarantined) out.quarantined = read.quarantined
  if (!read.ok) out.taste_write_skipped = true
  else appendBindingCandidates(sd, out, today)
  return out
}

/** Snapshot the binding candidates this reflection surfaced.
 *
 *  Until now these were computed here, returned in an HTTP body, and discarded — the Learn loop's
 *  headline surfacing signal had NO durable record, so "how many candidates did we surface, and did
 *  that number move?" was unanswerable over any time range. Only operator-CONFIRMED binds reached
 *  binding-ledger.jsonl, which measures the end of the funnel and not its mouth.
 *
 *  DEDUPED, not appended blindly: learn-bridge POSTs /learn/reflect on a schedule and reflect() is
 *  deterministic over an append-only stream, so a naive append would write an identical row every
 *  tick forever — unbounded disk growth dressed up as instrumentation. Only a CHANGED candidate set
 *  writes a row, which also makes the file read as a change-log rather than a poll-log.
 *
 *  Skipped on the taste-write abstain path: if the prior bytes could not be preserved we are already
 *  declining to persist the recompute, and recording a derived snapshot from a state we refused to
 *  trust would be worse than recording nothing.
 *
 *  Best-effort: a failure here must never cost the caller its reflection. */
function appendBindingCandidates(sd: string, out: Reflection, today: Date): void {
  try {
    const cands = out.binding_candidates ?? []
    const key = JSON.stringify(cands)
    const path = join(sd, 'binding-candidates.jsonl')
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
      const last = lines[lines.length - 1]
      if (last) {
        try {
          if (JSON.stringify(JSON.parse(last).binding_candidates ?? []) === key) return
        } catch {
          /* unparseable tail: fall through and write, rather than lose the snapshot */
        }
      }
    }
    mkdirSync(sd, { recursive: true })
    const rec = {
      ts: today.toISOString(),
      stream_size: out.stream_size,
      count: cands.length,
      binding_candidates: cands
    }
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8')
  } catch (e) {
    console.warn('[learn-store] binding-candidate snapshot failed (non-fatal):', messageOf(e))
  }
}

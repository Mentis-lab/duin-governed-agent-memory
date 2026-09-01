// capability-ledger — the earned-autonomy registry (DUIN Autonomic Nervous System
// spec §1.2 / §5). Every ANS capability sits on exactly one RUNG of the escalation
// ladder, and the governor migrates it up (toward autonomous) only by earned record,
// down (toward held) instantly on any miss. This module owns the registry + the
// feedback stats the governor reads; governor.ts owns the decision.
//
//   reflexive  — runs silently, logged        (most autonomous)
//   stage      — does the work, human ratifies (one click)
//   hold       — never auto; explicit human    (least autonomous)
//
// Persistence mirrors operator-model: a small JSON in the local-brain userData dir.
import { existsSync, readFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { atomicWriteDurable } from '../brain/durable-write'
import { classifyAction } from '../governance/action-class'
import { messageOf } from '../guarded'

/** The autonomy FLOOR the action-class taxonomy imposes on a capability. A capability
 *  whose title is a MATCHED CAP-class action (send / delete / exec / financial / …) can
 *  never earn silent (reflexive) autonomy — pinned to 'stage' (human ratifies). The
 *  unknown fail-safe does NOT tighten here (it would wrongly cap safe-by-construction
 *  internals like consolidation); it defers to the seeder's explicit floor. */
function classFloor(title: string): Rung | null {
  const cls = classifyAction(title)
  return cls.matched && cls.disposition === 'cap' ? 'stage' : null
}

/** The capability the RSI apply path records its reversible writes against (item 24). Exported so the
 *  producer (self-improve-loop) and the seeder can never drift on the id revertAction must resolve. */
export const RSI_APPLY_CAP_ID = 'rsi-tunable-apply'
/** Unattended candidate→provisional promotion in the operator model. Consumed by
 *  `autoPromoteCandidates`; declared here so the id has one owner rather than
 *  being a string literal at both the registration and the gate. */
export const OPERATOR_FACT_PROMOTION_CAP_ID = 'operator-fact-promotion'

export type Rung = 'reflexive' | 'stage' | 'hold'

/** Most-autonomous → least. Index 0 = reflexive. */
export const RUNG_ORDER: Rung[] = ['reflexive', 'stage', 'hold']

export interface Capability {
  id: string
  title: string
  /** Current rung. */
  rung: Rung
  /** The MOST autonomous rung this capability may ever reach. 'hold' pins an
   *  alignment-core capability at hold forever (can never be granted autonomy). */
  floorRung: Rung
  /** Calibrated domain that gates promotion (a kind in the calibration ledger).
   *  Undefined ⇒ no calibration requirement. */
  calibKind?: string
  /** Rolling feedback stats (recomputed by feedback, read by the governor). */
  ratifyN: number // # of staged items the human decided on
  ratifyK: number // # of those the human ratified (accepted)
  reverts: number // ratified-then-reverted misses (the demote signal)
  /** Reverts already consumed by a governor pass — lets the governor act on NEW
   *  reverts only (a miss demotes once, not every pass). */
  revertsHandled: number
  lastDemoteAt?: number
  updatedAt: number
}

const MAX_CAPS = 200
let store: Capability[] = []
let storePath: string | null = null

export function setCapabilityLedgerPath(userDataDir: string): void {
  storePath = join(userDataDir, 'ans-capabilities.json')
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { capabilities?: Partial<Capability>[] }
      store = (Array.isArray(raw.capabilities) ? raw.capabilities : [])
        .filter((c) => typeof c?.id === 'string')
        .slice(0, MAX_CAPS)
        .map(normalize)
    }
  } catch (e) {
    // The file exists but is unreadable/unparseable (a torn write from a pre-durable-write
    // build, or disk corruption). Resetting to [] is the only safe in-memory state, but
    // seedCapabilities() runs immediately after us and persist()s three defaults OVER this
    // file — which would destroy every earned rung / ratify record / non-seed capability id
    // with no trace. So QUARANTINE the bytes first (preserve + record + stamp): move them
    // aside to a timestamped .corrupt sidecar and log loudly, so the reset is recoverable
    // and auditable rather than silent. Never delete; never overwrite in place.
    store = []
    quarantineCorruptStore(storePath, e)
  }
}

/** Move an unparseable ledger aside to `<name>.<ISO-stamp>.corrupt` so the imminent reseed
 *  cannot overwrite it. Best-effort: if the rename fails we still log, and we deliberately
 *  do NOT fall back to deleting — a file we failed to preserve stays where it is. */
function quarantineCorruptStore(path: string, cause: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[capability-ledger] UNREADABLE ledger at ${path} (${messageOf(cause)}) — quarantined to ${sidecar}; ` +
        'in-memory store reset to empty and defaults will be reseeded. Earned rungs/ratify history ' +
        'from the quarantined file are NOT restored automatically — recover it by hand or via restoreLatestMoat.'
    )
  } catch (e) {
    console.error(
      `[capability-ledger] UNREADABLE ledger at ${path} (${messageOf(cause)}) and quarantine FAILED ` +
        `(${messageOf(e)}) — store reset to empty; the corrupt file is about to be overwritten by the reseed.`
    )
  }
}

function normalize(c: Partial<Capability>): Capability {
  const rung = (RUNG_ORDER as string[]).includes(String(c.rung)) ? (c.rung as Rung) : 'stage'
  const floorRung = (RUNG_ORDER as string[]).includes(String(c.floorRung)) ? (c.floorRung as Rung) : 'reflexive'
  return {
    id: String(c.id),
    title: c.title || String(c.id),
    rung,
    floorRung,
    ...(c.calibKind ? { calibKind: String(c.calibKind) } : {}),
    ratifyN: Number(c.ratifyN ?? 0),
    ratifyK: Number(c.ratifyK ?? 0),
    reverts: Number(c.reverts ?? 0),
    revertsHandled: Number(c.revertsHandled ?? 0),
    ...(typeof c.lastDemoteAt === 'number' ? { lastDemoteAt: c.lastDemoteAt } : {}),
    updatedAt: Number(c.updatedAt ?? Date.now())
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    // Crash-safe: tmp → fsync → rename → fsync(dir), same as the two sibling stores in this
    // directory (action-ledger.ts, snapshot-store.ts). A bare writeFileSync opens with 'w' and
    // truncates IN PLACE, so a crash mid-write leaves a torn ans-capabilities.json that the next
    // boot fails to parse — and the reseed then overwrites the wreckage with three defaults.
    atomicWriteDurable(storePath, JSON.stringify({ capabilities: store }, null, 2))
  } catch (e) { console.debug('[capability-ledger] best-effort:', messageOf(e)) }
}

export interface CapabilityDef {
  id: string
  title: string
  /** Where it starts. Default 'stage' — nothing is autonomous until earned. */
  rung?: Rung
  /** Lowest reachable rung. Default 'reflexive' (may earn full autonomy). Use 'hold'
   *  for alignment-core capabilities that must always stay manual. */
  floorRung?: Rung
  calibKind?: string
}

/** Register (idempotently) a capability. Existing rows keep their earned rung + stats;
 *  only static fields (title/floor/calibKind) refresh. */
export function registerCapability(def: CapabilityDef): Capability {
  const existing = store.find((c) => c.id === def.id)
  if (existing) {
    existing.title = def.title
    if (def.floorRung) existing.floorRung = def.floorRung
    if (def.calibKind) existing.calibKind = def.calibKind
    persist()
    return existing
  }
  // Explicit floor wins; otherwise the action-class taxonomy sets it (matched-CAP → stage).
  const floorRung: Rung = def.floorRung ?? classFloor(def.title) ?? 'reflexive'
  const cap = normalize({
    id: def.id,
    title: def.title,
    rung: def.rung ?? 'stage',
    floorRung,
    calibKind: def.calibKind,
    updatedAt: Date.now()
  })
  store.unshift(cap)
  if (store.length > MAX_CAPS) store = store.slice(0, MAX_CAPS)
  persist()
  return cap
}

export type FeedbackVerb = 'ratify' | 'dismiss' | 'revert'

/** Record one human/observed verdict against a capability's staged output. */
export function recordFeedback(id: string, verb: FeedbackVerb): boolean {
  const c = store.find((x) => x.id === id)
  if (!c) return false
  if (verb === 'ratify') {
    c.ratifyN++
    c.ratifyK++
  } else if (verb === 'dismiss') {
    c.ratifyN++
  } else if (verb === 'revert') {
    c.reverts++ // a ratified act that was reverted — the miss that demotes
  }
  c.updatedAt = Date.now()
  persist()
  return true
}

/** The enforcement gate: what a capability may do RIGHT NOW.
 *  reflexive → 'run' (act silently); stage → 'stage' (prepare, await ratify);
 *  hold → 'hold' (explicit human only).
 *
 *  `unknown` is its OWN answer, not a default. It used to return the "safe" 'stage', which is safe
 *  only for a caller that treats stage as blocking — and the one caller that gates on this blocks
 *  solely on 'hold', so "I have never heard of this capability" was silently read as "permitted to
 *  act unattended". That matters because `setCapabilityLedgerPath` resets the store to [] on a
 *  corrupt ledger: a governor `hold`, reached deliberately from evidence, would not survive the
 *  corruption and unattended promotion would quietly resume. A gate cannot fail safely toward a
 *  value whose meaning depends on who is asking, so the ledger now says what it actually knows and
 *  each caller decides. */
export function classify(id: string): 'run' | 'stage' | 'hold' | 'unknown' {
  const c = store.find((x) => x.id === id)
  if (!c) return 'unknown'
  return c.rung === 'reflexive' ? 'run' : c.rung
}

export function listCapabilities(): Capability[] {
  return store.map((c) => ({ ...c }))
}
export function getCapability(id: string): Capability | undefined {
  const c = store.find((x) => x.id === id)
  return c ? { ...c } : undefined
}
/** Governor-only: commit a rung change + demote stamp. */
export function setRung(id: string, rung: Rung, opts: { demoted?: boolean } = {}): boolean {
  const c = store.find((x) => x.id === id)
  if (!c) return false
  c.rung = rung
  if (opts.demoted) {
    c.lastDemoteAt = Date.now()
    c.revertsHandled = c.reverts // consume the reverts that triggered this demote
  }
  c.updatedAt = Date.now()
  persist()
  return true
}
export function __resetCapabilityLedger(): void {
  store = []
}

/** Seed the starter capabilities that map to what's actually wired today. Idempotent —
 *  safe to call every boot. Nothing starts autonomous unless it's safe BY CONSTRUCTION
 *  (memory-consolidation runs silently and is reversible), per ANS spec §10. */
export function seedCapabilities(): void {
  // The memory promotion gate — fed by the operator govern loop's confirms/reverts.
  // Starts staged (human-endorsed → probation); the ANS governor can PROPOSE graduating
  // it toward reflexive once its ratify record earns it.
  registerCapability({
    id: OPERATOR_FACT_PROMOTION_CAP_ID,
    title: 'Promote a learned fact to a rule',
    rung: 'stage'
  })
  // Consolidation runs silently at topic-close and is reversible → reflexive by
  // construction, pinned there (floor reflexive, can't be demoted below its safe home
  // unless it starts missing).
  registerCapability({ id: 'memory-consolidation', title: 'Consolidate a closed topic', rung: 'reflexive' })
  // Item 19 — the autonomous-loop capability whose earned trust scales loop ceilings.
  // calibKind fixes the governor's inert-calibration defect (handoff §3.3): with it set,
  // evidenceFor requires a NON-gated calibration record for 'autonomous-loop' before a
  // promotion can even be PROPOSED — fail-closed, so raw ratify count alone can never
  // arm more autonomy ("never auto-arm on zero data"). The calibration FEED for this kind
  // (recording ratify=hit / revert=miss into the track record) is a separately-reviewed
  // follow-on; until it exists, promotion proposals are correctly blocked while the ratify
  // stats still accrue via recordFeedback.
  registerCapability({
    id: 'autonomous-loop',
    title: 'Run an autonomous background loop',
    rung: 'stage',
    calibKind: 'autonomous-loop'
  })
  // Item 24 — the ONE autonomous graduated file-write DUIN performs (self-improve-loop.applyChange,
  // reached from the autonomy-gated RSI tick). Seeded because revertAction REFUSES an undo whose
  // capability row is missing rather than lose the demote signal, so the producer is only usable
  // once this id exists. floorRung is pinned to 'stage': a change the brain makes to its OWN
  // tunables must never graduate to silent (reflexive) autonomy, however good its ratify record.
  registerCapability({
    id: RSI_APPLY_CAP_ID,
    title: 'Apply a self-improvement change to a tunable file',
    rung: 'stage',
    floorRung: 'stage'
  })
  // The MODEL-initiated goal TERMINAL-transition authority (abort / clear / complete
  // an operational goal). DUIN routes a model actor's terminal goal transition through
  // this capability's rung instead of upstream's static model-cannot-abort rule
  // (goal-transition-authority.ts). Starts staged → by DEFAULT a model cannot terminate
  // a goal autonomously (matches upstream's deny), but the governor can promote it to
  // reflexive once its ratify record earns it. User/system actors bypass the gate.
  registerCapability({
    id: 'goal-terminal-transition',
    title: 'Abort, clear, or complete an operational goal',
    rung: 'stage'
  })
  // The SIX native /agui gated tools (local-brain/agui-guard.ts's AGUI_GATED_TOOLS — host-exec +
  // irreversible ops the gate comment calls "earned, never default"). resolveAguiGate's GOVERN
  // (compose) block (agui-gate.ts, unconditionally ON by default) looks these up by
  // getCapability(tc.function.name) so an ANS demotion can TIGHTEN the tier verdict. Until now
  // nothing ever registered a capability under one of these ids: the five ids above are abstract
  // ANS-native concepts, not tool names, and external-action.ts (act/external-action.ts) only
  // ever registers ACT connector ids (calendar_delete_event, …) — a disjoint namespace. So for
  // every call this gate actually receives for a NATIVE /agui tool, getCapability(name) returned
  // undefined, rung was always null, and the composer never had anything real to compose —
  // invisible because the block still ran, still logged nothing wrong, and the tier gate alone
  // kept deciding correctly on its own, so nothing ever LOOKED broken.
  //
  // Seeded at 'reflexive' — a deliberate NO-OP (composeTierRung's meet of any tier verdict with
  // 'reflexive' is just that verdict) — mirroring the ACT-side fix's own precedent immediately
  // above in external-action.ts: this wires the lookup, it does not change today's behaviour.
  // floorRung 'stage' for all six: none of them is a read (they are exactly the set "earned,
  // never default"), so none may ever earn full silent autonomy — only a human/governor-driven
  // 'stage'/'hold' demotion is reachable from here. (This also satisfies self-improve-bench.ts's
  // live 'cap-class-floored' safety gate, which hard-fails if a send/delete/exec-titled
  // capability's floorRung is ever 'reflexive'.)
  //
  // KEEP IN SYNC with AGUI_GATED_TOOLS in local-brain/agui-guard.ts.
  for (const t of [
    { id: 'run_command', title: 'Run a host shell command' },
    { id: 'start_command', title: 'Start a long-running host command' },
    { id: 'delete_file', title: 'Delete a file on the host' },
    { id: 'move_file', title: 'Move or rename a file on the host' },
    { id: 'send_email', title: 'Send an email' },
    { id: 'spawn_agent', title: 'Spawn a nested subagent' }
  ]) {
    registerCapability({ id: t.id, title: t.title, rung: 'reflexive', floorRung: 'stage' })
  }
}

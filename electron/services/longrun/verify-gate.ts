// verify-gate.ts — Long-run VERIFICATION layer (the missing "V" in ETCLOVG).
//
// The activation this closes (sia-benchmark: harness.verify-gate, +72): the loop
// currently commits self-attested work durably — it marks a background item `done`
// the instant its turn returns, with NOTHING checking that the turn's BRAIN output
// is actually sound. This is a SECOND-BRAIN verify gate, NOT a code build: it does
// not run `npm run build` or a test suite. It gates commit→done on a BRAIN-output
// verify RECEIPT that asserts two properties the frontier (SAL / AHE / the field's
// missing-Verification finding) says a self-improving memory agent must guarantee:
//
//   1. MEMORY-WRITE NON-CORRUPTING — the turn's writes into the governed store did
//      not degrade identity integrity. Measured by REUSING brain-health's coherence
//      + purity axes (the identity-spine invariants I1/I2/I4/I8): if either axis
//      regressed past a small tolerance across the turn, the write corrupted the
//      store and the "done" self-attestation is refused.
//   2. DIGEST CITES REAL NOTES — every note the turn's digest/output cited resolves
//      to a real note node in the live brain graph. A citation to a note that does
//      not exist is a hallucinated provenance claim. Resolution REUSES brain-health's
//      `isNoteNode` + the same id/basename match `scoreCoherence` uses for the spine
//      bridge, so the gate and the health scorer agree on what "a real note" is.
//
// PURE: no I/O, no clock, no DB. The controller's injected `brainVerify` seam gathers
// the evidence (before/after health snapshot around the turn's writes + the cited
// notes parsed from the digest) and hands it here as a receipt; `verifyBeforeCommit`
// only judges. FAIL-SAFE-OPEN ON ABSENT EVIDENCE, FAIL-CLOSED ON A POSITIVE BAD
// SIGNAL: a check with no evidence (no snapshot, no citations, no graph) is `skip`,
// never a block — otherwise every ungoverned loop would stall. The gate blocks ONLY
// on a PROVEN corruption or a PROVEN dangling citation. Blocking = the item is not
// marked done (left in_progress for the L2 reconcile to re-run), never a silent pass.

import { isNoteNode, normLabel, type HealthGraph } from '../brain/brain-health'

/** The BRAIN-output evidence for one turn, gathered by the controller's seam. */
export interface VerifyReceipt {
  /** Identity-integrity axis score (0-100) BEFORE the turn's memory writes.
   *  Null/absent ⇒ the corruption check is skipped (no baseline to regress from). */
  coherenceBefore?: number | null
  /** Identity-integrity coherence AFTER the turn's memory writes. */
  coherenceAfter?: number | null
  /** Purity axis (scaffolding/prompt-echo leak) BEFORE the turn's writes. */
  purityBefore?: number | null
  /** Purity AFTER the turn's writes. */
  purityAfter?: number | null
  /** Note relpaths the turn's digest / output cited as provenance. */
  citedNotes?: string[]
  /** The live brain graph, so citations resolve against real note nodes via the
   *  SAME detector brain-health uses. Absent ⇒ citation check skipped. */
  graph?: HealthGraph | null
  /** DoD observation (dod-seed.ts): tracks the output covered — checked against the
   *  covers-active-tracks criterion seeded at task start. Absent ⇒ that check skips. */
  coveredTracks?: string[] | null
  /** DoD observation: claims in the output with no supporting note (orphan set). */
  orphanClaims?: string[] | null
}

export interface VerifyGateOptions {
  /** Max tolerated identity-axis regression (points) before a write is deemed
   *  corrupting. Small: a genuine corruption (a duplicate entity, an orphaned
   *  spine bridge, a prompt-echo leak) drops coherence/purity sharply, while
   *  ordinary noise stays under it. Default 2. */
  regressionTolerance?: number
}

export type CheckState = 'pass' | 'fail' | 'skip'

export interface VerifyDecision {
  /** true ⇒ commit→done may proceed. false ⇒ a check FAILED (proven-bad output);
   *  the caller must NOT mark the item done. A gate where every check `skip`s
   *  still passes (nothing was proven bad). */
  pass: boolean
  /** Human reasons for a block, for the journal / escalation. Empty when pass. */
  failures: string[]
  checks: {
    memoryNonCorrupting: CheckState
    citationsGrounded: CheckState
  }
  /** Cited notes that did NOT resolve to a real note node (the hallucinated set). */
  danglingCitations: string[]
}

const DEFAULT_TOLERANCE = 2

/** Build the real-note lookup from a graph, reusing brain-health's `isNoteNode`
 *  so the gate's notion of "a real note" is identical to the health scorer's.
 *  Indexes both full ids and basenames (the spine bridge resolves either). */
function realNoteIndex(graph: HealthGraph): { ids: Set<string>; basenames: Set<string> } {
  const ids = new Set<string>()
  const basenames = new Set<string>()
  for (const n of graph.nodes) {
    if (!isNoteNode(n)) continue
    ids.add(n.id)
    basenames.add(n.id.slice(n.id.lastIndexOf('/') + 1))
  }
  return { ids, basenames }
}

/** A citation resolves iff it matches a real note id exactly, or its basename
 *  matches a real note basename — the same match `scoreCoherence.resolvesNote`
 *  uses for the entity→note spine bridge. `normLabel` folds punctuation/case so
 *  "Foo.md", "foo.md", and "《Foo》.md" agree, matching the health scorer's dedup. */
function citationResolves(
  cite: string,
  idx: { ids: Set<string>; basenames: Set<string> }
): boolean {
  if (!cite || !cite.trim()) return false
  if (idx.ids.has(cite)) return true
  const base = cite.slice(cite.lastIndexOf('/') + 1)
  if (idx.basenames.has(base)) return true
  // punctuation/case-insensitive basename fold (brain-health's normLabel)
  const nb = normLabel(base)
  for (const b of idx.basenames) if (normLabel(b) === nb) return true
  return false
}

/**
 * Judge one turn's BRAIN verify receipt. PURE. See the file header for the
 * fail-safe-open / fail-closed contract.
 */
export function verifyBeforeCommit(
  receipt: VerifyReceipt,
  opts: VerifyGateOptions = {}
): VerifyDecision {
  const tol = Number.isFinite(opts.regressionTolerance as number)
    ? (opts.regressionTolerance as number)
    : DEFAULT_TOLERANCE
  const failures: string[] = []

  // ── Check 1: memory-write non-corrupting (coherence + purity, reused axes) ──
  let memoryNonCorrupting: CheckState = 'skip'
  const axisDrops: { axis: string; before: number; after: number }[] = []
  const considerAxis = (axis: string, before?: number | null, after?: number | null): void => {
    if (typeof before !== 'number' || typeof after !== 'number') return
    if (!Number.isFinite(before) || !Number.isFinite(after)) return
    memoryNonCorrupting = memoryNonCorrupting === 'fail' ? 'fail' : 'pass'
    if (before - after > tol) {
      memoryNonCorrupting = 'fail'
      axisDrops.push({ axis, before, after })
    }
  }
  considerAxis('coherence', receipt.coherenceBefore, receipt.coherenceAfter)
  considerAxis('purity', receipt.purityBefore, receipt.purityAfter)
  for (const d of axisDrops) {
    failures.push(
      `memory write corrupted the store: ${d.axis} ${d.before.toFixed(1)}→${d.after.toFixed(
        1
      )} (>${tol} drop)`
    )
  }

  // ── Check 2: digest cites real notes (reuse isNoteNode resolution) ──
  let citationsGrounded: CheckState = 'skip'
  const danglingCitations: string[] = []
  const cited = (receipt.citedNotes ?? []).filter((c) => typeof c === 'string' && c.trim())
  if (cited.length > 0 && receipt.graph && receipt.graph.nodes) {
    const idx = realNoteIndex(receipt.graph)
    for (const c of cited) if (!citationResolves(c, idx)) danglingCitations.push(c)
    citationsGrounded = danglingCitations.length === 0 ? 'pass' : 'fail'
    if (danglingCitations.length > 0) {
      failures.push(
        `digest cites ${danglingCitations.length} note(s) that do not exist in the brain graph: ${danglingCitations
          .slice(0, 5)
          .join(', ')}`
      )
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    checks: { memoryNonCorrupting, citationsGrounded },
    danglingCitations
  }
}

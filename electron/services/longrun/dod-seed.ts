// dod-seed.ts — Long-run VERIFICATION layer, the SEED half of the per-task
// falsifiable contract (AHE / steal-list #5). Its companion is verify-gate.ts,
// the CHECK half: dod-seed states, AT TASK START, what "done" must mean for a
// background brain-task; verify-gate (plus evaluateDoD here) confirms it AT COMMIT.
//
// This is a SECOND-BRAIN definition-of-done, NOT a code feature-list. A background
// brain-task (an EOD digest, a consolidation pass, a track roll-up) is "done" only
// when its output is faithful to the operator's brain. The two acceptance criteria
// are PROBES OVER THE BRAIN, seeded from live state at task start so the check is
// against what was actually true when the work began:
//
//   1. COVERS-ACTIVE-TRACKS — a covering task (a digest/summary) must touch every
//      active track (workstream) in the operator's brain. A digest that silently
//      drops a track is a false "done" — the operator trusts a covering artifact to
//      be exhaustive. Seeded with the track list captured at start (not re-derived
//      at commit, when a track could have gone quiet and hidden the omission).
//   2. NO-ORPHAN-CLAIMS — no claim in the output may lack a supporting note. This is
//      the same grounding invariant verify-gate enforces on citations, promoted to a
//      seeded acceptance criterion so a non-covering task still carries it.
//
// PURE: no I/O, no clock, no DB. The controller injects the live active-track list
// via a seedDoD seam at task start; the observations (which tracks the output
// covered, which claims were orphaned) arrive in the verify receipt at commit.

export type CriterionKind = 'covers-active-tracks' | 'no-orphan-claims'

export interface AcceptanceCriterion {
  kind: CriterionKind
  /** covers-active-tracks: the tracks the output MUST cover (captured at start). */
  requiredTracks?: string[]
  /** Human-readable statement of the criterion, for the journal / escalation. */
  describe: string
}

export interface DefinitionOfDone {
  acceptanceCriteria: AcceptanceCriterion[]
  /** The active-track snapshot the DoD was seeded from (provenance). */
  seededFromTracks: string[]
}

export interface DoDSeedInput {
  /** The task instruction (unused for scoring today; kept for future criteria). */
  instruction?: string
  /** Active tracks in the operator's brain AT TASK START (the coverage universe). */
  activeTracks: string[]
  /** True when this task produces a COVERING artifact (digest/summary/roll-up), so
   *  the covers-active-tracks criterion applies. A point-task (fix one item) does
   *  not get a coverage criterion — only the no-orphan-claims invariant. */
  expectsCoverage?: boolean
}

/** Normalize a track label for set-membership (trim + case-fold), so "Alpha" and
 *  "Alpha " and "ALPHA" compare equal — the same forgiving fold the brain uses. */
function normTrack(s: string): string {
  return (s ?? '').trim().toLowerCase()
}

/**
 * Seed the definition-of-done for a background brain-task from live brain state.
 * PURE. Always seeds no-orphan-claims; adds covers-active-tracks only for a
 * covering task with a non-empty track snapshot.
 */
export function seedDefinitionOfDone(input: DoDSeedInput): DefinitionOfDone {
  const tracks = (input.activeTracks ?? []).filter((t) => typeof t === 'string' && t.trim())
  const criteria: AcceptanceCriterion[] = []

  if (input.expectsCoverage && tracks.length > 0) {
    criteria.push({
      kind: 'covers-active-tracks',
      requiredTracks: tracks.slice(),
      describe: `output must cover all ${tracks.length} active track(s): ${tracks.join(', ')}`
    })
  }
  criteria.push({
    kind: 'no-orphan-claims',
    describe: 'no claim in the output may lack a supporting note'
  })

  return { acceptanceCriteria: criteria, seededFromTracks: tracks }
}

/** What the finished turn actually produced, gathered at commit (from the verify
 *  receipt). Absent fields ⇒ that criterion is unmeasurable ⇒ skipped. */
export interface DoDObservation {
  /** Tracks the output demonstrably covered. */
  coveredTracks?: string[] | null
  /** Claims in the output with no supporting note (the orphan set). */
  orphanClaims?: string[] | null
}

export type CriterionState = 'pass' | 'fail' | 'skip'

export interface DoDEvaluation {
  /** true ⇒ every measurable criterion passed (an all-skip DoD passes — nothing
   *  was proven unmet). false ⇒ a criterion FAILED; the caller must not mark done. */
  pass: boolean
  failures: string[]
  perCriterion: { kind: CriterionKind; state: CriterionState; detail?: string }[]
}

/**
 * Evaluate a seeded DoD against the turn's observations. PURE. Fail-safe-open on
 * absent evidence (a criterion whose observation is missing is `skip`, never a
 * block), fail-closed on a proven-unmet criterion — the same contract as the
 * verify-gate, so the two halves agree on when a task may self-attest done.
 */
export function evaluateDoD(dod: DefinitionOfDone, obs: DoDObservation): DoDEvaluation {
  const failures: string[] = []
  const perCriterion: DoDEvaluation['perCriterion'] = []

  for (const c of dod.acceptanceCriteria) {
    if (c.kind === 'covers-active-tracks') {
      const required = c.requiredTracks ?? []
      if (!obs.coveredTracks) {
        perCriterion.push({ kind: c.kind, state: 'skip' })
        continue
      }
      const covered = new Set(obs.coveredTracks.map(normTrack))
      const missing = required.filter((t) => !covered.has(normTrack(t)))
      if (missing.length > 0) {
        perCriterion.push({ kind: c.kind, state: 'fail', detail: missing.join(', ') })
        failures.push(
          `definition-of-done unmet: output missed ${missing.length} active track(s): ${missing.join(', ')}`
        )
      } else {
        perCriterion.push({ kind: c.kind, state: 'pass' })
      }
    } else if (c.kind === 'no-orphan-claims') {
      if (obs.orphanClaims == null) {
        perCriterion.push({ kind: c.kind, state: 'skip' })
        continue
      }
      if (obs.orphanClaims.length > 0) {
        perCriterion.push({
          kind: c.kind,
          state: 'fail',
          detail: obs.orphanClaims.slice(0, 5).join(', ')
        })
        failures.push(
          `definition-of-done unmet: ${obs.orphanClaims.length} orphan claim(s) with no supporting note`
        )
      } else {
        perCriterion.push({ kind: c.kind, state: 'pass' })
      }
    }
  }

  return { pass: failures.length === 0, failures, perCriterion }
}

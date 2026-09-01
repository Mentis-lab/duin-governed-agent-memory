// transfer-scaffold.ts — the one orchestrated, PER-VAULT first-run flow that
// stands up a clean, ISOLATED, seedable DUIN brain for a NEW operator.
//
// The pieces already existed but were never chained together:
//   • ensureBrainRoot(vaultDir)    — create .brain/{memory,skills,agents,hooks,state}
//   • scaffoldHarness(rawSrcDir…)  — raw notes → OKF pillar layout + foundation files (loss-safe)
//   • writeIdentityFiles(…)        — interview → ME.md/BRAIN.md (no-clobber)
//   • seedFromVault(vaultDir)      — warm the operator-fact store from DUIN/Rules + DUIN/Instincts
//   • markColdStarted(vaultDir)    — record the PER-VAULT cold-start marker
//
// This module is PURE ORCHESTRATION of those existing modules — it adds no new
// filesystem behavior of its own, only sequencing. Everything it calls is
// idempotent + no-clobber, and the per-vault marker makes the whole flow a true
// no-op on a second run (and on the CURRENT operator's boot, which must not be
// disrupted). Per-vault isolation is the whole point: a second operator's vault
// gets its own .brain/, its own foundation files, and its own cold-start marker,
// so it seeds independently of the first operator's install.

import { ensureBrainRoot } from './brain-root'
import { scaffoldHarness, type FoundationOutcome } from './scaffold-harness'
import { writeIdentityFiles } from './write-identity'
import { seedFromVault, hasColdStarted, markColdStarted } from './cold-start-seed'

export interface ScaffoldNewOperatorIdentity {
  /** ME.md body — who the new operator is. '' → skip (no fake identity). */
  meMd: string
  /** BRAIN.md body — the operating contract. */
  brainMd: string
  /** Overwrite an existing foundation file. Left unset, it defaults to true only when the
   *  scaffold VERIFIABLY placed its own stub at BOTH ME.md and BRAIN.md (so the real interview
   *  identity supersedes a stub, not the operator); false otherwise — including when the
   *  scaffold ran but refused or failed one of those writes. Never inferred from "the pass
   *  completed". */
  overwrite?: boolean
}

export interface ScaffoldNewOperatorOptions {
  /** Raw notes folder to OKF-scaffold INTO the vault. Omit to skip scaffolding
   *  (e.g. an empty/greenfield vault that only needs identity + seed). When it
   *  equals `vaultDir`, scaffoldHarness runs IN-PLACE. */
  rawSrcDir?: string
  /** Interview-generated identity to persist. Omit to skip. */
  identity?: ScaffoldNewOperatorIdentity
  /** Force the full flow even if this vault is already marked cold-started.
   *  Default false → a marked vault is a no-op (idempotent, non-disruptive). */
  force?: boolean
}

export interface ScaffoldNewOperatorResult {
  ok: boolean
  /** Foundation files (ME.md/BRAIN.md) actually written this call. */
  foundationWritten: string[]
  /** True when scaffoldHarness ran and reported ok (pillar layout built). */
  pillarsWritten: boolean
  /** Operator-facts seeded from the vault's Rules/Instincts cards. */
  seededFacts: number
  /** True when the per-vault cold-start marker was set (or already present). */
  marker: boolean
  /** True when the flow short-circuited because the vault was already set up. */
  alreadySetUp?: boolean
  error?: string
}

/**
 * Stand up a clean, isolated, seedable DUIN brain for `vaultDir`. Idempotent:
 * a vault already marked cold-started is a no-op (returns `alreadySetUp: true`)
 * unless `opts.force`. Every step is no-clobber, so even a forced re-run never
 * loses the operator's content.
 */
export async function scaffoldNewOperatorBrain(
  vaultDir: string,
  opts: ScaffoldNewOperatorOptions = {}
): Promise<ScaffoldNewOperatorResult> {
  const empty: ScaffoldNewOperatorResult = {
    ok: false,
    foundationWritten: [],
    pillarsWritten: false,
    seededFacts: 0,
    marker: false
  }
  const dir = typeof vaultDir === 'string' ? vaultDir.trim() : ''
  if (!dir) return { ...empty, error: 'vaultDir is required' }

  try {
    // Idempotency gate: a vault already cold-started is a no-op. This is what
    // keeps the CURRENT operator's boot from re-running the (LLM-backed) scaffold
    // and keeps a second run cheap + non-disruptive.
    if (!opts.force && hasColdStarted(dir)) {
      return { ...empty, ok: true, marker: true, alreadySetUp: true }
    }

    // 1. Durable .brain/ root — created first so every later step has its home
    //    (state/ for the marker, memory/ for grounding, …). Idempotent.
    ensureBrainRoot(dir)

    // 2. OKF pillar layout + stub foundation files from the raw notes (optional).
    //    Loss-safe (read→write→verify→delete) and idempotent (already-filed notes
    //    are left in place). Degrades to heuristics with no model configured.
    let pillarsWritten = false
    let foundation: Record<string, FoundationOutcome> = {}
    if (opts.rawSrcDir && opts.rawSrcDir.trim()) {
      const scaffolded = await scaffoldHarness(opts.rawSrcDir.trim(), dir)
      pillarsWritten = scaffolded.ok
      foundation = scaffolded.foundation ?? {}
    }

    // 3. Interview identity (optional). By default it SUPERSEDES the scaffold's
    //    stub ME/BRAIN when the scaffold ran (else the stub would win); with no
    //    scaffold it stays no-clobber so a returning user's file is never stomped.
    //
    //    This used to infer `overwrite` from `pillarsWritten` — i.e. from scaffoldHarness's
    //    `ok`, which means "the scaffold PASS completed", NOT "a stub ME.md/BRAIN.md is now at
    //    the root and whatever was there before was preserved". Those come apart on the normal
    //    path: the scaffold can refuse a foundation write (prior content unpreservable) or have
    //    one fail, and still return ok — at which point this inferred `overwrite: true` and
    //    switched OFF write-identity's no-clobber guard over the operator's untouched, un-backed-up
    //    hand-written file. TOTAL failure was handled (ok:false ⇒ no overwrite); PARTIAL was not,
    //    and partial is the case that fires on a successful run.
    //
    //    So ask the question that actually licenses an overwrite, per file: did the scaffold
    //    genuinely put ITS content at that path (leaving any operator content preserved+ledgered)?
    //    Only 'written'/'altered' say yes. 'skipped' — or a name the scaffold never reported —
    //    means the operator's own bytes may still be sitting there, and we must not stomp them.
    const foundationWritten: string[] = []
    if (opts.identity) {
      const scaffoldOwns = (name: string): boolean =>
        foundation[name] === 'written' || foundation[name] === 'altered'
      const overwrite =
        typeof opts.identity.overwrite === 'boolean'
          ? opts.identity.overwrite
          : // Conservative AND: writeIdentityFiles takes one flag for both files, so a mixed
            // outcome falls back to no-clobber. Losing a stub-supersede is recoverable; losing
            // the operator's identity is not.
            scaffoldOwns('ME.md') && scaffoldOwns('BRAIN.md')
      const wrote = writeIdentityFiles({
        notesDir: dir,
        meMd: opts.identity.meMd,
        brainMd: opts.identity.brainMd,
        overwrite
      })
      foundationWritten.push(...wrote.wrote)
    }

    // 4. Seed the operator-fact store from THIS vault's Rules/Instincts cards so
    //    the govern/verify metabolism has fuel on day one. Deduped (idempotent).
    const seeded = seedFromVault(dir)

    // 5. Record the PER-VAULT cold-start marker so a later boot / re-run is a
    //    no-op for this vault (independent of any other operator's install).
    const marker = markColdStarted(dir, {
      added: seeded.added,
      provisional: seeded.provisional,
      read: seeded.read
    })

    return {
      ok: true,
      foundationWritten,
      pillarsWritten,
      seededFacts: seeded.added,
      marker
    }
  } catch (err) {
    return { ...empty, error: (err as Error)?.message ?? 'scaffoldNewOperatorBrain failed' }
  }
}

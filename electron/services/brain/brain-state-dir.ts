// brain-state-dir.ts — the ONE canonical resolver for the brain's on-disk state directory.
//
// Every engine derives its state path from a vault dir (settings.localBrainNotesDir). The brain-dir
// segment (`.duin`) had been hardcoded per call-site across ~66 files with no fallback — so if the
// vault ever pointed at a non-DUIN vault (e.g. a legacy vault whose state lives under `.claude`), every read
// would silently resolve an EMPTY `.duin/_state` instead of erroring. That is the cohesion Axis-2
// "grounding fragility." This module centralizes the segment AND provides a boot-time guard that
// makes the misconfiguration LOUD instead of silent. New code should call brainStateDir() rather
// than re-hardcoding the `.duin`/`_state` segment.
import { existsSync } from 'fs'
import { join } from 'path'

/** The canonical brain state dir for a vault — the single source of truth for the `.duin/_state` segment. */
export function brainStateDir(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state')
}

/**
 * Boot-time grounding guard. A DUIN vault keeps its brain state under `.duin`. If `vaultDir` is a
 * POPULATED legacy vault that lacks `.duin` but has a `.claude` (the legacy-shaped mismatch), the brain
 * would read empty native state forever — so surface it LOUDLY instead of failing silent. Returns a
 * warning string for the caller to log, or null when the vault is a proper DUIN vault, unset, or a
 * fresh/empty vault still being initialized (nothing to guard).
 */
export function checkBrainVault(vaultDir: string | null | undefined): string | null {
  if (!vaultDir || !existsSync(vaultDir)) return null      // unset / not yet created
  if (existsSync(join(vaultDir, '.duin'))) return null      // proper DUIN vault → fine
  if (existsSync(join(vaultDir, '.claude'))) {              // legacy-shaped vault, no .duin → the trap
    return `[grounding] localBrainNotesDir "${vaultDir}" has a legacy .claude but no .duin state dir — ` +
      'the brain will read EMPTY native state. Point it at a DUIN vault (.duin) or migrate state into .duin.'
  }
  return null                                               // fresh/empty vault being initialized
}

// Onboarding IPC — the write path for the A1 cold-start flow. The renderer generates
// ME.md + BRAIN.md from the first-run interview (src/lib/brain-identity.ts) and calls
// brain:writeIdentity to persist them to the vault root, where brain-root.ts loadBrain
// reads them into every chat turn. Kept in its own module (not settings.ts) so it stays
// clear of the engine session's in-flight route work in that file.

import { BrowserWindow, ipcMain } from 'electron'
import { realpathSync } from 'fs'
import { readSettings } from '../services/settings-helper'
import { writeIdentityFiles, writeFoundationFile, FOUNDATION_BASENAMES } from '../services/brain/write-identity'
import { invalidateAgentsMd } from '../services/agents-md-loader'
import { scaffoldNewOperatorBrain } from '../services/brain/transfer-scaffold'
import { scaffoldOkf, type OkfInterviewAnswers } from '../services/brain/okf-scaffold'
import { reindex } from '../services/local-brain/index-store'
import { hasTrustedDirectoryGrant } from '../services/trusted-path-grants'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// (d26f783 aftermath: this module's `persistNotesDir` and `reindexAndBuild` helpers
// were the deleted `brain:loadDemoVault` handler's private plumbing — dead since the
// demo brain was removed, deleted here. The live folder-pick path persists the dir via
// settings:set and reindexes via localBrain:reindex, both in settings.ts.)

function requireTrustedVaultDir(value: unknown): string {
  const candidate = str(value).trim()
  if (!candidate) throw new Error('vaultDir is required')
  const resolved = realpathSync(candidate)
  const active = str(readSettings().localBrainNotesDir).trim()
  if (hasTrustedDirectoryGrant(resolved)) return resolved
  if (active) {
    try {
      if (realpathSync(active) === resolved) return resolved
    } catch { /* a stale active path is not a grant for another directory */ }
  }
  throw new Error('Brain folder must be the active vault or selected with the native folder picker')
}

function broadcastBrainUpdated(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('brain:updated', { count })
  }
}

/** Coerce an unknown IPC payload into interview answers (all optional strings). */
function toAnswers(v: unknown): OkfInterviewAnswers | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  return { working: str(o.working), deciding: str(o.deciding), worried: str(o.worried) }
}

export function registerOnboardingHandlers(): void {
  // #4a — one orchestrated PER-VAULT first-run flow for a NEW operator: stand up a
  // clean, isolated, seedable brain (ensureBrainRoot → scaffold → identity → seed →
  // per-vault marker). Idempotent + no-clobber; a set-up vault is a no-op.
  ipcMain.handle(
    'brain:scaffoldNewOperator',
    async (_event, vaultDir: unknown, opts?: unknown) => {
      try {
        const o = (opts && typeof opts === 'object' ? opts : {}) as {
          rawSrcDir?: unknown
          identity?: { meMd?: unknown; brainMd?: unknown; overwrite?: unknown }
          force?: unknown
        }
        const identity = o.identity && typeof o.identity === 'object'
          ? {
              meMd: str(o.identity.meMd),
              brainMd: str(o.identity.brainMd),
              // Preserve undefined when the caller didn't specify → let the
              // orchestrator pick its smart default (supersede stub after scaffold).
              ...(typeof o.identity.overwrite === 'boolean' ? { overwrite: o.identity.overwrite } : {})
            }
          : undefined
        const trustedVault = requireTrustedVaultDir(vaultDir)
        const rawSrcDir = str(o.rawSrcDir).trim()
        const res = await scaffoldNewOperatorBrain(trustedVault, {
          // Conditional SPREAD, not `key: cond ? value : undefined` — same shape the
          // `overwrite` line above uses. Semantically identical for an optional
          // property, and it makes the supply visible to unsupplied-input-lint, which
          // reads a key whose value can be `undefined` as never supplied and reported
          // `rawSrcDir` as a capability nothing can reach. It is reachable; the call
          // was just written in a shape the checker cannot see through.
          ...(rawSrcDir ? { rawSrcDir: requireTrustedVaultDir(rawSrcDir) } : {}),
          identity,
          force: o.force === true
        })
        return { success: res.ok, data: res, error: res.error }
      } catch (err) {
        return { success: false, error: (err as Error)?.message ?? 'scaffoldNewOperator failed' }
      }
    }
  )
  // Write the interview-generated foundation files to `notesDir`. No-clobber unless
  // overwrite === true. Returns which files were written vs skipped-because-present.
  ipcMain.handle(
    'brain:writeIdentity',
    async (_event, notesDir: unknown, meMd: unknown, brainMd: unknown, overwrite?: unknown) => {
      try {
        const res = writeIdentityFiles({
          notesDir: requireTrustedVaultDir(notesDir),
          meMd: str(meMd),
          brainMd: str(brainMd),
          overwrite: overwrite === true
        })
        return {
          success: res.ok,
          data: { wrote: res.wrote, skipped: res.skipped },
          error: res.error
        }
      } catch (err) {
        return { success: false, error: (err as Error)?.message ?? 'writeIdentity failed' }
      }
    }
  )

  // Foundations pane: edit the vault-root foundation files (ME.md / BRAIN.md /
  // GOALS.md) directly from Settings. Path-scoped to a fixed basename whitelist at
  // the vault root; snapshots prior bytes to .trash and REFUSES the write if that
  // snapshot fails (writeFoundationFile owns the security spine — the vault root is
  // resolved HERE, main-side, never accepted from the renderer). On success:
  //   - invalidateAgentsMd() so a BRAIN.md edit clears the 5s <agents_md> cache and
  //     takes effect on the very next turn (ME/BRAIN are re-read fresh by loadBrain
  //     anyway; GOALS is NOT in the identity/grounding block).
  //   - for GOALS.md ONLY, fire a best-effort reindex so the graph re-parses the
  //     Strategic Tracks (it's consumed structurally on graph build, not per turn).
  //   - broadcast brain:updated so live Brain views re-fetch.
  ipcMain.handle('brain:writeFoundationFile', async (_event, name: unknown, body: unknown) => {
    try {
      const fileName = str(name)
      if (typeof body !== 'string') return { success: false, error: 'body must be a string' }
      // Belt-and-suspenders whitelist at the boundary; writeFoundationFile enforces it too.
      if (!FOUNDATION_BASENAMES.has(fileName)) {
        return { success: false, error: 'not a foundation file' }
      }
      const vault = str(readSettings().localBrainNotesDir)
      if (!vault) {
        return { success: false, error: 'No brain folder set (Settings → Brain).' }
      }
      const res = writeFoundationFile(vault, fileName, body)
      if (!res.ok) return { success: false, error: res.error }

      invalidateAgentsMd()
      if (fileName === 'GOALS.md') {
        // Fire-and-forget: GOALS tracks re-parse on graph build, not per turn. Never blocks the save.
        void reindex(vault).catch(() => {})
      }
      broadcastBrainUpdated(0)
      return {
        success: true,
        data: {
          name: fileName,
          wrote: res.wrote,
          ...(res.replacedTrashRel ? { replacedTrashRel: res.replacedTrashRel } : {})
        }
      }
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? 'writeFoundationFile failed' }
    }
  })

  // Seed the OKF substrate for a (fresh or existing) vault — foundation concepts
  // + typed pillar `_about` concepts + optional interview answers materialized as
  // typed project/decision/risk concepts + the machine-owned `_concept-index.md`.
  // Idempotent + no-clobber. The renderer calls this on folder-pick so a brand-new
  // user's first-run graph renders the typed concept skeleton, not a blank canvas.
  // After writing, reindex is fired best-effort so the substrate is picked up live
  // (the notes-watcher ignores dotfolders — see DUIN_MEMORY_OKF_DESIGN §2.5.4).
  ipcMain.handle(
    'brain:scaffoldOkf',
    async (_event, vaultDir: unknown, answers?: unknown, overwrite?: unknown, reindexAfter?: unknown) => {
      try {
        const trustedVault = requireTrustedVaultDir(vaultDir)
        const res = scaffoldOkf({
          vaultDir: trustedVault,
          answers: toAnswers(answers),
          overwrite: overwrite === true
        })
        if (res.ok && reindexAfter !== false) {
          // Fire-and-forget: make the fresh concepts retrievable without waiting on
          // the next full reindex. Never blocks the scaffold result.
          void reindex(trustedVault).catch(() => {})
        }
        return {
          success: res.ok,
          data: {
            conceptsWritten: res.conceptsWritten,
            conceptsIndexed: res.conceptsIndexed,
            indexPath: res.indexPath,
            wrote: res.wrote,
            skipped: res.skipped,
            // Where any REPLACED prior content was preserved (`.trash` paths relative to the
            // vault). Dropping this made a correctly snapshotted file unrecoverable in
            // practice — the copy exists but no caller is ever told where it went.
            replaced: res.replaced ?? {}
          },
          error: res.error
        }
      } catch (err) {
        return { success: false, error: (err as Error)?.message ?? 'scaffoldOkf failed' }
      }
    }
  )

}

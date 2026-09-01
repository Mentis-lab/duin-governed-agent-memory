import { app, BrowserWindow } from 'electron'
import { realpathSync } from 'fs'
import { join } from 'path'
import { runExtractionAndBuild, resetExtractionBreaker } from './brain'
import {
  exportBrainTablesToVault,
  reloadBrainTablesFromVault,
  type BrainTablesReloadResult
} from './brain/brain-db-durability'
import { DEFAULT_APP_SETTINGS } from './default-app-settings'
import { recordEvent } from './event-log'
import { setActiveDenylist } from './governance/confidential-firewall'
import { invalidateBrainGraphCache } from './local-brain/brain-graph-cache'
import { reindex, reindexUntilReady } from './local-brain/index-store'
import { restartNotesWatcher } from './local-brain/notes-watcher'
import {
  recordSwitchOutcome,
  switchMoatVault,
  type MoatVaultSwitchResult
} from './moat-durability'
import { readSettingsFile, writeSettingsFile } from './settings-file'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

function readSettings(): Record<string, unknown> {
  return { ...DEFAULT_APP_SETTINGS, ...readSettingsFile(settingsPath()).data }
}

function broadcastBrainUpdated(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('brain:updated', { count })
  }
}

export function schedulePostIndexBuild(count: number): void {
  void (async () => {
    try {
      // runExtractionAndBuild is single-flight across ALL triggers (the onboarding folder pick
      // fires settings:set AND the renderer's explicit reindex back-to-back — running the LLM
      // pipeline twice concurrently was the exact race the old two-call sequence reintroduced),
      // and it sequences extraction THEN construction internally.
      const result = await runExtractionAndBuild()
      if (result.status === 'built') {
        broadcastBrainUpdated(count)
      } else if (result.status === 'kept-cache') {
        console.warn('[brain] auto build kept the existing cache (a clobber guard refused to overwrite it)')
      } else if (result.status === 'model-error') {
        console.warn('[brain] auto build failed — AI provider rejected the request (check balance/quota)')
      } else {
        console.warn('[brain] auto build returned status:', result.status)
      }
    } catch (error) {
      console.warn('[brain] auto reindex+build failed:', (error as Error)?.message)
    }
  })()
}

export async function reindexAndBuild(dir: string): Promise<number> {
  // Reindex is operator-shaped (explicit click or a settings change) — close the
  // extraction breaker so the LLM pass gets a fresh chance.
  resetExtractionBreaker('operator reindex')
  const count = await reindex(dir)
  restartNotesWatcher(dir || null)
  broadcastBrainUpdated(count)
  schedulePostIndexBuild(count)
  return count
}

let mutationQueue: Promise<unknown> = Promise.resolve()

export function enqueueBrainVaultMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = mutationQueue.then(operation, operation)
  mutationQueue = queued.then(() => undefined, () => undefined)
  return queued
}

export type VaultDurabilityTransferResult =
  | {
      ok: true
      moat: Extract<MoatVaultSwitchResult, { ok: true }>
      tables: Extract<BrainTablesReloadResult, { ok: true }>
    }
  | {
      ok: false
      stage: 'input' | 'moat' | 'brain-tables'
      reason: string
      moat?: MoatVaultSwitchResult
      tables?: BrainTablesReloadResult
      moatRollback?: MoatVaultSwitchResult
    }

function durabilityFailureReason(result: MoatVaultSwitchResult | BrainTablesReloadResult): string {
  if (result.ok) return ''
  if ('error' in result) return result.error
  return result.reason
}

export function transferVaultDurability(
  beforeDir: string,
  afterDir: string
): VaultDurabilityTransferResult {
  if (!afterDir) return { ok: false, stage: 'input', reason: 'A target vault is required' }
  const userDataDir = app.getPath('userData')
  const flushTarget = beforeDir || afterDir
  exportBrainTablesToVault(userDataDir, flushTarget)
  const moat = switchMoatVault(userDataDir, beforeDir || null, afterDir)
  if (!moat.ok) {
    // `retained` proves no destructive step ran. A generic failure may have
    // happened after the origin moved, so make a bounded attempt to restore it.
    const moatRollback =
      moat.outcome === 'failed' && beforeDir && !moat.restored
        ? switchMoatVault(userDataDir, afterDir, beforeDir)
        : undefined
    if (moat.outcome === 'failed' && !moat.restored && (!moatRollback || !moatRollback.ok)) {
      recordSwitchOutcome(userDataDir, {
        scope: 'brain-vault-adoption',
        outcome: 'pending',
        from: beforeDir || null,
        to: afterDir,
        failedStage: 'moat',
        reason: durabilityFailureReason(moat),
        moatRollback: moatRollback ?? 'no prior vault'
      })
    }
    return {
      ok: false,
      stage: 'moat',
      reason: durabilityFailureReason(moat),
      moat,
      moatRollback
    }
  }
  const tables = reloadBrainTablesFromVault(afterDir, {
    userDataDir,
    flushedTo: flushTarget,
    from: beforeDir || null
  })
  if (tables.ok) return { ok: true, moat, tables }

  // The table reload is transactional and retains the prior rows on failure.
  // Reverse the already-completed moat move when a prior vault exists. First
  // adoption has no prior durable home to restore; journal that recoverable
  // pending state so the next picker attempt can finish it without data loss.
  const moatRollback = beforeDir
    ? switchMoatVault(userDataDir, afterDir, beforeDir)
    : undefined
  if (!beforeDir || !moatRollback?.ok) {
    recordSwitchOutcome(userDataDir, {
      scope: 'brain-vault-adoption',
      outcome: 'pending',
      from: beforeDir || null,
      to: afterDir,
      failedStage: 'brain-tables',
      reason: durabilityFailureReason(tables),
      moatRollback: moatRollback ?? 'no prior vault'
    })
  }
  return {
    ok: false,
    stage: 'brain-tables',
    reason: durabilityFailureReason(tables),
    moat,
    tables,
    moatRollback
  }
}

/** Reset every process-local cache whose meaning is scoped to one vault. */
export function invalidateVaultScopedCaches(): void {
  setActiveDenylist(null)
  invalidateBrainGraphCache()
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== typeof b || typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function emitSettingsUpdated(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  partial: Record<string, unknown>
): void {
  try {
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !shallowEqual(before[key], after[key]))
    if (!changedKeys.length) return
    recordEvent({
      type: 'settings.updated',
      actorKind: 'user',
      payload: {
        changedKeys,
        sensitiveChanged: changedKeys.filter((key) => key === 'apiKey'),
        partialKeys: Object.keys(partial)
      }
    })
  } catch (error) {
    console.error('[settings] settings.updated event failed:', error)
  }
}

export async function commitReadyBrainVault(
  safePartial: Record<string, unknown>,
  current: Record<string, unknown>,
  allowReplace: boolean
): Promise<{ success: true; data: { indexedCount: number; indexStatus: 'ready' } }> {
  const updated = { ...current, ...safePartial }
  const beforeDir = typeof current.localBrainNotesDir === 'string' ? current.localBrainNotesDir : ''
  const afterDir = typeof updated.localBrainNotesDir === 'string' ? updated.localBrainNotesDir : ''
  const vaultChanged = afterDir !== beforeDir
  if (!afterDir) throw new Error('A brain folder is required before indexing')
  if (vaultChanged && beforeDir && !allowReplace) {
    throw new Error('First-run setup cannot replace an active brain folder; use Brain settings')
  }

  let count: number
  let durability: VaultDurabilityTransferResult | null = null
  try {
    count = await reindexUntilReady(afterDir)
    if (vaultChanged) {
      durability = transferVaultDurability(beforeDir, afterDir)
      if (!durability.ok) {
        throw new Error(`Vault durability ${durability.stage} failed: ${durability.reason}`)
      }
      // A cache from another vault is a confidentiality and provenance boundary.
      // Invalidate before the new setting can become visible to any renderer.
      invalidateVaultScopedCaches()
    }
    restartNotesWatcher(afterDir)
    const onDisk = readSettingsFile(settingsPath()).data
    writeSettingsFile(settingsPath(), { ...onDisk, ...safePartial })
  } catch (error) {
    const rollbackErrors: string[] = []
    if (vaultChanged && durability?.ok) {
      if (beforeDir) {
        const reversed = transferVaultDurability(afterDir, beforeDir)
        if (!reversed.ok) rollbackErrors.push(`durability rollback failed: ${reversed.reason}`)
      } else {
        recordSwitchOutcome(app.getPath('userData'), {
          scope: 'brain-vault-adoption',
          outcome: 'pending',
          from: null,
          to: afterDir,
          failedStage: 'settings-publish',
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    try {
      await reindexUntilReady(beforeDir)
    } catch (rollbackError) {
      rollbackErrors.push(
        `index rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    try {
      restartNotesWatcher(beforeDir || null)
      if (vaultChanged) invalidateVaultScopedCaches()
    } catch (rollbackError) {
      rollbackErrors.push(
        `runtime rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(rollbackErrors.length ? `${message}; ${rollbackErrors.join('; ')}` : message, {
      cause: error
    })
  }

  emitSettingsUpdated(current, updated, safePartial)
  try {
    broadcastBrainUpdated(count)
    schedulePostIndexBuild(count)
  } catch (error) {
    // Settings and every required plane are already committed. A notification
    // failure must not turn a successful adoption into a false failure response.
    console.warn('[brain] post-adoption notification failed:', (error as Error)?.message)
  }
  return { success: true, data: { indexedCount: count, indexStatus: 'ready' } }
}

// (adoptManagedBrainVault was deleted 2026-08-25 with its only caller, the demo-vault
// handler: the demo brain is gone, and any future managed adoption goes through
// enqueueBrainVaultMutation + commitReadyBrainVault directly, which stay the API.)

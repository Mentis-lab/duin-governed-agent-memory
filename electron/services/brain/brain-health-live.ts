// Live loader for the Brain Health benchmark — the side-effectful wrapper that
// gathers deps from the running app's stores and feeds the PURE computeBrainHealth.
// Kept separate (mirrors capability-gap-live.ts) so brain-health.ts stays
// import-clean (no better-sqlite3 / no Electron), unit-testable, and runnable
// outside Electron.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { getResolvedConstruction } from './construct'
import { entityResolverEnabled, resolveEntityIdentity } from './entity-resolver'
import type { ConstructedData } from './types'
import { buildBrainGraph } from './brain-graph-native'
import { readGraphNative } from './graph-native'
import { brainRootPath, BRAIN_STATE_DIR } from './brain-root'
import { brainAssetsDir } from '../brain-paths'
import { indexedCount, allChunks, collectNoteFiles } from '../local-brain/index-store'
import { messageOf } from '../guarded'
import {
  computeBrainHealth,
  type BrainHealthDeps,
  type BrainHealthReport,
  type HealthGraph,
  type HealthEntity
} from './brain-health'

/** Read the construction cache's builtAt (best-effort; null when unavailable). */
function readConstructionBuiltAt(vault: string | null): string | null {
  const root = brainRootPath(vault)
  const candidates = [
    root ? join(root, BRAIN_STATE_DIR, 'brain-construction.json') : null
  ].filter((p): p is string => !!p)
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { builtAt?: string }
      if (raw.builtAt) return raw.builtAt
    } catch (e) {
      console.debug('[brain-health-live] no construction cache builtAt:', messageOf(e))
    }
  }
  return null
}

/** Jaccard of the current entity-id set vs the newest `.duin/_backups/construction.*`
 *  snapshot. Best-effort id-stability probe; null when no backup / on any failure.
 *  Both sides run through the SAME flag-gated resolver so the metric measures the
 *  resolver's INTENDED effect: canonical ids are churn-stable, so resolving both the
 *  current + backup snapshots should RAISE Jaccard (the fix, not an artifact). */
function idStabilityJaccard(vault: string | null, currentIds: Set<string>): number | null {
  if (!vault || currentIds.size === 0) return null
  try {
    const dir = join(vault, '.duin', '_backups')
    const bak = readdirSync(dir)
      .filter((f) => f.startsWith('construction.') && f.endsWith('.json'))
      .sort()
    if (bak.length === 0) return null
    const raw = JSON.parse(readFileSync(join(dir, bak[bak.length - 1]), 'utf-8')) as {
      data?: { entities?: { id: string; kind?: string; label?: string }[] }
      entities?: { id: string; kind?: string; label?: string }[]
    }
    const rawEnts = raw.data?.entities ?? raw.entities ?? []
    // Resolve the backup through the same resolver (label-keyed, so it needs labels;
    // a labelless legacy backup is a resolver no-op and compares raw, as before).
    const bakConstruction = {
      entities: rawEnts.map((e) => ({ id: e.id, kind: e.kind ?? 'topic', label: e.label ?? '', note: undefined })),
      edges: [],
      classifications: [],
      triples: []
    } as unknown as ConstructedData
    const ents = entityResolverEnabled()
      ? (resolveEntityIdentity(bakConstruction)?.entities ?? rawEnts)
      : rawEnts
    const prev = new Set(ents.map((e) => e.id))
    if (prev.size === 0) return null
    let inter = 0
    for (const id of currentIds) if (prev.has(id)) inter++
    const union = currentIds.size + prev.size - inter
    return union === 0 ? null : inter / union
  } catch (e) {
    console.debug('[brain-health-live] id-stability probe unavailable:', messageOf(e))
    return null
  }
}

/** Count forecast/calibration patterns that have fired (learning verdicts firing). */
function countLearningResolved(vault: string | null): number {
  if (!vault) return 0
  try {
    const raw = JSON.parse(
      readFileSync(join(vault, '.duin', '_state', 'forecast-track-record.json'), 'utf-8')
    ) as { patterns?: Record<string, { fired?: number; materialized?: number; averted?: number }> }
    const pats = raw.patterns ?? {}
    let active = 0
    for (const v of Object.values(pats)) {
      if (!v) continue
      if ((v.fired ?? 0) > 0 || (v.materialized ?? 0) + (v.averted ?? 0) > 0) active++
    }
    return active
  } catch (e) {
    console.debug('[brain-health-live] no forecast track record:', messageOf(e))
    return 0
  }
}

/** Adapt a BrainGraph ({nodes, links}) to the pure scorer's HealthGraph ({nodes, edges}). */
function toHealthGraph(bg: { nodes: Record<string, unknown>[]; links: { source: string; target: string; type?: string }[] }): HealthGraph {
  return {
    nodes: bg.nodes.map((n) => ({
      id: String(n.id),
      kind: typeof n.kind === 'string' ? n.kind : undefined,
      label: typeof n.label === 'string' ? n.label : undefined,
      layer: typeof n.layer === 'string' ? n.layer : undefined
    })),
    edges: bg.links.map((l) => ({ source: l.source, target: l.target, type: l.type }))
  }
}

/**
 * Gather deps from live state and compute the Brain Health report. Read-only w.r.t.
 * the vault; every source is best-effort (a missing store just contributes a
 * neutral/zero signal, never throws). `builtAt` is minted HERE (the one clock read),
 * so the pure core stays deterministic.
 */
export function computeBrainHealthLive(vault: string | null): BrainHealthReport {
  const builtAt = new Date().toISOString()

  // Assembled brain graph (product store + vault cloud). Injected prod store (SQLite ABI).
  const prod = readGraphNative(vault)
  const logoDir = join(brainAssetsDir(), 'web', 'public', 'project-logos')
  const bg = buildBrainGraph(vault, { prod, logoDir, now: new Date() })
  const graph = toHealthGraph(bg as unknown as { nodes: Record<string, unknown>[]; links: { source: string; target: string; type?: string }[] })

  // Construction cache (entities carry the `note` bridge; builtAt from the cache file).
  // Identity-spine P6: read the SHARED, memoized getResolvedConstruction() — the SAME accessor
  // mergedGraph/MAP/retrieval use — so the entity ids fed to the scorer share the graph's
  // canonical id space and the benchmark scores exactly the graph the user sees. Without this,
  // a resolved graph node (`project:ProjectA`) would fail to match its unresolved construction entity
  // (`project:projecta`) and scoreCoherence would UNDERCOUNT entity→note connectivity — making
  // the fix look like a regression. Byte-identical passthrough under DUIN_ENTITY_RESOLVER=0.
  const constructed = getResolvedConstruction()
  const entities: HealthEntity[] = (constructed?.entities ?? []).map((e) => ({
    id: e.id,
    kind: e.kind,
    label: e.label,
    note: e.note
  }))
  const construction = constructed
    ? { entities, builtAt: readConstructionBuiltAt(vault) }
    : null

  // Index stats: distinct indexed note files, distinct chunk-FILES (pollution signal),
  // real note files on disk.
  const indexedNoteFiles = indexedCount()
  let indexedChunkFiles = 0
  try {
    indexedChunkFiles = new Set(allChunks().map((c) => c.file)).size
  } catch (e) {
    console.debug('[brain-health-live] chunk store unavailable:', messageOf(e))
  }
  let vaultNoteFiles = 0
  try {
    vaultNoteFiles = vault ? collectNoteFiles(vault).length : 0
  } catch (e) {
    console.debug('[brain-health-live] vault walk unavailable:', messageOf(e))
  }

  const deps: BrainHealthDeps = {
    builtAt,
    graph,
    construction,
    index: { indexedNoteFiles, indexedChunkFiles, vaultNoteFiles },
    liveness: {
      storeGraphLive: Array.isArray(prod.nodes) && prod.nodes.length > 0,
      learningResolved: countLearningResolved(vault)
    },
    entityVecs: null, // deterministic default (no embedder); dedup folds by normalized label
    idStabilityJaccard: idStabilityJaccard(vault, new Set(entities.map((e) => e.id))),
    seeds: null
  }

  return computeBrainHealth(deps)
}

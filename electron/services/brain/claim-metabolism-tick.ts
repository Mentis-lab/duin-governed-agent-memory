// claim-metabolism-tick.ts — periodic LIVE metabolism pass, so the world-state-gated verdict
// engine advances on a CLOCK (a decision resolving → its claim going stale) even if nobody hits
// /state/claim-metabolism. Cloned from calibration-tick.ts. runLiveMetabolism is idempotent +
// best-effort, so a tick over an already-judged (or empty) ledger is a cheap no-op.
//
// GATED by DUIN_CLAIM_METABOLISM_LIVE, now DEFAULT ON (live-validated): the tick runs every 15 min
// and PERSISTS deterministic ledger retirements (which then feed read-side recall demotion). Set
// DUIN_CLAIM_METABOLISM_LIVE=0 to disable — then start/stop are no-ops with zero background work,
// and the metabolism is compute-only (inspectable via the shadow route, no persist).
import { runLiveMetabolism, claimMetabolismLive } from './claim-extract'
import { entityGraphEnabled, writeTimeRelink, syncGraphFromConstruction } from './entity-graph-relink'
import { reapplyNodeTombstones } from './node-tombstones'
import { getResolvedConstruction, invalidateResolvedConstruction } from './construct'
import { runWhenIdle } from '../idle-scheduler'

// 15 min matches the app's existing loop-tick cadence; world-state signals are day-grained so
// sub-hour granularity is ample. Override via DUIN_CLAIM_METABOLISM_TICK_MS; 0 disables.
const TICK_MS = (() => {
  const raw = Number(process.env.DUIN_CLAIM_METABOLISM_TICK_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60_000
})()
const INITIAL_MS = 45_000 // let boot settle (after the calibration tick's 30s) before the first pass

let timer: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null

/** Metabolize+persist once for the current vault. Best-effort: never throws — a bad vault dir or
 *  IO error must not crash the tick. Exposed for tests. */
export function claimMetabolismTick(getVaultDir: () => string | null): void {
  let dir: string | null
  try {
    dir = getVaultDir()
  } catch {
    return // a throwing settings read must not crash the tick
  }
  if (!dir) return
  // Fire-and-forget: runLiveMetabolism is async (semantic entity resolution embeds subjects). The
  // tick must not block; a failed pass is non-fatal.
  const pass = runLiveMetabolism(dir).catch((e) => {
    console.warn('[claim-metabolism-tick] pass failed (non-fatal):', (e as Error)?.message)
  })
  // Foundation 3 (persistent entity graph). After the metabolism persists, mirror the ledger's
  // neighbour evolution into the store (write-time relink) and fold any newly-whitelisted aliases
  // (shadow-sync). GATED behind DUIN_ENTITY_GRAPH, which is `!== '0'` — DEFAULT ON, opt-out
  // (entity-graph-relink.ts:52). Set DUIN_ENTITY_GRAPH=0 and this whole block is skipped and the
  // tick is byte-identical. Best-effort — a store error never affects the metabolism
  // (which already persisted above) nor the tick.
  if (entityGraphEnabled()) {
    void pass.then(() => {
      try {
        writeTimeRelink(dir)
      } catch (e) {
        console.warn('[claim-metabolism-tick] relink failed (non-fatal):', (e as Error)?.message)
      }
      try {
        const sync = syncGraphFromConstruction(getResolvedConstruction())
        // Duplicate detection fires PER NEW BRAIN NODE, not on a clock. A new entity node is
        // exactly when a duplicate can come into existence; running the clusterer when the
        // sync created nothing is pure cost (it embeds every distinct label). Gating on
        // `created` also makes the work self-limiting: a settled vault does no clustering at
        // all, and a burst of new entities gets exactly one pass.
        if (sync.created.length > 0) {
          void runEntityAutoMergeOnNewNodes(dir, sync.created.length)
        }
      } catch (e) {
        console.warn('[claim-metabolism-tick] graph-sync failed (non-fatal):', (e as Error)?.message)
      }
      try {
        // LAST, on purpose: the relink and the construction sync above both upsert
        // nodes, so this is the point at which an operator deletion could have been
        // resurrected. Re-applying here is also what keeps the tombstone ledger from
        // being a write-only file.
        reapplyNodeTombstones(dir)
      } catch (e) {
        console.warn(
          '[claim-metabolism-tick] tombstone reapply failed (non-fatal):',
          (e as Error)?.message
        )
      }
    })
  }
}

/** Run duplicate detection + auto-merge because the sync introduced new entity nodes.
 *
 *  Everything heavy is loaded lazily so the tick's static import chain does not pull the
 *  embedder or the local-brain index store. Fully best-effort: this is an optimisation of the
 *  graph's cleanliness, never something that may take down the metabolism tick.
 *
 *  DYNAMIC `import()`, NOT `require()`. A bare `require('./entity-automerge-tick')` is copied
 *  VERBATIM into the single-file `out/main/index.js`, where that path does not exist — nothing
 *  statically imports these modules, so Rollup never emits them. Every call threw
 *  MODULE_NOT_FOUND straight into the catch below and logged one debug line, so this pass has
 *  never run in ANY packaged build: measured 2026-08-04, all 14 groups in the live
 *  entity-aliases.json lack the `source:'auto'` stamp this tick writes. `import()` keeps the
 *  laziness AND puts the module in the graph, so Rollup emits it as a chunk.
 *  Same failure and same fix as `require('./plugin-loader')` in skill-loader.ts and
 *  `require('../event-log')` in act/external-action.ts. */
async function runEntityAutoMergeOnNewNodes(dir: string | null, createdCount: number): Promise<void> {
  if (!dir) return
  try {
    // CROSS-KIND COLLAPSE RUNS FIRST, and the order is the point. Both passes append to the same
    // `entity-aliases.json`. This one is exact and deterministic (the SAME normalized label found
    // under several kinds), needs no embedder, and is not subject to the cosine clusterer's
    // 1,500-label cap — so it can settle the canonical ids across the whole census before the
    // containment-spine pass runs. The automerge then sees an already-collapsed census and cannot
    // propose a group that fights one this pass established.
    //
    // Cheap enough to run every time: one pass over the entity list, no IO beyond the whitelist
    // read/write, and idempotent — a label already in the whitelist is skipped, so a second run
    // writes nothing.
    const { runKindCollapseTick } = await import('./entity-kind-collapse-tick')
    const collapse = runKindCollapseTick(dir, getResolvedConstruction())
    if (collapse.merged > 0) {
      console.log(
        `[entity-kind-collapse] collapsed ${collapse.merged} cross-kind label(s) ` +
          `(${collapse.groups.slice(0, 3).map((g) => `${g.canonical}→${g.canonicalId}`).join(', ')}` +
          `${collapse.groups.length > 3 ? ', …' : ''})`
      )
      // The resolved-construction memo is keyed on the construction object, NOT the whitelist, so
      // freshly written groups would otherwise have no effect until the next rebuild (up to 24h).
      invalidateResolvedConstruction()
    }

    const { computeAliasCandidatesReport } = await import('./entity-resolver')
    const { embedForRecall } = await import('../local-brain/index-store')
    const { runEntityAutoMergeTick } = await import('./entity-automerge-tick')

    const report = await computeAliasCandidatesReport(getResolvedConstruction(), embedForRecall)
    const res = runEntityAutoMergeTick(dir, report)
    if (res.merged > 0) {
      console.log(
        `[entity-automerge] ${createdCount} new node(s) → merged ${res.merged} duplicate group(s) ` +
          `of ${res.proposed} proposed` +
          (Object.keys(res.refused).length
            ? ` (refused: ${Object.entries(res.refused).map(([k, n]) => `${k}×${n}`).join(', ')})`
            : '')
      )
    }
  } catch (e) {
    console.warn('[entity-automerge] pass failed (non-fatal):', (e as Error)?.message)
  }
}

/** Start the periodic metabolism: one settle-delayed pass, then every TICK_MS. No-op if already
 *  running, the tick is disabled (TICK_MS=0), or LIVE persistence is off (default).
 *
 *  IDLE-GATED (2026-08-21): the pass was MEASURED at ~4s on the live vault
 *  (PLANNING/DUIN_PERF_LAUNCH_HANDOFF.md:69 — "4223ms cold / 4034ms warm"), and its
 *  synchronous bulk runs on the main thread, so an on-the-clock tick froze every
 *  window's input for seconds — the "app hitches when I open a page" report, when
 *  the open landed on a tick. Each tick now waits for 30s of operator idle before
 *  running, forced through after 10 min so ledger freshness stays bounded (world-
 *  state signals are day-grained; a sub-15-min extra delay is noise). The direct
 *  claimMetabolismTick export stays un-gated for tests and manual invocation. */
export function startClaimMetabolismTick(getVaultDir: () => string | null): void {
  if (timer || TICK_MS === 0 || !claimMetabolismLive()) return
  const gated = (): void =>
    runWhenIdle('claim-metabolism', () => claimMetabolismTick(getVaultDir), {
      idleMs: 30_000,
      maxDelayMs: 10 * 60_000
    })
  initial = setTimeout(gated, INITIAL_MS)
  timer = setInterval(gated, TICK_MS)
}

export function stopClaimMetabolismTick(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

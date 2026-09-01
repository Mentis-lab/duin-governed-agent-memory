// Live notes-folder watcher — keeps the brain (and the Brain graph UI) in sync
// when the user edits notes in their chosen folder, with no manual "Reindex".
// A debounced chokidar watcher re-indexes on add/change/unlink, runs the
// key-gated temporal extraction, and broadcasts `brain:updated` so every Brain
// view refetches. Re-pointed at boot and whenever the folder setting changes.

import { BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { reindex, isIngestable } from './index-store'
import { bumpVaultVersion } from '../brain/vault-version'
import { refreshNotesExtraction, buildBrain } from '../brain'
import {
  mayRunAutomaticWork,
  noteMaterialChange,
  consumeMaterialChanges,
  type GateVerdict
} from '../background-work-gate'
import { automaticCloudWorkAllowed } from '../brain/cloud-consent'

/** The gate every AUTOMATIC token-spending pass in this file asks. Two questions, in order:
 *  (1) may DUIN send vault content to a cloud model on its own at all — release M11, answered by
 *  brain/cloud-consent.ts (consent recorded at key save, or backgroundAutonomy, or a local model);
 *  (2) is the operator present and has content moved — background-work-gate.ts. Declines are
 *  logged by the caller, never swallowed. */
function automaticPassGate(): GateVerdict | { ok: false; reason: 'no-cloud-consent'; detail?: string } {
  const consent = automaticCloudWorkAllowed()
  if (!consent.ok) return { ok: false, reason: 'no-cloud-consent', detail: consent.detail }
  return mayRunAutomaticWork()
}
import { refreshChannelForesight } from '../brain/channel-foresight-live'
import { constructionBuiltAtMs } from '../brain/construct'
import { noteAccumulationTick, resetAccumulator } from '../brain/notes-liveness-monitor'
import { envNum } from '../../shared/env-number'

let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 1500

// Construction auto-refresh — keep the LLM entity/edge layer (getConstruction, what
// graph-expand traverses) in sync as notes change. FAR heavier than a reindex (a full
// key-gated LLM pass over the vault, ~minutes), so it runs on its OWN long debounce, a
// minimum gap between builds, an in-flight guard, and a dirty flag — a burst of edits
// coalesces into at most one rebuild per gap. buildBrain is key-gated (no-ops without a
// model). Tunable: DUIN_CONSTRUCT_DEBOUNCE_MS (quiet window), DUIN_CONSTRUCT_MIN_GAP_MS.
let constructTimer: ReturnType<typeof setTimeout> | null = null
let constructing = false
let constructDirty = false
/** Did OPERATOR content change since the last construction? Machine-state writes (DUIN's own
 *  `.brain`/`.duin` files) are indexed but must not arm the LLM pass — see isMachineStatePath. */
let contentChangedSinceBuild = false
let firstDirtyAt = 0
let lastConstructAt = 0
// 0 is MEANINGFUL on all three: it means 'no quiet window / no gap / no ceiling', which is how a
// test or a tight-loop operator forces an immediate rebuild. `|| default` made 0 unreachable.
const CONSTRUCT_DEBOUNCE_MS = envNum('DUIN_CONSTRUCT_DEBOUNCE_MS', 5 * 60_000, { min: 0 })
const CONSTRUCT_MIN_GAP_MS = envNum('DUIN_CONSTRUCT_MIN_GAP_MS', 20 * 60_000, { min: 0 })
const CONSTRUCT_MAX_WAIT_MS = envNum('DUIN_CONSTRUCT_MAX_WAIT_MS', 15 * 60_000, { min: 0 })

/** Mark the construction layer dirty and (re)arm a debounced, throttled rebuild. Debounced
 *  (waits CONSTRUCT_DEBOUNCE_MS of quiet) but with a MAX-WAIT ceiling so a steady drip of
 *  edits can't defer the rebuild forever — the delay shrinks toward 0 as we approach
 *  CONSTRUCT_MAX_WAIT_MS since the first pending change. The build itself also honors
 *  CONSTRUCT_MIN_GAP_MS since the last build. Safe to call on every change. */
export function scheduleConstructionRefresh(): void {
  constructDirty = true
  if (!firstDirtyAt) firstDirtyAt = Date.now()
  const delay = Math.max(0, Math.min(CONSTRUCT_DEBOUNCE_MS, CONSTRUCT_MAX_WAIT_MS - (Date.now() - firstDirtyAt)))
  if (constructTimer) clearTimeout(constructTimer)
  constructTimer = setTimeout(runConstructionRefresh, delay)
  console.log(`[notes-watcher] construction refresh scheduled in ${Math.round(delay / 1000)}s`)
}

function runConstructionRefresh(): void {
  constructTimer = null
  if (constructing || !constructDirty) return
  const sinceLast = Date.now() - lastConstructAt
  if (lastConstructAt > 0 && sinceLast < CONSTRUCT_MIN_GAP_MS) {
    // Too soon after the last build — defer to when the gap elapses; further edits keep
    // constructDirty set so the deferred run still picks them up.
    const wait = CONSTRUCT_MIN_GAP_MS - sinceLast
    console.log(`[notes-watcher] construction refresh deferred ${Math.round(wait / 1000)}s (min-gap)`)
    constructTimer = setTimeout(runConstructionRefresh, wait)
    return
  }
  constructing = true
  constructDirty = false // clear BEFORE the await — edits during the build re-dirty it
  firstDirtyAt = 0
  console.log('[notes-watcher] construction refresh: rebuilding…')
  void buildBrain()
    .then((r) => {
      lastConstructAt = Date.now()
      // The entity/edge construction layer is now fresh → invalidate the graph cache (liveGraph merges it).
      bumpVaultVersion()
      console.log(`[notes-watcher] construction auto-refresh: ${r.entities} entities, ${r.edges} edges (${r.status})`)
      if (r.status === 'built') broadcast(0)
    })
    .catch((err) => console.warn('[notes-watcher] construction refresh failed:', (err as Error).message))
    .finally(() => {
      constructing = false
      // Edits landed during the build → re-arm so they aren't lost.
      if (constructDirty && !constructTimer) constructTimer = setTimeout(runConstructionRefresh, CONSTRUCT_DEBOUNCE_MS)
    })
}

function broadcast(count: number): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('brain:updated', { count })
  }
}

/** Only note files matter; everything else (and dotfiles / node_modules) is
 *  ignored. Directories (no extension) pass so chokidar can descend. */
export function shouldIgnore(p: string, stats?: { isDirectory(): boolean }): boolean {
  // Ignore only the dirs the indexer skips — NOT every dotfolder (the indexer still descends
  // into other dot-folders as content). Agent/tool config trees (.claude/.codex/.agents/
  // .cursor/.github) are skipped by the indexer since release M11 (index-store AGENT_CONFIG_DIRS)
  // and are ignored here for parity, so an edit under them never arms a reindex or an LLM pass.
  if (/(^|[\\/])(node_modules|\.git|\.obsidian|\.trash|\.smart-env|\.claude|\.codex|\.agents|\.cursor|\.github)([\\/]|$)/.test(p)) return true
  // chokidar hands us stats when it has them; they settle file-vs-directory outright. Never
  // ignore a directory here — every `_`-dir / dotted-name exemption below depends on chokidar
  // being allowed to descend first.
  if (stats?.isDirectory()) return false
  // Machine-scaffolding exclusion (identity-spine P5, "machine files only"): scaffolding is
  // a note whose BASENAME starts with `_` (handled below). `DUIN/Meta/` design cards are REAL
  // knowledge — KEPT (indexed + retrievable), so there is NO DUIN/Meta subtree exclusion here.
  // Without stats, the name is all we have. An extension is alphanumeric and unspaced: the old
  // `\.[^.\\/]+$` read a vault folder like `01. Inbox` as a file with extension `. Inbox`, so it
  // was ignored and chokidar never descended — every note under it stopped re-indexing on edit.
  const hasExt = /\.[A-Za-z0-9]{1,10}$/.test(p)
  // `_`-prefixed machine FILES (indexes, logs, metrics, dashboards, prototypes, seeds)
  // are scaffolding — ignore them. Scoped to the FILE basename (requires an extension) so
  // chokidar still DESCENDS into `_`-prefixed content DIRS (ProjectA/…/_原始转录, …/_ocr) whose
  // real notes have normal file names and must keep re-indexing on edit.
  if (hasExt) {
    const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
    if (base.startsWith('_')) return true
  }
  // Item 7: live-watch a SUPERSET — the original text/html surfaces PLUS everything the indexer
  // ingests (pdf/docx/office/iwork AND .json, all via isIngestable), so a saved/edited doc the
  // indexer would index reindexes immediately instead of waiting for the next full pass.
  // (isIngestable omits .html/.htm — those route through a separate html loader in loadDocument —
  // so they stay explicit here.) A non-ingestable extension (.png, .exe, binaries) is ignored. The
  // app's own state dirs (.duin/.brain) are excluded by the dir guard above, so ledger writes there
  // never churn — but a .json in the notes tree itself IS content the indexer ingests, so it's watched.
  return hasExt && !(isIngestable(p) || /\.(md|markdown|txt|html|htm)$/i.test(p))
}

/** Debounced reindex — shared by the fs watcher AND callers that just mutated a
 *  vault file (write_file/edit_file/…) so a same-turn search doesn't miss what
 *  the model just wrote while it waits for the fs event. Coalesces via the shared
 *  debounce so a burst of writes triggers one reindex. Non-blocking. NOTE: this
 *  narrows but doesn't eliminate the window — a truly-immediate same-instant read
 *  would need a targeted single-file upsert, which index-store doesn't expose. */
export function scheduleReindex(dir: string | null | undefined, changedPath?: string): void {
  if (!dir) return
  // A change to operator CONTENT is what can arm the expensive LLM passes; a change to DUIN's
  // own state never is. Unknown callers (no path) count as content — the old behavior, so an
  // in-app write still refreshes comprehension.
  if (!changedPath || !isMachineStatePath(changedPath)) {
    contentChangedSinceBuild = true
    noteMaterialChange({ path: changedPath ?? '(unknown)', kind: 'updated' })
  }
  // Invalidate the grounding caches (liveWholeNotes reads the vault dir directly) the instant a note
  // mutates — before the debounced reindex even runs — so a same-turn read sees the change.
  bumpVaultVersion()
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    void reindex(dir)
      .then((count) => {
        // The chunk index is now fresh → invalidate the graph cache (deriveGraph reads the index).
        bumpVaultVersion()
        broadcast(count)
        // Event-triggered liveness watchdog: accumulate ingested notes and, every N
        // (default 10), assert the construction/metabolism loops actually advanced on
        // this fresh input. Fires on ingest — the one signal that keeps ticking while a
        // downstream loop is frozen — so a 2-day construction stall gets caught instead
        // of staying silent. Fully guarded + non-blocking (see notes-liveness-monitor).
        noteAccumulationTick(dir, count)
        // Temporal extraction is an LLM pass, so it obeys the same rule as construction: it
        // runs for operator content while the operator is here, not on DUIN's own writes and
        // not while they are away — and, on a cloud model, only with consent (release M11).
        // Indexing above already happened either way.
        const gate = automaticPassGate()
        if (!gate.ok) {
          console.log(`[notes-watcher] skipping notes extraction — ${gate.reason} (${gate.detail})`)
          return false
        }
        return refreshNotesExtraction()
      })
      .then((enriched) => {
        if (enriched) broadcast(0)
        refreshComprehensionTail(dir)
      })
      .catch((err) => console.warn('[notes-watcher] reindex failed:', (err as Error).message))
  }, DEBOUNCE_MS)
}

/** The construction + foresight half of comprehension, given content is already
 *  in the chunk index. Split out so the connector path can reach it — see
 *  `refreshComprehension`. */
function refreshComprehensionTail(dir: string): void {
  // Keep the LLM entity/edge layer fresh, on its own long debounce + min-gap
  // throttle so it never rebuilds per-save — and ONLY when operator content actually moved.
  // Without this gate DUIN's own memory materialization re-armed the trigger it had just
  // fired, so construction ran forever on an idle vault (see isMachineStatePath).
  const gate = automaticPassGate()
  if (gate.ok && contentChangedSinceBuild) {
    contentChangedSinceBuild = false
    consumeMaterialChanges()
    scheduleConstructionRefresh()
  } else {
    const why = gate.ok ? 'only machine state changed' : `${gate.reason} (${gate.detail})`
    console.log(`[notes-watcher] skipping construction refresh — ${why}`)
  }
  // Keep the channel→foresight bridge fresh on the same ingest signal so
  // connected-channel docs re-derive live anchors/futures. Best-effort with its
  // own catch: a foresight failure must never break the caller.
  void refreshChannelForesight(dir).catch((e) =>
    console.warn('[notes-watcher] channel foresight refresh failed:', (e as Error).message)
  )
}

/**
 * Run the comprehension passes for content that is ALREADY in the chunk index.
 *
 * Indexing and comprehension are two different things, and until now only one
 * caller knew that. `scheduleReindex` ran the LLM extraction, construction
 * refresh and channel-foresight bridge in its own tail — so those fired on a
 * chokidar vault-file event and nowhere else. Connector sync writes chunks
 * directly via `ingestFromSource` and never touched them, which meant **LLM
 * comprehension of channel data only happened when the operator edited a
 * markdown file.** A user with one connected channel and no notes has nothing to
 * edit, so nothing ever ran — breaking the cold-start case the product strategy
 * calls the on-ramp.
 *
 * Deliberately NOT a reindex: the connector path has already written its chunks,
 * so rescanning the vault would be pure cost. What it needs is the half that
 * turns chunks into entities, edges and forecasts.
 *
 * One owner for "what happens after new content lands", called from both the
 * watcher and the connector sync, so the two cannot drift apart again.
 */
export async function refreshComprehension(dir: string | null | undefined): Promise<void> {
  if (!dir) return
  // New chunks landed → invalidate the graph cache (deriveGraph reads the index).
  bumpVaultVersion()
  // Release M11: a connector sync is automatic work too. Deliberately NOT presence-gated (its
  // author kept the on-ramp case — one connected channel, no notes to edit — alive), but on a
  // cloud model it needs the same consent every other unattended pass needs.
  const consent = automaticCloudWorkAllowed()
  if (!consent.ok) {
    console.log(`[notes-watcher] skipping connector comprehension — ${consent.reason} (${consent.detail})`)
    return
  }
  try {
    const enriched = await refreshNotesExtraction()
    if (enriched) broadcast(0)
  } catch (e) {
    console.warn('[notes-watcher] notes extraction refresh failed:', (e as Error).message)
  }
  refreshComprehensionTail(dir)
}

/** How stale the typed-extraction layer may get before a rebuild is forced.
 *  NOT the `Number(env) || default` idiom used elsewhere in this file: here 0 is the
 *  documented kill switch, and it is falsy, so that idiom would silently resurrect the
 *  24h default and make the off switch a no-op. */
const CONSTRUCTION_FLOOR_HOURS = ((): number => {
  const raw = process.env.DUIN_CONSTRUCTION_FLOOR_HOURS
  if (raw === undefined || raw.trim() === '') return 24
  const n = Number(raw)
  return Number.isFinite(n) ? n : 24
})()
/** How often to check. Cheap — one file read, and it spends nothing on its own: the rebuild it
 *  may ask for is gated on operator presence. It polls far more often than the floor PERIOD
 *  because presence is a short window (hours) while the old 6h cadence could sail straight past
 *  every session the operator had — a floor that can only fire if a 6-hourly tick happens to
 *  land inside a 2h window is a floor that mostly does not exist. `lastFloorAttemptAt` still
 *  holds actual rebuilds to at most one per floor period. */
const CONSTRUCTION_FLOOR_CHECK_MS = 15 * 60_000
let floorTimer: ReturnType<typeof setInterval> | null = null
let floorSettleTimer: ReturnType<typeof setTimeout> | null = null
/** When the floor last *asked* for a rebuild — which is not the same as one landing. */
let lastFloorAttemptAt = 0

/**
 * A periodic FLOOR under construction, because it is otherwise purely edit-driven.
 *
 * The only producer of a rebuild is `scheduleReindex`'s tail, which fires on a
 * chokidar vault-file event. Measured 2026-07-30: the cache was **10 days old** —
 * not because the extractor was broken (models answered 10,999 times that day) but
 * because nothing had edited a vault file, so nothing ever scheduled a rebuild.
 *
 * One missing clock explained three symptoms at once: a stalled construction, a
 * frozen Brain Health (it fires only after a construction rebuild), and a graph
 * whose 63% `entity`-kind share could not decay, because typed kinds arrive from
 * construction and nowhere else. Constitution property 7 — a mechanism that does
 * not run is worth less than a crude one that does.
 *
 * Deliberately conservative. It only *schedules*, so the existing debounce and the
 * 20-minute min-gap still apply, and a rebuild costs real LLM calls (up to
 * MAX_BATCHES windows over the vault) — hence a 24h floor checked every 6h rather
 * than anything eager. `DUIN_CONSTRUCTION_FLOOR_HOURS=0` disables it.
 */
export function startConstructionFloor(getDir: () => string | null): void {
  if (floorTimer || CONSTRUCTION_FLOOR_HOURS <= 0) return
  const check = (): void => {
    try {
      if (!getDir()) return
      const builtAt = constructionBuiltAtMs()
      const ageHours = builtAt === null ? Infinity : (Date.now() - builtAt) / 3_600_000
      if (ageHours < CONSTRUCTION_FLOOR_HOURS) return
      // Age is NOT proof the last attempt failed to happen. `constructBrain` has three
      // clobber guards that decline to persist and return the SAME `{entities: 0,
      // status: 'built'}` shape as a real build, so a construction that keeps refusing
      // to overwrite a good cache leaves `builtAt` frozen. Gating on age alone would
      // then re-fire a full-vault LLM pass every CHECK — every 6h, indefinitely.
      // Measured 2026-07-30: a forced rebuild against a 247h-old cache returned exactly
      // that, so this is the live behavior and not a hypothetical. Attempt at most once
      // per floor period; a genuinely successful build advances builtAt and the age
      // check gates the next one on its own.
      const sinceAttempt = Date.now() - lastFloorAttemptAt
      if (lastFloorAttemptAt > 0 && sinceAttempt < CONSTRUCTION_FLOOR_HOURS * 3_600_000) return
      lastFloorAttemptAt = Date.now()
      // The floor is a wall-clock trigger, which is exactly what the operator rule excludes:
      // "it should not run unless the app is being used and knowledge is being updated." An
      // idle vault does not become stale in any way that matters, and rebuilding it anyway is
      // how a machine burns an operator's money to keep a number fresh that nobody read.
      // Release M11: and never on a cloud model without consent.
      const floorGate = automaticPassGate()
      if (!floorGate.ok) {
        console.log(
          `[notes-watcher] construction floor reached but skipping — ${floorGate.reason} (${floorGate.detail})`
        )
        return
      }
      console.log(
        `[notes-watcher] construction is ${
          Number.isFinite(ageHours) ? `${Math.round(ageHours)}h` : 'never built'
        } old (floor ${CONSTRUCTION_FLOOR_HOURS}h) — forcing a rebuild`
      )
      scheduleConstructionRefresh()
    } catch (e) {
      console.warn('[notes-watcher] construction floor check failed:', (e as Error).message)
    }
  }
  // First check after boot settles, so it never competes with startup work. Tracked,
  // not fire-and-forget: a shutdown inside that window must cancel it too, or `stop`
  // still lets one rebuild fire at a process that is on its way out.
  floorSettleTimer = setTimeout(() => {
    floorSettleTimer = null // fired — drop the handle so `stop` isn't clearing a dead timer
    check()
  }, 3 * 60_000)
  floorTimer = setInterval(check, CONSTRUCTION_FLOOR_CHECK_MS)
}

export function stopConstructionFloor(): void {
  if (floorSettleTimer) {
    clearTimeout(floorSettleTimer)
    floorSettleTimer = null
  }
  if (floorTimer) {
    clearInterval(floorTimer)
    floorTimer = null
  }
  lastFloorAttemptAt = 0
}

/** True when a path is DUIN's OWN durable state rather than operator content.
 *
 *  These files ARE indexed on purpose (a promoted concept must be retrievable), but they are
 *  written BY the construction/promotion pipeline — so letting them arm the construction
 *  trigger closes a loop with no human in it: materialize memory -> watcher fires -> full LLM
 *  extraction -> materializes more memory -> repeat, every CONSTRUCT_MIN_GAP_MS, forever.
 *  Measured on the operator's live vault: 57 files rewritten under `.brain/memory/` in three
 *  days with the app otherwise idle, ~1,000-1,700 new entity nodes PER DAY, and a matching
 *  share of the extraction quota burn. (shouldIgnore's comment already asserted `.brain`/`.duin`
 *  "never churn" because of the dir guard above it — but that guard lists only node_modules,
 *  .git, .obsidian, .trash and .smart-env. The claim was true of the intent, not of the code.) */
export function isMachineStatePath(p: string): boolean {
  // Both separators: chokidar hands back native (backslash) paths on Windows, while in-app
  // callers and tests pass POSIX ones. Matching only `/` would make this a no-op on the one
  // platform the loop was measured on.
  return /(^|[\\/])\.(brain|duin)([\\/]|$)/.test(p)
}

/** (Re)start the watcher on `dir`. Pass null/empty to just stop. Idempotent. */
export function restartNotesWatcher(dir: string | null | undefined): void {
  stopNotesWatcher()
  if (!dir) return
  try {
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 12, ignored: shouldIgnore })
    const onChange = (changed: string): void => scheduleReindex(dir, changed)
    watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
    console.log('[notes-watcher] watching', dir)
  } catch (err) {
    console.warn('[notes-watcher] failed to watch', dir, (err as Error).message)
  }
}

export function stopNotesWatcher(): void {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  if (constructTimer) {
    clearTimeout(constructTimer)
    constructTimer = null
  }
  // A re-point (new vault) should be able to rebuild promptly rather than wait out the
  // old vault's min-gap; getConstruction's dirKey guard keeps stale results unserved.
  constructDirty = false
  contentChangedSinceBuild = false
  firstDirtyAt = 0
  lastConstructAt = 0
  // Drop the liveness accumulator so a new vault starts its note-count from zero.
  resetAccumulator()
}

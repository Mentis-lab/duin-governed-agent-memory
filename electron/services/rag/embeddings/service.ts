import { randomUUID } from 'crypto'
import { join } from 'path'
import {
  DEFAULT_EMBEDDER_ID,
  DEFAULT_RERANKER_ID,
  DEFAULT_NLI_ID,
  EMBEDDING_CATALOG,
  getEmbedder,
  getReranker,
  getNli,
  type EmbedderInfo
} from './catalog'
import { boundedJsonPreview, recordEvent } from '../../event-log'

// Main-thread façade over the embeddings worker. Owns the queue of pending
// embed requests, batching, and the active-embedder choice.
//
// Worker lifecycle:
//   - Lazy: the worker isn't spawned until the first `setActive` or
//     `embed` call so app startup pays no cost when RAG is unused.
//   - One model loaded at a time. `setActive(newId)` sends a `load`
//     message; subsequent embed calls use the new pipeline.
//   - `dispose()` terminates the worker — used at app shutdown and at the
//     periodic restart point (the plan calls for restart after N=10,000
//     embeddings to dodge any long-run memory growth in onnxruntime).
//
// Why expose the embed function only to main-process callers (not the
// renderer): a renderer with embed access could DoS the worker by spamming
// large batches. The ingest orchestrator (R5) is the only legitimate
// caller; the renderer asks for ingest progress, not raw embeddings.

export type WorkerLike = {
  postMessage(msg: unknown): void
  on(event: 'message', listener: (msg: WorkerOutboundMessage) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<number> | void
}

export interface WorkerFactory {
  (init: { userDataPath: string }): WorkerLike
}

type WorkerOutboundMessage =
  | { type: 'load:done'; id: string }
  | { type: 'embed:done'; id: string; vectors: Float32Array[] }
  | { type: 'rerank:done'; id: string; scores: number[] }
  | { type: 'nli:done'; id: string; scores: number[] }
  | { type: 'error'; id: string; message: string }

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

// Smaller batches → far less peak activation memory per ONNX forward pass. A
// 32-wide batch on a q8 model can spike hundreds of MB and is a leading trigger
// for a native OOM/segfault that takes the whole app down; 8 keeps the pass
// bounded at a small throughput cost (more, smaller messages).
const BATCH_SIZE = 8

// Bound the one-time model download/load. Transformers.js fetches weights from HF
// on first use with NO timeout of its own, so OFFLINE the worker's `load` never
// resolves — setActive() would hang forever (and callers that don't wrap it in a
// timeout, e.g. search()/embedForRecall(), hang with it). A bounded race turns an
// offline hang into a TYPED, friendly failure. Generous by default (a cold 118 MB
// e5 download over a slow link is legitimate); override via env for tight/CI runs.
const MODEL_LOAD_TIMEOUT_MS = Number(process.env.DUIN_MODEL_LOAD_TIMEOUT_MS) || 90_000 // signal-lint-ignore: 0 here means instant timeout (never 'no timeout'), i.e. the embedder could never load

/** Classification of a model download/load failure — the TYPED status the
 *  renderer turns into a friendly, actionable message (offline vs. broken model). */
export interface DownloadErrorInfo {
  kind: 'offline' | 'timeout' | 'unknown'
  /** True when the failure is (almost certainly) a missing network — the renderer
   *  should nudge "connect once, or connect an AI model instead". */
  offline: boolean
  /** Human-readable, already-friendly reason string. */
  reason: string
}

export class EmbeddingsService {
  private worker: WorkerLike | null = null
  private workerFactory: WorkerFactory
  private userDataPath: string
  private pending = new Map<string, Pending>()
  private activeEmbedderId: string = DEFAULT_EMBEDDER_ID
  private downloadEventEmittedFor = new Set<string>()
  // Which embedder is loaded IN THE CURRENT WORKER PROCESS (null = nothing loaded).
  // This is per-worker liveness, NOT a session-wide "we've seen this model" marker:
  // when the utilityProcess dies its `pipelineP` dies with it, so this must be
  // cleared on exit/error/dispose and re-established by a fresh `load`.
  // Why this needed its own field: embed()'s autoload guard used to key off
  // `downloadEventEmittedFor`, which is one-shot download-EVENT dedup — added once
  // and never cleared. After a worker crash the set was still non-empty, so embed()
  // skipped the autoload, posted to a freshly-forked worker with no pipeline, and
  // every embed failed for the rest of the session. The bug was invisible because
  // both flags read "true" on the happy path and only diverge after a crash.
  private loadedEmbedderId: string | null = null
  // Models whose download/load already failed THIS session (id → typed reason).
  // A doomed offline load costs a full timeout; without this every reindex batch
  // and every search would re-attempt + re-stall. Once failed, setActive() fails
  // FAST for that model so the app degrades to lexical/keyless search immediately,
  // until an explicit retry (probeModel / clearDownloadFailure) re-arms it.
  private downloadFailure = new Map<string, DownloadErrorInfo>()
  // Serializes (load -> embed batches) so ONE consumer's sequence is atomic.
  // Two consumers on different embedders share this worker, and both `embed`
  // and `setActive` are async: without the chain, consumer A could load model X,
  // yield at an await, let consumer B load model Y, then send A's batches to a
  // worker now holding Y. Same width, no error, silently wrong vectors -- the
  // exact failure vec-leg-embedder-guard exists to catch at query time.
  private chain: Promise<unknown> = Promise.resolve()

  constructor(userDataPath: string, workerFactory?: WorkerFactory) {
    this.userDataPath = userDataPath
    this.workerFactory =
      workerFactory ?? ((init) => spawnRealWorker(init.userDataPath))
  }

  /** Currently-selected embedder id (the one a future embed() call will use). */
  getActiveEmbedderId(): string {
    return this.activeEmbedderId
  }

  /**
   * Switch to a different embedder. On first use of a given model, the
   * underlying worker triggers a one-time HF download into the cache dir.
   * Transformers.js doesn't surface byte-level download progress easily;
   * v1 emits `started` + `completed` only.
   */
  async setActive(embedderId: string): Promise<EmbedderInfo> {
    const info = getEmbedder(embedderId)
    if (!info) {
      throw new Error(`setActive: unknown embedder "${embedderId}"`)
    }
    this.activeEmbedderId = embedderId
    return this.serialize(() => this.loadLocked(embedderId, info))
  }

  /** Run `fn` after every previously-queued unit of work, whatever its outcome. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** The body of setActive, assuming the serialization lock is already held. */
  private async loadLocked(embedderId: string, info: EmbedderInfo): Promise<EmbedderInfo> {
    // Fail FAST if this model's download already failed this session (see
    // downloadFailure). Re-attempting a doomed offline load would stall every
    // caller for the full timeout again; the prior typed reason is enough.
    const prior = this.downloadFailure.get(embedderId)
    if (prior) {
      throw makeModelDownloadError(info, prior)
    }
    await this.ensureWorker()
    const firstLoad = !this.downloadEventEmittedFor.has(embedderId)
    if (firstLoad) {
      this.emitModelEvent('rag.model.download.started', info)
    }
    try {
      await this.loadWithTimeout(info.modelRef)
      // A load succeeded → clear any stale failure flag (e.g. reconnected).
      this.downloadFailure.delete(embedderId)
      this.loadedEmbedderId = embedderId
      if (firstLoad) {
        this.downloadEventEmittedFor.add(embedderId)
        this.emitModelEvent('rag.model.download.completed', info)
      }
      return info
    } catch (err) {
      const cls = classifyDownloadError(err)
      this.downloadFailure.set(embedderId, cls)
      this.emitModelEvent('rag.model.download.failed', info, {
        kind: cls.kind,
        offline: cls.offline,
        reason: cls.reason,
        errorPreview: boundedJsonPreview((err as Error)?.message)
      })
      // Throw a TYPED error carrying the friendly reason. Every caller
      // (persistPending, search, embedForRecall) already catches embed/setActive
      // failures and degrades to text-only/lexical, so this never wedges the app.
      throw makeModelDownloadError(info, cls)
    }
  }

  /** Race the worker `load` against MODEL_LOAD_TIMEOUT_MS so an offline HANG (the
   *  HF fetch never resolves) surfaces as a bounded, catchable timeout instead of
   *  stalling forever. Clears the timer on the winning branch so it never leaks. */
  private async loadWithTimeout(modelRef: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.send({ type: 'load', modelRef }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`model download/load timed out after ${MODEL_LOAD_TIMEOUT_MS}ms`)),
            MODEL_LOAD_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Re-arm a model whose download failed so the next setActive retries it (used
   *  after the user reconnects / explicitly retries). No id → clear all. */
  clearDownloadFailure(embedderId?: string): void {
    if (embedderId) this.downloadFailure.delete(embedderId)
    else this.downloadFailure.clear()
  }

  /** The typed download-failure reason for a model, if its last attempt failed. */
  getDownloadFailure(embedderId: string): DownloadErrorInfo | undefined {
    return this.downloadFailure.get(embedderId)
  }

  /**
   * Embed an array of texts. Batches up to BATCH_SIZE per worker call so
   * the worker can run one forward pass per batch. Returns a Float32Array
   * per input text in the same order. An optional `signal` lets the
   * caller bail between batches if the underlying job (e.g. an ingest
   * round) was cancelled — the in-flight batch still runs to completion
   * because terminate-from-outside doesn't compose cleanly with the
   * worker_threads message queue.
   */
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (signal?.aborted) throw new Error('embed: aborted')
    // Read the active id NOW, not when the queued closure runs. setActive() assigns
    // this.activeEmbedderId synchronously and OUTSIDE the chain, so a picker change
    // that lands while this call is queued would otherwise retarget it — producing a
    // vector in the new space for a query the guard already cleared against the old
    // one. Exactly the cross-space hit the chain was added to prevent.
    const id = this.activeEmbedderId
    return this.serialize(() => this.embedLocked(id, texts, '', signal))
  }

  /**
   * Embed under a NAMED embedder without changing the active one.
   *
   * `setActive` is a USER-FACING choice (the Library's embedder picker writes it).
   * Consumers that need a specific embedding space were calling `setActive` to get
   * it, which meant every chat turn's memory recall reset the picker back to the
   * default -- the user's selection survived until the next turn and then silently
   * reverted, with no error and nothing in the UI to explain it. A consumer wants
   * "embed these in space S", not "make S everyone's default"; this says that.
   *
   * `kind` selects the model's instruction prefix (E5 needs `query: ` / `passage: `;
   * BGE has none). `'none'` embeds the text verbatim -- required when the caller's
   * stored vectors were themselves written without a prefix, because prefixing only
   * one side of the comparison is worse than prefixing neither.
   */
  async embedWith(
    embedderId: string,
    texts: string[],
    kind: 'query' | 'passage' | 'none',
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (signal?.aborted) throw new Error('embed: aborted')
    const info = getEmbedder(embedderId)
    if (!info) throw new Error(`embedWith: unknown embedder "${embedderId}"`)
    const prefix =
      kind === 'query' ? (info.queryPrefix ?? '') : kind === 'passage' ? (info.passagePrefix ?? '') : ''
    return this.serialize(() => this.embedLocked(info.id, texts, prefix, signal))
  }

  /** The batching core, assuming the serialization lock is already held. */
  private async embedLocked(
    embedderId: string,
    texts: string[],
    prefix: string,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    await this.ensureWorker()
    // Resolve BEFORE the cache-hit check. This used to live inside the
    // `loadedEmbedderId !== embedderId` branch, so an unknown id that happened to equal
    // the loaded one skipped validation entirely and shipped no modelRef.
    const info = getEmbedder(embedderId)
    if (!info) throw new Error(`embed: unknown embedder "${embedderId}"`)
    const modelRef = info.modelRef
    // Ensure the requested model is actually loaded — autoload it on first
    // embed so callers don't have to remember the setActive dance.
    if (this.loadedEmbedderId !== embedderId) {
      await this.loadLocked(embedderId, info)
    }
    const input = prefix ? texts.map((t) => prefix + t) : texts
    const out: Float32Array[] = []
    for (let i = 0; i < input.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new Error('embed: aborted')
      const batch = input.slice(i, i + BATCH_SIZE)
      const vectors = (await this.send({
        type: 'embed',
        texts: batch,
        // Name the model on the message itself. The worker can hold more than one
        // embedder resident, so "whatever is loaded" is no longer a safe reading — and
        // an absent modelRef makes the worker fall back to exactly that MRU guess.
        // resolved above, never `?.`: failing open here would embed in whichever of the
        // resident models was touched last, which is the cross-space write this whole
        // change exists to prevent and which no guard downstream can catch (three of
        // four catalogue embedders are 384-dim, so the vector inserts silently).
        modelRef
      })) as Float32Array[]
      out.push(...vectors)
    }
    return out
  }

  /**
   * Rerank `passages` against `query` with a cross-encoder, returning one 0..1
   * relevance score per passage (same order). Best-effort: on any worker/model
   * failure the caller (retrieve.ts) falls back to the pre-rerank order, so this
   * never becomes a hard dependency. Runs on the SAME worker as the embedder —
   * the reranker model is loaded lazily and independently on first use.
   */
  async rerank(query: string, passages: string[], rerankerId?: string): Promise<number[]> {
    if (passages.length === 0) return []
    const info = getReranker(rerankerId ?? DEFAULT_RERANKER_ID)
    if (!info) throw new Error(`rerank: unknown reranker "${rerankerId}"`)
    await this.ensureWorker()
    const scores = (await this.send({
      type: 'rerank',
      modelRef: info.modelRef,
      dtype: info.dtype,
      query,
      passages
    })) as number[]
    return scores
  }

  /**
   * Citation SUPPORT gate (L1): for each (premise, hypothesis) pair return
   * P(entailment) in [0,1], SAME order. premise = the cited passage text,
   * hypothesis = the citing claim — the pair is supported iff the premise
   * ENTAILS the hypothesis. Best-effort by construction: the gate caller
   * (retrieve-agent.ts) catches any worker/model failure and keeps today's
   * citations unchanged, so this never becomes a hard dependency. Runs on the
   * SAME worker as the embedder/reranker; the NLI model loads lazily +
   * independently on its own channel on first use.
   */
  async scoreEntailment(
    premises: string[],
    hypotheses: string[],
    nliId?: string
  ): Promise<number[]> {
    if (premises.length === 0) return []
    if (premises.length !== hypotheses.length) {
      throw new Error(
        `scoreEntailment: ${premises.length} premises vs ${hypotheses.length} hypotheses`
      )
    }
    const info = getNli(nliId ?? DEFAULT_NLI_ID)
    if (!info) throw new Error(`scoreEntailment: unknown nli model "${nliId}"`)
    await this.ensureWorker()
    const scores = (await this.send({
      type: 'nli',
      modelRef: info.modelRef,
      dtype: info.dtype,
      entailmentIndex: info.entailmentIndex,
      premises,
      hypotheses
    })) as number[]
    return scores
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'dispose' })
      } catch {
        // Worker may already be terminated.
      }
      const result = this.worker.terminate()
      if (result && typeof (result as Promise<number>).then === 'function') {
        await (result as Promise<number>)
      }
      this.worker = null
    }
    // Terminating drops the loaded pipeline too (dispose is also the periodic
    // restart point), so a post-dispose embed must re-load, not assume.
    this.loadedEmbedderId = null
    // Reject any still-pending sends; nothing will resolve them.
    for (const pending of this.pending.values()) {
      pending.reject(new Error('embeddings service disposed'))
    }
    this.pending.clear()
  }

  // ──────────────────── internals ────────────────────

  private async ensureWorker(): Promise<void> {
    if (this.worker) return
    this.worker = this.workerFactory({ userDataPath: this.userDataPath })
    this.worker.on('message', (msg) => this.handleWorkerMessage(msg))
    this.worker.on('error', (err) => {
      // A worker-level error fails every pending request — we have no way
      // to know which one was processing.
      for (const pending of this.pending.values()) {
        pending.reject(err)
      }
      this.pending.clear()
      // The pipeline's health is no longer knowable → force a reload before
      // the next embed rather than posting into a possibly-dead pipeline.
      this.loadedEmbedderId = null
    })
    this.worker.on('exit', (code) => {
      // The worker THREAD died (e.g. a heavy model load took it down). Fail
      // every pending request and drop the handle so the next call re-spawns
      // clean — and so a probe-driven switch can detect the death + revert.
      if (code === 0) return
      const err = new Error(`embeddings worker exited unexpectedly (code ${code})`)
      for (const pending of this.pending.values()) pending.reject(err)
      this.pending.clear()
      this.worker = null
      // The dead process took its pipeline with it; the re-spawn starts empty,
      // so the next embed MUST re-load rather than assume a live model.
      this.loadedEmbedderId = null
    })
  }

  /**
   * Probe a model BEFORE committing a switch: load it and run one tiny embed to
   * prove the worker survives, and to read the model's REAL output dimension
   * (not the catalogue's claim). On ANY failure — load error or worker death —
   * revert the active selection to what it was and return the error, so the
   * caller keeps the prior embedder. This is the guard that keeps a bad/heavy
   * model off the boot path: a switch proceeds only if this passes.
   */
  async probeModel(
    id: string
  ): Promise<{ ok: true; dims: number } | { ok: false; error: string }> {
    if (!getEmbedder(id)) return { ok: false, error: `unknown embedder "${id}"` }
    const prev = this.activeEmbedderId
    // A probe IS an explicit retry — clear any prior fail-fast flag so a model
    // that failed offline gets a real re-attempt (e.g. the user reconnected).
    this.downloadFailure.delete(id)
    try {
      await this.setActive(id)
      const [vec] = await this.embed(['ping'])
      if (!vec || vec.length === 0) throw new Error('probe produced an empty vector')
      return { ok: true, dims: vec.length }
    } catch (err) {
      this.activeEmbedderId = prev // keep the known-good embedder
      return { ok: false, error: (err as Error)?.message ?? String(err) }
    }
  }

  private handleWorkerMessage(msg: WorkerOutboundMessage): void {
    if (!msg || typeof msg !== 'object') return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    switch (msg.type) {
      case 'load:done':
        pending.resolve(undefined)
        break
      case 'embed:done':
        pending.resolve(msg.vectors)
        break
      case 'rerank:done':
        pending.resolve(msg.scores)
        break
      case 'nli:done':
        pending.resolve(msg.scores)
        break
      case 'error':
        pending.reject(new Error(msg.message))
        break
    }
  }

  private send(msg:
    | { type: 'load'; modelRef: string }
    | { type: 'embed'; texts: string[]; modelRef?: string }
    | { type: 'rerank'; modelRef: string; dtype: string; query: string; passages: string[] }
    | { type: 'nli'; modelRef: string; dtype: string; entailmentIndex: number; premises: string[]; hypotheses: string[] }
  ): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error('worker not initialized'))
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ ...msg, id })
    })
  }

  private emitModelEvent(
    type:
      | 'rag.model.download.started'
      | 'rag.model.download.completed'
      | 'rag.model.download.failed',
    info: EmbedderInfo,
    extra: Record<string, unknown> = {}
  ): void {
    const payload = {
      embedderId: info.id,
      name: info.name,
      modelRef: info.modelRef,
      dimensions: info.dimensions,
      approxBytes: info.approxBytes,
      ...extra
    }
    try {
      recordEvent({
        type,
        actorKind: 'system',
        severity: type === 'rag.model.download.failed' ? 'error' : 'info',
        entityKind: 'embedder',
        entityId: info.id,
        payload
      })
    } catch (err) {
      console.error(`[embeddings] ${type} event failed:`, err)
    }
    // Also push the lifecycle LIVE to every renderer window so the onboarding UI
    // can show download progress/failure the moment it happens (the recordEvent
    // above is the persisted timeline copy; this is the real-time signal). Mirrors
    // ipc/rag.ts's `rag:document:progress` fan-out. Best-effort + electron lazily
    // required so this module still loads under vitest (no electron there).
    broadcastToRenderers('rag:model:download', { type, ...payload })
  }
}

// ──────────────────── failure classification + live broadcast ────────────────────

/** Map a raw load error to a TYPED, friendly status. Offline/network signatures
 *  and timeouts become an actionable "connect once, or connect an AI model"
 *  message; anything else is reported as a generic model-load failure. */
export function classifyDownloadError(err: unknown): DownloadErrorInfo {
  const msg = String((err as Error)?.message ?? err ?? '')
  if (/\btimed out\b|\btimeout\b/i.test(msg)) {
    return {
      kind: 'timeout',
      offline: true,
      reason:
        "The local search model download timed out — connect to the internet once to finish it, or connect an AI model instead."
    }
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT|getaddrinfo|fetch failed|Failed to fetch|network|socket hang up|\bdns\b|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|certificate|\bTLS\b|\bSSL\b|\b403\b|\b404\b|Could not locate/i.test(
      msg
    )
  ) {
    return {
      kind: 'offline',
      offline: true,
      reason:
        "Couldn't download the local search model — connect to the internet once, or connect an AI model instead."
    }
  }
  return {
    kind: 'unknown',
    offline: false,
    reason: `The local search model couldn't be loaded${msg ? ` (${msg.slice(0, 140)})` : ''}.`
  }
}

/** Build a TYPED download-failure Error: friendly `message` plus machine-readable
 *  fields (code/kind/offline/embedderId) a caller or the renderer can branch on. */
export function makeModelDownloadError(info: EmbedderInfo, cls: DownloadErrorInfo): Error {
  const e = new Error(cls.reason) as Error & {
    code?: string
    embedderId?: string
    offline?: boolean
    kind?: string
  }
  e.code = 'MODEL_DOWNLOAD_FAILED'
  e.embedderId = info.id
  e.offline = cls.offline
  e.kind = cls.kind
  return e
}

/** Fan a small payload out to every renderer window on a channel. Electron is
 *  lazily required + fully guarded so this is a no-op under vitest / headless /
 *  mid-shutdown and never throws into a caller. */
function broadcastToRenderers(channel: string, payload: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch {
    // no electron (tests) / no windows / shutting down — best-effort only
  }
}

// ──────────────────── real worker spawn ────────────────────

/** The bundled-models dir in a PACKAGED install (process.resourcesPath/models/transformers), or ''
 *  in dev / tests / when unpackaged. Passed to the worker so transformers.js loads the bundled
 *  default embedder locally (offline first run). Electron is required lazily + guarded so this is a
 *  harmless '' under vitest (no electron) and never throws. */
function bundledModelsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (app.isPackaged) return join(process.resourcesPath, 'models', 'transformers')
  } catch {
    // no electron (tests / headless) — fall through to online-fetch behaviour
  }
  return ''
}

function spawnRealWorker(userDataPath: string): WorkerLike {
  // Run the embedder in an Electron **utilityProcess** — a separate OS process,
  // NOT a worker_thread. This is the crash-isolation fix: the ONNX/transformers.js
  // pipeline can segfault natively (OOM on a heavy forward pass); in a worker_thread
  // that fault shares the host's memory space and takes the WHOLE app down. A
  // utilityProcess is its own process, so a segfault surfaces as a non-zero `exit`
  // (handled in ensureWorker → reject pending + drop the handle) and the host lives.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { utilityProcess } = require('electron') as typeof import('electron')
  // In the packaged app, require.resolve returns the app.asar VIRTUAL path; the
  // worker's dynamic import('@huggingface/transformers') → onnxruntime-* native
  // bindings must resolve from REAL fs. The worker + its dep closure are
  // asarUnpack'd (electron-builder.yml), so redirect to the unpacked copy. No-op in
  // dev (path has no 'app.asar').
  const resolved = require.resolve('./worker.js') // resolved post-bundle
  const workerPath = resolved.includes('app.asar')
    ? resolved.replace('app.asar', 'app.asar.unpacked')
    : resolved
  // userDataPath is passed as argv (worker reads process.argv[2]) since a
  // utilityProcess has no worker_threads `workerData`.
  const child = utilityProcess.fork(workerPath, [userDataPath, bundledModelsPath()], {
    serviceName: 'duin-embedder'
  })
  return {
    postMessage: (m: unknown) => child.postMessage(m),
    on: (event: 'message' | 'error' | 'exit', listener: any) => {
      // UtilityProcess emits 'message' (raw value) + 'exit' (code); a native crash
      // arrives as a non-zero 'exit', which is exactly what the caller recovers from.
      // Cast past the per-event overloads (a union event + single listener doesn't
      // resolve against them); the 'error' event is a harmless no-op on UtilityProcess.
      ;(child as unknown as { on(e: string, l: unknown): void }).on(event, listener)
    },
    terminate: () => {
      child.kill()
    }
  }
}

// ──────────────────── singleton ────────────────────

let singleton: EmbeddingsService | null = null

export function getEmbeddingsService(userDataPath?: string): EmbeddingsService {
  if (!singleton) {
    if (!userDataPath) {
      throw new Error(
        'getEmbeddingsService: first call must supply userDataPath'
      )
    }
    singleton = new EmbeddingsService(userDataPath)
  }
  return singleton
}

/** Test-only: drop the singleton so the next call rebuilds it. */
export function __resetEmbeddingsService(): void {
  if (singleton) {
    void singleton.dispose()
  }
  singleton = null
}

// Re-export for IPC handler convenience.
export { EMBEDDING_CATALOG, getEmbedder, getDefault, DEFAULT_EMBEDDER_ID } from './catalog'
export type { EmbedderInfo } from './catalog'

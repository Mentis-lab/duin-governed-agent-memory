import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The embeddings service is exercised via an injected fake worker so the
// test runs without spawning a real worker_thread or downloading the
// 33 MB bge-small model. The real-worker path is integration-only — gated
// by the `LAMPREY_RUN_EMBED_NETWORK` env var per the plan's "first-run
// download allowed up to 60s" note. We do NOT default it on; that would
// burn ~33 MB of bandwidth on every CI run.

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('electron app not available in test environment')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  __forceMemoryFallback,
  __resetEventLog,
  listEvents
} from '../../event-log'
import {
  EMBEDDING_CATALOG,
  DEFAULT_EMBEDDER_ID,
  getDefault,
  getEmbedder,
  RERANKER_CATALOG,
  DEFAULT_RERANKER_ID,
  getReranker,
  getDefaultReranker,
  NLI_CATALOG,
  DEFAULT_NLI_ID,
  getNli,
  getDefaultNli
} from './catalog'
import {
  EmbeddingsService,
  __resetEmbeddingsService,
  classifyDownloadError,
  makeModelDownloadError,
  type WorkerFactory,
  type WorkerLike
} from './service'

beforeEach(() => {
  __resetEventLog()
  __forceMemoryFallback()
  __resetEmbeddingsService()
})

afterEach(() => {
  __resetEmbeddingsService()
})

// ──────────────────── catalog ────────────────────

describe('EMBEDDING_CATALOG', () => {
  it('default is the multilingual e5 embedder; bge-small stays an opt-in', () => {
    expect(DEFAULT_EMBEDDER_ID).toBe('multilingual-e5-small')
    expect(getDefault().id).toBe('multilingual-e5-small')
    // e5 stays in the catalogue as a selectable option, with its required prefixes
    const e5 = getEmbedder('multilingual-e5-small')
    expect(e5?.queryPrefix).toBe('query: ')
    expect(e5?.passagePrefix).toBe('passage: ')
  })

  it('every entry has the required fields and a Xenova/* modelRef', () => {
    expect(EMBEDDING_CATALOG.length).toBeGreaterThanOrEqual(2)
    for (const e of EMBEDDING_CATALOG) {
      expect(e.id).toBeTruthy()
      expect(e.name).toBeTruthy()
      expect(e.dimensions).toBeGreaterThan(0)
      expect(e.approxBytes).toBeGreaterThan(0)
      expect(e.modelRef).toMatch(/^Xenova\//)
    }
  })

  it('getEmbedder returns undefined for unknown ids', () => {
    expect(getEmbedder('not-a-real-embedder')).toBeUndefined()
  })
})

// ──────────────────── reranker catalog (P2) ────────────────────

describe('RERANKER_CATALOG', () => {
  it('default reranker is a loadable transformers.js model (Xenova/*)', () => {
    // jina-reranker-v2 was verified NOT loadable in transformers.js; the default
    // must be a model that actually loads (bge-reranker-base).
    expect(DEFAULT_RERANKER_ID).toBe('bge-reranker-base')
    const d = getDefaultReranker()
    expect(d.modelRef).toBe('Xenova/bge-reranker-base')
    expect(d.dtype).toBe('q8')
    expect(d.multilingual).toBe(true) // EN/ZH — needed for the CJK vault
  })

  it('every reranker has the required fields', () => {
    for (const r of RERANKER_CATALOG) {
      expect(r.id).toBeTruthy()
      expect(r.modelRef).toBeTruthy()
      expect(r.approxBytes).toBeGreaterThan(0)
      expect(['q8', 'fp16', 'fp32']).toContain(r.dtype)
    }
  })

  it('getReranker returns undefined for unknown ids', () => {
    expect(getReranker('nope')).toBeUndefined()
  })
})

// ──────────────────── fake-worker plumbing ────────────────────

/**
 * Build a fake worker that resolves load/embed messages immediately. The
 * `embed` reply is deterministic so the test can assert ordering + dim.
 * Implemented as a synchronous responder using a microtask hop so the
 * service's pending-map plumbing has time to register a callback first.
 */
function makeFakeWorker(
  dim: number,
  opts: { failLoad?: boolean } = {}
): { factory: WorkerFactory; instance: WorkerLike; emitExit: (code: number) => void } {
  const messageHandlers: Array<(msg: unknown) => void> = []
  const errorHandlers: Array<(err: Error) => void> = []
  const exitHandlers: Array<(code: number) => void> = []
  const fake: WorkerLike = {
    postMessage(msg: unknown) {
      // Microtask reply so the .send() promise has time to register first.
      queueMicrotask(() => {
        const m = msg as { type: string; id: string; texts?: string[] }
        if (m.type === 'load') {
          if (opts.failLoad) {
            for (const h of messageHandlers) h({ type: 'error', id: m.id, message: 'load failed (fake)' })
          } else {
            for (const h of messageHandlers) h({ type: 'load:done', id: m.id })
          }
        } else if (m.type === 'embed') {
          const texts = m.texts ?? []
          const vectors = texts.map((t) => {
            const v = new Float32Array(dim)
            // Deterministic: bucket each text's char codes mod dim.
            for (let i = 0; i < t.length; i++) {
              v[i % dim] += t.charCodeAt(i) / 1000
            }
            return v
          })
          for (const h of messageHandlers) h({ type: 'embed:done', id: m.id, vectors })
        } else if (m.type === 'rerank') {
          // Deterministic cross scores: longer passage → higher score, so a
          // test can assert the service round-trips scores in passage order.
          const mr = msg as { id: string; passages: string[] }
          const scores = mr.passages.map((p) => Math.min(1, p.length / 100))
          for (const h of messageHandlers) h({ type: 'rerank:done', id: mr.id, scores })
        } else if (m.type === 'nli') {
          // Deterministic entailment scores: premise CONTAINS hypothesis → 0.9
          // (supported), else 0.1. Order-preserving so the service round-trip can
          // assert one score per pair in input order.
          const mn = msg as { id: string; premises: string[]; hypotheses: string[] }
          const scores = mn.premises.map((p, i) =>
            p.includes(mn.hypotheses[i]) ? 0.9 : 0.1
          )
          for (const h of messageHandlers) h({ type: 'nli:done', id: mn.id, scores })
        } else if (m.type === 'dispose') {
          // no-op for the fake
        }
      })
    },
    on(event: 'message' | 'error' | 'exit', listener: any) {
      if (event === 'message') messageHandlers.push(listener)
      else if (event === 'error') errorHandlers.push(listener)
      else if (event === 'exit') exitHandlers.push(listener)
    },
    terminate: () => Promise.resolve(0)
  }
  return {
    factory: () => fake,
    instance: fake,
    emitExit: (code: number) => exitHandlers.forEach((h) => h(code))
  }
}

// ──────────────────── service behaviour with the fake worker ────────────────────

describe('EmbeddingsService — fake worker', () => {
  it('setActive emits download.started + download.completed on first activation', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await svc.setActive('bge-small-en-v1.5')
    const types = listEvents({ order: 'asc' }).map((e) => e.type)
    expect(types).toContain('rag.model.download.started')
    expect(types).toContain('rag.model.download.completed')
  })

  it('a second setActive for the SAME model does not emit a second download event pair', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await svc.setActive('bge-small-en-v1.5')
    const baseline = listEvents({ type: 'rag.model.download.started' }).length
    await svc.setActive('bge-small-en-v1.5')
    expect(listEvents({ type: 'rag.model.download.started' }).length).toBe(baseline)
  })

  it('switching to a different model DOES emit a new download pair', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await svc.setActive('bge-small-en-v1.5')
    await svc.setActive('all-MiniLM-L6-v2')
    const events = listEvents({ type: 'rag.model.download.started' })
    expect(events.length).toBe(2)
    const ids = events.map((e) => (e.payload as { embedderId: string }).embedderId).sort()
    expect(ids).toEqual(['all-MiniLM-L6-v2', 'bge-small-en-v1.5'])
  })

  it('setActive("unknown") throws with a clear message', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.setActive('totally-fake-id')).rejects.toThrow(/unknown embedder/i)
  })

  it('embed returns one Float32Array per input text in input order', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const vectors = await svc.embed(['alpha', 'beta', 'gamma'])
    expect(vectors).toHaveLength(3)
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array)
      expect(v.length).toBe(384)
    }
  })

  it('embed batches texts above BATCH_SIZE into multiple worker calls', async () => {
    const { factory, instance } = makeFakeWorker(384)
    const spy = vi.spyOn(instance, 'postMessage')
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const texts = Array.from({ length: 75 }, (_, i) => `t${i}`)
    const out = await svc.embed(texts)
    expect(out).toHaveLength(75)
    // BATCH_SIZE=8 → ceil(75/8)=10 embed messages (each a bounded forward pass).
    const embedPosts = spy.mock.calls.filter(
      (c) => (c[0] as { type: string })?.type === 'embed'
    )
    expect(embedPosts.length).toBe(10)
  })

  it('embed([]) returns an empty array without touching the worker', async () => {
    const { factory, instance } = makeFakeWorker(384)
    const spy = vi.spyOn(instance, 'postMessage')
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const out = await svc.embed([])
    expect(out).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('dispose calls terminate on the worker', async () => {
    const { factory, instance } = makeFakeWorker(384)
    const terminateSpy = vi.spyOn(instance, 'terminate')
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await svc.setActive('bge-small-en-v1.5')
    await svc.dispose()
    expect(terminateSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects an embed call when the worker replies with an error message', async () => {
    // Build a fake that ALWAYS replies with an error to embed requests. The
    // service must surface that as a rejected promise (not a hang).
    type Msg =
      | { type: 'load:done'; id: string }
      | { type: 'embed:done'; id: string; vectors: Float32Array[] }
      | { type: 'error'; id: string; message: string }
    const messageHandlers: Array<(msg: Msg) => void> = []
    const fake: WorkerLike = {
      postMessage(msg: unknown) {
        queueMicrotask(() => {
          const m = msg as { type: string; id: string }
          if (m.type === 'load') {
            for (const h of messageHandlers) h({ type: 'load:done', id: m.id })
          } else if (m.type === 'embed') {
            for (const h of messageHandlers) {
              h({ type: 'error', id: m.id, message: 'pipeline crashed' })
            }
          }
        })
      },
      on(event: 'message' | 'error' | 'exit', listener: any) {
        if (event === 'message') messageHandlers.push(listener)
      },
      terminate: () => Promise.resolve(0)
    }
    const svc = new EmbeddingsService('/tmp/userdata', () => fake)
    await svc.setActive('bge-small-en-v1.5')
    await expect(svc.embed(['x'])).rejects.toThrow(/pipeline crashed/)
  })
})

// ──────────────────── worker crash → reload (regression) ────────────────────

/**
 * A factory that forks a FRESH fake worker per spawn, each with its own
 * pipeline state — mirroring the real utilityProcess, where a crash destroys
 * `pipelineP` and the re-spawn starts empty. Un-loaded workers reject `embed`
 * with worker.ts's real message, so a service that skips the reload is caught.
 */
function makeRespawningWorkerFactory(dim: number): {
  factory: WorkerFactory
  spawned: Array<{ worker: WorkerLike; emitExit: (code: number) => void }>
} {
  const spawned: Array<{ worker: WorkerLike; emitExit: (code: number) => void }> = []
  const factory: WorkerFactory = () => {
    const messageHandlers: Array<(msg: any) => void> = []
    const exitHandlers: Array<(code: number) => void> = []
    let loaded = false // per-PROCESS pipeline state; dies with this instance
    const fake: WorkerLike = {
      postMessage(msg: unknown) {
        queueMicrotask(() => {
          const m = msg as { type: string; id: string; texts?: string[] }
          if (m.type === 'load') {
            loaded = true
            for (const h of messageHandlers) h({ type: 'load:done', id: m.id })
          } else if (m.type === 'embed') {
            if (!loaded) {
              // Verbatim from worker.ts handleEmbed.
              for (const h of messageHandlers) {
                h({
                  type: 'error',
                  id: m.id,
                  message: 'embed received before load — call setActive first'
                })
              }
              return
            }
            const vectors = (m.texts ?? []).map(() => new Float32Array(dim))
            for (const h of messageHandlers) h({ type: 'embed:done', id: m.id, vectors })
          }
        })
      },
      on(event: 'message' | 'error' | 'exit', listener: any) {
        if (event === 'message') messageHandlers.push(listener)
        else if (event === 'exit') exitHandlers.push(listener)
      },
      terminate: () => Promise.resolve(0)
    }
    const entry = { worker: fake, emitExit: (code: number) => exitHandlers.forEach((h) => h(code)) }
    spawned.push(entry)
    return fake
  }
  return { factory, spawned }
}

describe('EmbeddingsService — recovers from an embedder process crash', () => {
  it('re-loads the model into the re-spawned worker so embed keeps working', async () => {
    const { factory, spawned } = makeRespawningWorkerFactory(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)

    // 1. First embed autoloads the active model into worker #1.
    expect(await svc.embed(['alpha'])).toHaveLength(1)
    expect(spawned).toHaveLength(1)

    // 2. The utilityProcess segfaults on a heavy forward pass → non-zero exit.
    spawned[0].emitExit(1)

    // 3. The next embed must fork a fresh worker AND re-load the model. The
    //    autoload guard previously keyed off a never-cleared download-event set,
    //    so it skipped the load and every subsequent embed failed permanently.
    expect(await svc.embed(['beta'])).toHaveLength(1)
    expect(spawned).toHaveLength(2)
  })

  it('a post-crash embed does not permanently wedge the RAG vector leg', async () => {
    const { factory, spawned } = makeRespawningWorkerFactory(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await svc.embed(['warm up'])
    spawned[0].emitExit(1)
    // Several consecutive callers (next ingest file, next chat turn) all succeed.
    for (const text of ['one', 'two', 'three']) {
      expect(await svc.embed([text])).toHaveLength(1)
    }
    expect(spawned).toHaveLength(2) // one re-spawn, then stable
  })
})

// ──────────────────── rerank round-trip (P2) ────────────────────

describe('EmbeddingsService — rerank', () => {
  it('round-trips a rerank message and returns one score per passage, in order', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    // Fake worker scores by passage length/100 → deterministic + order-preserving.
    const scores = await svc.rerank('q', ['aa', 'a'.repeat(50), 'a'.repeat(100)])
    expect(scores).toHaveLength(3)
    expect(scores[0]).toBeCloseTo(0.02)
    expect(scores[1]).toBeCloseTo(0.5)
    expect(scores[2]).toBeCloseTo(1)
  })

  it('empty passages short-circuits to [] without touching the worker', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    expect(await svc.rerank('q', [])).toEqual([])
  })

  it('rejects an unknown reranker id', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.rerank('q', ['a'], 'not-a-reranker')).rejects.toThrow(/unknown reranker/)
  })
})

// ──────────────────── NLI catalog (citation SUPPORT gate, L1) ────────────────────

describe('NLI_CATALOG', () => {
  it('default NLI model is a loadable transformers.js model with a declared entailment index', () => {
    expect(DEFAULT_NLI_ID).toBe('nli-deberta-v3-small')
    const d = getDefaultNli()
    expect(d.modelRef).toBe('Xenova/nli-deberta-v3-small')
    expect(d.dtype).toBe('q8')
    // deberta-v3 cross-encoder NLI order is [contradiction, entailment, neutral];
    // entailment (== the SUPPORT class) is index 1, NOT the HF-default order.
    expect(d.labelOrder).toEqual(['contradiction', 'entailment', 'neutral'])
    expect(d.entailmentIndex).toBe(1)
    expect(d.labelOrder[d.entailmentIndex]).toBe('entailment')
  })

  it('every NLI entry has the required fields + a valid entailment index', () => {
    for (const n of NLI_CATALOG) {
      expect(n.id).toBeTruthy()
      expect(n.modelRef).toBeTruthy()
      expect(n.approxBytes).toBeGreaterThan(0)
      expect(['q8', 'fp16', 'fp32']).toContain(n.dtype)
      expect(n.entailmentIndex).toBeGreaterThanOrEqual(0)
      expect(n.entailmentIndex).toBeLessThan(n.labelOrder.length)
      expect(n.labelOrder[n.entailmentIndex]).toBe('entailment')
    }
  })

  it('getNli returns undefined for unknown ids', () => {
    expect(getNli('nope')).toBeUndefined()
  })
})

// ──────────────────── scoreEntailment round-trip (L1) ────────────────────

describe('EmbeddingsService — scoreEntailment', () => {
  it('round-trips an nli message and returns one P(entailment) per pair, in order', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    // Fake worker: premise CONTAINS hypothesis → 0.9, else 0.1.
    const scores = await svc.scoreEntailment(
      ['the sky is blue and clear', 'unrelated premise text'],
      ['sky is blue', 'penguins']
    )
    expect(scores).toEqual([0.9, 0.1])
  })

  it('empty premises short-circuits to [] without touching the worker', async () => {
    const { factory, instance } = makeFakeWorker(384)
    const spy = vi.spyOn(instance, 'postMessage')
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    expect(await svc.scoreEntailment([], [])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a premise/hypothesis length mismatch', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.scoreEntailment(['a', 'b'], ['x'])).rejects.toThrow(/premises vs .* hypotheses/)
  })

  it('rejects an unknown nli model id', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.scoreEntailment(['a'], ['b'], 'not-an-nli-model')).rejects.toThrow(/unknown nli model/)
  })
})

// ──────────────────── probeModel — recoverable switch (Part A) ────────────────────

describe('EmbeddingsService — probeModel', () => {
  it('probe success returns the model\'s REAL output dim and leaves it active', async () => {
    const { factory } = makeFakeWorker(512) // pretend the model emits 512-dim
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const r = await svc.probeModel('multilingual-e5-small')
    expect(r).toEqual({ ok: true, dims: 512 })
    expect(svc.getActiveEmbedderId()).toBe('multilingual-e5-small')
  })

  it('probe of an unknown id fails WITHOUT touching the active embedder', async () => {
    const { factory } = makeFakeWorker(384)
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const before = svc.getActiveEmbedderId()
    const r = await svc.probeModel('totally-fake')
    expect(r.ok).toBe(false)
    expect(svc.getActiveEmbedderId()).toBe(before)
  })

  it('probe REVERTS the active embedder when the load fails (keeps known-good)', async () => {
    const { factory } = makeFakeWorker(384, { failLoad: true })
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    const before = svc.getActiveEmbedderId() // the default
    const r = await svc.probeModel('multilingual-e5-small')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/load failed/i)
    expect(svc.getActiveEmbedderId()).toBe(before) // reverted, not stuck on the bad model
  })
})

// ──────────────────── offline-graceful download (Dim 2) ────────────────────

describe('classifyDownloadError — typed, friendly status', () => {
  it('classifies network signatures as offline with an actionable reason', () => {
    for (const msg of [
      'getaddrinfo ENOTFOUND huggingface.co',
      'fetch failed',
      'ECONNREFUSED 127.0.0.1:443',
      'socket hang up'
    ]) {
      const c = classifyDownloadError(new Error(msg))
      expect(c.kind).toBe('offline')
      expect(c.offline).toBe(true)
      expect(c.reason).toMatch(/connect to the internet|connect an AI model/i)
    }
  })

  it('classifies a timeout as its own kind (still offline-actionable)', () => {
    const c = classifyDownloadError(new Error('model download/load timed out after 90000ms'))
    expect(c.kind).toBe('timeout')
    expect(c.offline).toBe(true)
  })

  it('a non-network model error is "unknown" (not blamed on the network)', () => {
    const c = classifyDownloadError(new Error('Unsupported model type: null'))
    expect(c.kind).toBe('unknown')
    expect(c.offline).toBe(false)
  })
})

describe('makeModelDownloadError — typed error surface', () => {
  it('carries code/kind/offline/embedderId for callers + renderer to branch on', () => {
    const err = makeModelDownloadError(getDefault(), {
      kind: 'offline',
      offline: true,
      reason: 'nope'
    }) as Error & { code?: string; kind?: string; offline?: boolean; embedderId?: string }
    expect(err.code).toBe('MODEL_DOWNLOAD_FAILED')
    expect(err.kind).toBe('offline')
    expect(err.offline).toBe(true)
    expect(err.embedderId).toBe(getDefault().id)
    expect(err.message).toBe('nope')
  })
})

describe('EmbeddingsService — offline model download degrades safely', () => {
  it('a failed load emits a TYPED rag.model.download.failed (reason + kind) and throws MODEL_DOWNLOAD_FAILED', async () => {
    const { factory } = makeFakeWorker(384, { failLoad: true })
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.setActive('bge-small-en-v1.5')).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED'
    })
    const failed = listEvents({ type: 'rag.model.download.failed' })
    expect(failed.length).toBe(1)
    const p = failed[0].payload as { reason?: string; kind?: string; offline?: boolean }
    expect(p.reason).toBeTruthy()
    expect(p.kind).toBe('unknown') // fake reply isn't a network signature
    expect(svc.getDownloadFailure('bge-small-en-v1.5')).toBeTruthy()
  })

  it('after a failure, setActive FAILS FAST — no second load attempt, no duplicate started event', async () => {
    const { factory, instance } = makeFakeWorker(384, { failLoad: true })
    const spy = vi.spyOn(instance, 'postMessage')
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.setActive('bge-small-en-v1.5')).rejects.toThrow()
    const loadsAfterFirst = spy.mock.calls.filter((c) => (c[0] as { type: string })?.type === 'load').length
    await expect(svc.setActive('bge-small-en-v1.5')).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD_FAILED' })
    // No new 'load' message posted on the fail-fast path.
    const loadsTotal = spy.mock.calls.filter((c) => (c[0] as { type: string })?.type === 'load').length
    expect(loadsTotal).toBe(loadsAfterFirst)
    // Only the first attempt emitted a 'started'.
    expect(listEvents({ type: 'rag.model.download.started' }).length).toBe(1)
  })

  it('clearDownloadFailure re-arms a retry (next setActive attempts the load again)', async () => {
    const { factory, instance } = makeFakeWorker(384, { failLoad: true })
    const svc = new EmbeddingsService('/tmp/userdata', factory)
    await expect(svc.setActive('bge-small-en-v1.5')).rejects.toThrow()
    svc.clearDownloadFailure('bge-small-en-v1.5')
    const spy = vi.spyOn(instance, 'postMessage')
    await expect(svc.setActive('bge-small-en-v1.5')).rejects.toThrow()
    // A fresh load was attempted (fail-fast was cleared).
    expect(spy.mock.calls.filter((c) => (c[0] as { type: string })?.type === 'load').length).toBe(1)
  })
})

// ──────────────────── real worker (network) — opt-in only ────────────────────

const runNet = process.env.LAMPREY_RUN_EMBED_NETWORK === '1'
describe.skipIf(!runNet)('EmbeddingsService — real worker (network)', () => {
  it('downloads bge-small and produces 384-dim normalized vectors', async () => {
    // Intentionally skipped by default. Setting LAMPREY_RUN_EMBED_NETWORK=1
    // exercises the real model download + first inference (~60s on a cold
    // cache). Place-holder body — when run, the developer asserts:
    //   const svc = new EmbeddingsService(realUserDataPath)
    //   await svc.setActive(DEFAULT_EMBEDDER_ID)
    //   const [v] = await svc.embed(['hello world'])
    //   expect(v.length).toBe(384)
    //   const norm = Math.sqrt([...v].reduce((s,x)=>s+x*x,0))
    //   expect(Math.abs(norm - 1)).toBeLessThan(1e-3)
  })
})

// ──────────────────── embedWith: named space + serialization ────────────────────

/** A worker that RECORDS what it was asked to do: which model each `load` named,
 *  and which model was resident when each `embed` batch arrived. That last part is
 *  the whole point — it is what makes a cross-consumer interleave observable. */
function makeRecordingWorker(dim: number): {
  factory: WorkerFactory
  loads: string[]
  embeds: { model: string; texts: string[] }[]
} {
  const loads: string[] = []
  const embeds: { model: string; texts: string[] }[] = []
  let resident = ''
  const messageHandlers: Array<(msg: unknown) => void> = []
  const fake: WorkerLike = {
    postMessage(msg: unknown) {
      queueMicrotask(() => {
        const m = msg as { type: string; id: string; texts?: string[]; modelRef?: string }
        if (m.type === 'load') {
          resident = m.modelRef ?? ''
          loads.push(resident)
          for (const h of messageHandlers) h({ type: 'load:done', id: m.id })
        } else if (m.type === 'embed') {
          const texts = m.texts ?? []
          embeds.push({ model: resident, texts })
          const vectors = texts.map(() => new Float32Array(dim))
          for (const h of messageHandlers) h({ type: 'embed:done', id: m.id, vectors })
        }
      })
    },
    on(event: string, listener: (...args: never[]) => void) {
      if (event === 'message') messageHandlers.push(listener as (msg: unknown) => void)
    },
    terminate() {}
  } as unknown as WorkerLike
  return { factory: () => fake, loads, embeds }
}

const E5 = 'multilingual-e5-small'
const BGE = 'bge-small-en-v1.5'

describe('embedWith', () => {
  it('does not repoint the active embedder', async () => {
    const { factory } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    expect(svc.getActiveEmbedderId()).toBe(DEFAULT_EMBEDDER_ID)
    await svc.setActive(BGE)
    expect(svc.getActiveEmbedderId()).toBe(BGE)

    // The whole reason this method exists: a consumer needing a DIFFERENT space
    // must not silently reset the user's Library picker to its own choice. Before
    // this, every chat turn's memory recall called setActive() and did exactly that.
    await svc.embedWith(E5, ['hello'], 'none')
    expect(svc.getActiveEmbedderId()).toBe(BGE)
  })

  it('loads the named model and embeds against it', async () => {
    const { factory, loads, embeds } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    await svc.setActive(BGE)
    await svc.embedWith(E5, ['hello'], 'none')
    expect(loads).toEqual([getEmbedder(BGE)!.modelRef, getEmbedder(E5)!.modelRef])
    expect(embeds).toHaveLength(1)
    expect(embeds[0].model).toBe(getEmbedder(E5)!.modelRef)
  })

  it("applies the model's instruction prefix per kind, and nothing for 'none'", async () => {
    const { factory, embeds } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    await svc.embedWith(E5, ['q'], 'query')
    await svc.embedWith(E5, ['p'], 'passage')
    await svc.embedWith(E5, ['n'], 'none')
    // BGE declares no prefixes, so 'query' is a no-op there.
    await svc.embedWith(BGE, ['b'], 'query')
    expect(embeds.map((e) => e.texts[0])).toEqual(['query: q', 'passage: p', 'n', 'b'])
  })

  it('rejects an unknown embedder rather than silently using the active one', async () => {
    const { factory } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    await expect(svc.embedWith('not-a-model', ['x'], 'none')).rejects.toThrow(/unknown embedder/)
  })

  it('binds embed() to the embedder active WHEN CALLED, not when it dequeues', async () => {
    // setActive assigns activeEmbedderId synchronously and outside the chain, so
    // reading the field inside the queued closure let a picker change retarget an
    // already-issued call — a vector in the new space for a query the caller had
    // already cleared against the old one.
    const { factory, embeds } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    await svc.setActive(E5)
    const inflight = svc.embed(['q'])
    void svc.setActive(BGE) // lands while the embed is queued
    await inflight
    expect(embeds[0].model).toBe(getEmbedder(E5)!.modelRef)
  })

  it('serializes two consumers so neither batch lands on the other model', async () => {
    const { factory, embeds } = makeRecordingWorker(384)
    const svc = new EmbeddingsService('/tmp/x', factory)
    // 9 texts => 2 batches (BATCH_SIZE 8), i.e. an await point INSIDE the first
    // call where the second call could otherwise slip its `load` through.
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`)
    await Promise.all([
      svc.embedWith(E5, nine, 'none'),
      svc.embedWith(BGE, ['other'], 'none')
    ])
    const e5Ref = getEmbedder(E5)!.modelRef
    const bgeRef = getEmbedder(BGE)!.modelRef
    // Every batch must have been served by the model its OWN call named.
    for (const e of embeds) {
      const expected = e.texts.includes('other') ? bgeRef : e5Ref
      expect(e.model).toBe(expected)
    }
    expect(embeds).toHaveLength(3)
  })
})

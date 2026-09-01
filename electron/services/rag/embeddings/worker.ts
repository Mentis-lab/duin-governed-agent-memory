// Worker-thread that hosts a transformers.js feature-extraction pipeline.
// Spawned by `service.ts`. Communication is via the standard worker
// `postMessage` / `parentPort.on('message')` protocol.
//
// Why a worker, not just async?
//   ONNX inference is CPU-heavy; a 2,000-chunk ingest would freeze the
//   main process for tens of seconds and block IPC. With a worker, ingest
//   is backgrounded and the UI stays responsive.
//
// Why not native llama.cpp?
//   Binary distribution headache (per-arch, per-OS, GPU/CPU) for marginal
//   quality gain. transformers.js trades a small speed hit for zero-config
//   installation across every Lamprey target.

import { join } from 'path'
import { createRefCache } from './ref-cache'

// This module runs as an Electron **utilityProcess** (a separate OS process),
// spawned by service.ts. Running the ONNX / transformers.js pipeline out-of-process
// means a native segfault — the failure mode that used to take the whole app down
// mid-reindex — kills ONLY this child; the host survives and re-spawns on the next
// embed (service.ts's `exit` handler rejects the in-flight batch). Messaging is via
// process.parentPort (MessagePortMain): inbound arrives as `{ data }`, outbound via
// postMessage. userDataPath is passed as fork argv[2].
const parentPort = process.parentPort
const userDataPath: string = process.argv[2] ?? ''
// Bundled-models dir (process.resourcesPath/models/transformers), passed by service.ts as argv[3] in
// the PACKAGED app. When set, transformers.js checks it FIRST (localModelPath) so the bundled default
// embedder loads with NO network on first run; '' in dev/tests → pure online-fetch as before.
const bundledModelPath: string = process.argv[3] ?? ''
function post(msg: unknown): void {
  parentPort.postMessage(msg)
}

// transformers.js is a top-level dependency but the worker entry runs in a
// fresh module graph. Cache the dynamic-import result so subsequent embed
// calls don't pay the import cost on each message.
type PipelineFn = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{
  data: Float32Array
  dims: number[]
}>

interface LoadMessage {
  type: 'load'
  modelRef: string
  id: string
}

interface EmbedMessage {
  type: 'embed'
  texts: string[]
  id: string
  /** Which model to embed WITH. The message used to carry no model and the handler
   *  read "whatever is currently loaded", which is only correct while exactly one
   *  consumer exists. Naming it here makes the request self-describing, lets the
   *  cache serve two models at once, and removes the load-before-embed ordering
   *  requirement entirely. Optional so an older caller still resolves to the MRU. */
  modelRef?: string
}

interface RerankMessage {
  type: 'rerank'
  modelRef: string
  dtype: string
  query: string
  passages: string[]
  id: string
}

// NLI citation-SUPPORT gate: score ENTAILMENT of (premise, hypothesis) PAIRS.
// Unlike rerank (one query vs many passages), premises + hypotheses are two
// parallel, equal-length arrays — each premise paired with its own hypothesis.
interface NliMessage {
  type: 'nli'
  modelRef: string
  dtype: string
  entailmentIndex: number
  premises: string[]
  hypotheses: string[]
  id: string
}

interface DisposeMessage {
  type: 'dispose'
}

type InboundMessage = LoadMessage | EmbedMessage | RerankMessage | NliMessage | DisposeMessage

// Each model gets a ref-keyed memo that self-evicts a REJECTED load, so a model
// that failed to download once (e.g. offline) can be retried in the same worker
// instead of latching the original failure until app restart. See ref-cache.ts.
// Two embedders resident. The brain's notes index and a RAG collection can name
// DIFFERENT models in the same chat turn — that is the point of naming the space per
// call rather than sharing one global active embedder — and at capacity 1 every
// alternation paid a full model load. See createRefCache's own note.
const pipelineCache = createRefCache<PipelineFn>(2)

// ── Reranker (cross-encoder) — loaded lazily + independently of the embedder
// pipeline, since a query touches it only after retrieval fusion. AutoModel +
// AutoTokenizer (not `pipeline`) because a sequence-classification cross-encoder
// takes text PAIRS, which the text-classification pipeline doesn't expose.
type RerankFn = (query: string, passages: string[]) => Promise<number[]>
const rerankerCache = createRefCache<RerankFn>()

async function ensureReranker(modelRef: string, dtype: string): Promise<RerankFn> {
  return rerankerCache.get(modelRef, async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = (await import(
      '@huggingface/transformers'
    )) as unknown as {
      AutoTokenizer: { from_pretrained: (id: string) => Promise<any> }
      AutoModelForSequenceClassification: {
        from_pretrained: (id: string, opts?: { dtype?: string }) => Promise<any>
      }
      env: { cacheDir: string }
    }
    if (userDataPath) {
      env.cacheDir = join(userDataPath, 'models', 'transformers')
    }
    const tokenizer = await AutoTokenizer.from_pretrained(modelRef)
    const model = await AutoModelForSequenceClassification.from_pretrained(modelRef, { dtype })
    return async (query: string, passages: string[]): Promise<number[]> => {
      if (passages.length === 0) return []
      const inputs = await tokenizer(Array(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true
      })
      const { logits } = await model(inputs)
      // Cross-encoder emits one relevance logit per pair; sigmoid → 0..1
      // calibrated score. `.tolist()` shapes as [[s],[s],…] (1 label) or [s,…].
      const rows = logits.sigmoid().tolist() as Array<number[] | number>
      return rows.map((r) => (Array.isArray(r) ? r[0] : r))
    }
  })
}

// ── NLI cross-encoder (citation SUPPORT gate) — loaded lazily + independently
// of the embedder AND reranker, on its own channel. Same load path as the
// reranker (AutoModelForSequenceClassification + AutoTokenizer) but the head is
// a 3-class {contradiction, entailment, neutral} classifier, so the projection
// is a per-row SOFTMAX → P(entailment) at `entailmentIndex`, NOT the reranker's
// single-logit sigmoid. transformers.js's Tensor has no `.softmax()`, so we
// softmax over `logits.tolist()` in plain JS.
type NliFn = (premises: string[], hypotheses: string[], entailmentIndex: number) => Promise<number[]>
const nliCache = createRefCache<NliFn>()

/** Numerically-stable softmax of one logit row → the probability at `idx`. */
function softmaxAt(row: number[], idx: number): number {
  if (!row.length) return 0
  const max = Math.max(...row)
  let sum = 0
  const exps = row.map((v) => {
    const e = Math.exp(v - max)
    sum += e
    return e
  })
  const i = idx >= 0 && idx < row.length ? idx : 0
  return sum > 0 ? exps[i] / sum : 0
}

async function ensureNli(modelRef: string, dtype: string): Promise<NliFn> {
  return nliCache.get(modelRef, async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = (await import(
      '@huggingface/transformers'
    )) as unknown as {
      AutoTokenizer: { from_pretrained: (id: string) => Promise<any> }
      AutoModelForSequenceClassification: {
        from_pretrained: (id: string, opts?: { dtype?: string }) => Promise<any>
      }
      env: { cacheDir: string }
    }
    if (userDataPath) {
      env.cacheDir = join(userDataPath, 'models', 'transformers')
    }
    const tokenizer = await AutoTokenizer.from_pretrained(modelRef)
    const model = await AutoModelForSequenceClassification.from_pretrained(modelRef, { dtype })
    return async (premises: string[], hypotheses: string[], entailmentIndex: number): Promise<number[]> => {
      if (premises.length === 0) return []
      // NLI convention: premise = `text` (first), hypothesis = `text_pair`
      // (second). Two parallel arrays → each premise paired with its own
      // hypothesis. truncation:true keeps us under the 512-token limit.
      const inputs = await tokenizer(premises, {
        text_pair: hypotheses,
        padding: true,
        truncation: true
      })
      const { logits } = await model(inputs)
      // [n, 3] logits per pair → softmax over the 3 classes, take P(entailment).
      const rows = logits.tolist() as number[][]
      return rows.map((r) => softmaxAt(r, entailmentIndex))
    }
  })
}

async function ensurePipeline(modelRef: string): Promise<PipelineFn> {
  // The cache returns the loaded pipeline for `modelRef`, re-loads on a model
  // switch, and — critically — evicts a REJECTED load so an offline first-use
  // failure can be retried in this same worker (see ref-cache.ts).
  return pipelineCache.get(modelRef, async () => {
    // transformers.js ships its own types; types align so no override
    // needed. We narrow to the two named exports we actually use.
    // @huggingface/transformers v3 (successor to @xenova/transformers v2). The
    // feature-extraction pipeline + Tensor { data, dims } shape are unchanged;
    // the one behavioural difference is dtype selection — v2 defaulted to the
    // quantized ONNX, v3 defaults to fp32. We pin `dtype: 'q8'` so we keep
    // loading the SAME quantized weights (byte-parity with existing stored
    // vectors — no forced reindex) and the small download size.
    const { pipeline, env } = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (
        task: string,
        modelRef: string,
        opts?: { dtype?: string }
      ) => Promise<(texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>>
      env: { cacheDir: string; localModelPath?: string; allowLocalModels?: boolean }
    }
    // Pin the model cache to userData so production installs share the
    // download between sessions. userDataPath is '' in headless tests (the
    // worker isn't actually spawned), so guard the assignment.
    if (userDataPath) {
      env.cacheDir = join(userDataPath, 'models', 'transformers')
    }
    // Prefer BUNDLED models (shipped in resources/models/transformers) when present, so the DEFAULT
    // embedder loads with NO network on first run — the difference between semantic search working
    // out-of-the-box vs. requiring an internet round-trip before the first index. transformers.js
    // checks localModelPath first, then falls back to the HF fetch (allowRemoteModels stays
    // default-true) for any model NOT bundled (reranker / NLI / bge-m3) — those degrade gracefully,
    // exactly as before. Same <owner>/<model>/… layout as cacheDir, so a bundled copy is a drop-in
    // for a warm cache; an absent/empty dir just falls through to the online fetch.
    if (bundledModelPath) {
      env.localModelPath = bundledModelPath
      env.allowLocalModels = true
    }
    const pipe = await pipeline('feature-extraction', modelRef, { dtype: 'q8' })
    return async (texts: string[], options) => {
      const out = await pipe(texts, options)
      // transformers.js Tensor → { data, dims } shape.
      return { data: out.data as Float32Array, dims: out.dims as number[] }
    }
  })
}

async function handleLoad(msg: LoadMessage): Promise<void> {
  try {
    await ensurePipeline(msg.modelRef)
    post({ type: 'load:done', id: msg.id })
  } catch (err) {
    post({
      type: 'error',
      id: msg.id,
      message: (err as Error)?.message ?? String(err)
    })
  }
}

async function handleEmbed(msg: EmbedMessage): Promise<void> {
  try {
    // Named model → load-or-reuse it. Unnamed → the most recently used, which is the
    // pre-existing behaviour for any caller that has not been updated.
    const loaded = msg.modelRef ? ensurePipeline(msg.modelRef) : pipelineCache.peek()
    if (!loaded) {
      throw new Error('embed received before load — call setActive first')
    }
    const pipe = await loaded
    const out = await pipe(msg.texts, { pooling: 'mean', normalize: true })
    // The flat `data` is a stacked Float32Array of length texts.length *
    // dims. Slice into per-text vectors so the main thread doesn't have to
    // re-derive the layout.
    const [n, dim] = out.dims
    const vectors: Float32Array[] = []
    for (let i = 0; i < n; i++) {
      vectors.push(out.data.slice(i * dim, (i + 1) * dim))
    }
    post({ type: 'embed:done', id: msg.id, vectors })
  } catch (err) {
    post({
      type: 'error',
      id: msg.id,
      message: (err as Error)?.message ?? String(err)
    })
  }
}

async function handleRerank(msg: RerankMessage): Promise<void> {
  try {
    const rerank = await ensureReranker(msg.modelRef, msg.dtype)
    const scores = await rerank(msg.query, msg.passages)
    post({ type: 'rerank:done', id: msg.id, scores })
  } catch (err) {
    post({
      type: 'error',
      id: msg.id,
      message: (err as Error)?.message ?? String(err)
    })
  }
}

async function handleNli(msg: NliMessage): Promise<void> {
  try {
    const nli = await ensureNli(msg.modelRef, msg.dtype)
    const scores = await nli(msg.premises, msg.hypotheses, msg.entailmentIndex)
    post({ type: 'nli:done', id: msg.id, scores })
  } catch (err) {
    post({
      type: 'error',
      id: msg.id,
      message: (err as Error)?.message ?? String(err)
    })
  }
}

parentPort.on('message', (e: { data: InboundMessage }) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object' || typeof (msg as { type: string }).type !== 'string') return
  switch (msg.type) {
    case 'load':
      void handleLoad(msg)
      break
    case 'embed':
      void handleEmbed(msg)
      break
    case 'rerank':
      void handleRerank(msg)
      break
    case 'nli':
      void handleNli(msg)
      break
    case 'dispose':
      pipelineCache.clear()
      rerankerCache.clear()
      nliCache.clear()
      break
  }
})

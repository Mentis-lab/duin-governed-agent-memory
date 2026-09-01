// Embeddings model catalogue. Parallel to MODEL_CATALOG in
// `providers/registry.ts` but for local on-device embedders.
//
// Selection criteria (LAMPREY_RAG_PLAN.md §2.3):
//   - default: bge-small-en-v1.5 — 384 dims, ~33 MB, strong MTEB scores,
//     MIT-compatible license, mean-pool + L2-normalize friendly.
//   - alternate: all-MiniLM-L6-v2 — 384 dims, ~23 MB, fastest, slightly
//     weaker on paraphrase. Auto-selected on machines with <8 GB RAM.

export interface EmbedderInfo {
  id: string
  name: string
  dimensions: number
  approxBytes: number
  /** HF model id passed to transformers.js's `pipeline()`. */
  modelRef: string
  license?: string
  description?: string
  /** Instruction prefixes some models (the E5 family) REQUIRE for good retrieval:
   *  passages are embedded with `passagePrefix`, queries with `queryPrefix`. The
   *  prefix is applied ONLY to the embed input, never to the stored text or the
   *  lexical leg. Omitted for models that don't use them (BGE).
   *
   *  WHERE THEY ACTUALLY APPLY: the brain's own notes index
   *  (local-brain/index-store.ts) prefixes BOTH sides and always has. The RAG
   *  library leg does NOT — it embeds passages and queries verbatim
   *  (`kind: 'none'`). That is deliberate, not an oversight: existing collections'
   *  passages are stored unprefixed and there is no collection-level reindex to
   *  re-embed them, so turning prefixes on for the library would compare prefixed
   *  queries against unprefixed passages — the asymmetry E5 handles worst.
   *  Symmetric-and-slightly-under-tuned beats asymmetric-and-mis-ranked. Turning
   *  it on for the library needs a collection reindex to land with it. */
  queryPrefix?: string
  passagePrefix?: string
}

export const EMBEDDING_CATALOG: readonly EmbedderInfo[] = [
  {
    id: 'bge-small-en-v1.5',
    name: 'BGE Small English v1.5',
    dimensions: 384,
    approxBytes: 33 * 1024 * 1024,
    modelRef: 'Xenova/bge-small-en-v1.5',
    license: 'MIT',
    description:
      'Default embedder. Strong MTEB scores, balanced speed/quality, mean-pool + L2-normalize.'
  },
  {
    id: 'all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2',
    dimensions: 384,
    approxBytes: 23 * 1024 * 1024,
    modelRef: 'Xenova/all-MiniLM-L6-v2',
    license: 'Apache-2.0',
    description:
      'Fastest option; slightly weaker on paraphrase. Auto-selected on low-RAM machines.'
  },
  {
    id: 'multilingual-e5-small',
    name: 'Multilingual E5 Small',
    dimensions: 384,
    approxBytes: 118 * 1024 * 1024,
    modelRef: 'Xenova/multilingual-e5-small',
    license: 'MIT',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    description:
      'Multilingual (100+ languages incl. Chinese) — fixes weak CN/mixed-vault recall the ' +
      'English-only default has. 384-dim (same vec width as the default, so switching only ' +
      'needs a reindex). Wants query:/passage: prefixes — applied on the brain index, ' +
      'not on the library index (see queryPrefix above).'
  },
  {
    id: 'bge-m3',
    name: 'BGE-M3 (multilingual, frontier)',
    dimensions: 1024,
    approxBytes: 569 * 1024 * 1024, // q8 model_quantized.onnx (the worker loads q8)
    modelRef: 'Xenova/bge-m3',
    license: 'MIT',
    // BGE family — NO query/passage prefixes (unlike E5). Loads as q8 (worker default);
    // live-verified 2026-07-12: Xenova/bge-m3 q8 → dims 1024, L2-norm 1.000, load 2.3s from
    // cache, single-query embed 37ms on mixed CN/EN. 1024-dim vec table migrates on reindex.
    // ⚠ CPU REINDEX COST (measured 2026-07-12, ~949-doc vault): a full re-embed ran >71min and
    // PEGGED the brain process (:8799 unresponsive throughout) before it was aborted — ~20-35×
    // slower to index than e5-small on CPU. So this is NOT viable as a CPU default: query latency
    // is fine, but any embedder SWITCH or first-index blocks the server for ~an hour. Reserve for
    // GPU hosts or a future non-blocking/incremental reindex path. Kept selectable, never defaulted.
    description:
      'Frontier multilingual embedder (100+ languages, strongest CN/mixed retrieval; dense leg ' +
      'of BAAI bge-m3). 1024-dim (2.7× the default width → larger index). ~569MB q8. Query embed is ' +
      'fast, but a full reindex on CPU is ~20-35× slower than e5-small and blocks the brain server ' +
      '(~1h on a ~1k-doc vault) — GPU-only / opt-in, not a CPU default.'
  }
] as const

// Default = multilingual-e5-small, promoted 2026-07-07 after a VALID A/B on the
// dogfood vault (the earlier "no gain" verdict ran on a vectorless index —
// the embed pass was silently timing out, so it compared lexical-vs-lexical; that
// bug is fixed, see index-store batched-embed + vector self-heal). Measured recall@5:
//   bge-small-en → e5   cn-exact 1.000→1.000 · cn-paraphrase 0.077→0.231 (3×) ·
//   en 0.667→0.667 (no regression). Clears multilingualWins (cn +0.154 ≫ 0.05,
//   en drop 0.00 ≤ 0.02). Same 384-dim as the old default, so the switch just needs
//   a reindex (maybeMigrateVecTable clears the ledger → full re-embed under e5).
//   Next lever if CN-paraphrase recall must go higher: bge-m3 (1024-dim, frontier).
export const DEFAULT_EMBEDDER_ID = 'multilingual-e5-small'

export function getEmbedder(id: string): EmbedderInfo | undefined {
  return EMBEDDING_CATALOG.find((e) => e.id === id)
}

// ──────────────────── Rerankers (cross-encoder, P2) ────────────────────
// A cross-encoder scores (query, passage) PAIRS jointly — far more precise than
// the bi-encoder cosine used for recall, but too slow to run over the whole
// corpus. So it runs as a SECOND stage over the ~32 fused candidates only
// (rag/retrieve.ts), reordering them and giving the first CALIBRATED relevance
// score the pipeline can threshold on. Loaded through the same worker as the
// embedder (AutoModelForSequenceClassification), one model at a time.

export interface RerankerInfo {
  id: string
  name: string
  /** HF model id for AutoModelForSequenceClassification / AutoTokenizer. */
  modelRef: string
  /** transformers.js v3 dtype selector — 'q8' loads model_quantized.onnx. */
  dtype: 'q8' | 'fp16' | 'fp32'
  license: string
  multilingual: boolean
  approxBytes: number
  description?: string
}

// Model-availability findings (live-verified 2026-07-01, transformers.js v3):
//   ✓ Xenova/bge-reranker-base       — LOADS + runs; BAAI reranker is EN/ZH
//     bilingual → scored a CJK query cleanly (relevant 0.996 vs noise 0.00004).
//   ✗ jinaai/jina-reranker-v2-base-multilingual — "Unsupported model type: null"
//     (no transformers.js-loadable ONNX / custom arch). NOT usable as-is.
//   ? Xenova/bge-reranker-v2-m3 & Xenova/mxbai-rerank-xsmall-v1 — do NOT exist.
//     Stronger-multilingual upgrade path = onnx-community/bge-reranker-v2-m3-ONNX
//     (~570MB, external-data ONNX) — evaluate later if CJK precision needs it.
export const RERANKER_CATALOG: readonly RerankerInfo[] = [
  {
    id: 'bge-reranker-base',
    name: 'BGE Reranker Base',
    modelRef: 'Xenova/bge-reranker-base',
    dtype: 'q8',
    license: 'MIT',
    multilingual: true, // EN/ZH bilingual (BAAI) — verified on a CJK query
    approxBytes: 279 * 1024 * 1024,
    description:
      'Default cross-encoder reranker. Xenova-converted (transformers.js-compatible), ' +
      'EN/ZH bilingual — handles the Chinese-heavy vault. ~280MB q8.'
  }
] as const

export const DEFAULT_RERANKER_ID = 'bge-reranker-base'

export function getReranker(id: string): RerankerInfo | undefined {
  return RERANKER_CATALOG.find((r) => r.id === id)
}

export function getDefaultReranker(): RerankerInfo {
  return RERANKER_CATALOG.find((r) => r.id === DEFAULT_RERANKER_ID)!
}

// ──────────────────── NLI entailment models (citation SUPPORT gate, L1) ────────────────────
// A 3-class NLI cross-encoder that scores ENTAILMENT of (premise, hypothesis)
// pairs — same AutoModelForSequenceClassification load path as the reranker, but
// the head is a {contradiction, entailment, neutral} classifier instead of a
// single relevance logit. Used ONLY to verify a cited passage (premise) actually
// SUPPORTS the citing claim (hypothesis) — a MiniCheck-class support check. Loaded
// through the same worker as the embedder/reranker, one model at a time, lazily.

export interface NliInfo {
  id: string
  name: string
  /** HF model id for AutoModelForSequenceClassification / AutoTokenizer. */
  modelRef: string
  /** transformers.js v3 dtype selector — 'q8' loads model_quantized.onnx. */
  dtype: 'q8' | 'fp16' | 'fp32'
  license: string
  multilingual: boolean
  approxBytes: number
  /** The model's label order (id2label). MUST be verified per-model — a wrong
   *  entailment index silently INVERTS the gate (drops supported, keeps
   *  unsupported). deberta-v3 cross-encoder NLI is [contradiction, entailment,
   *  neutral], NOT the HF-default [entailment, neutral, contradiction]. */
  labelOrder: readonly string[]
  /** Index of the "entailment" logit in `labelOrder` (== the SUPPORT class). */
  entailmentIndex: number
  description?: string
}

// Model-selection findings (scout L1, transformers.js v3):
//   ✓ Xenova/nli-deberta-v3-small — 3-class NLI cross-encoder mirroring
//     cross-encoder/nli-deberta-v3-small. q8 (model_quantized.onnx) present,
//     ~172MB; ships the fast tokenizer.json so DeBERTa-v3 loads clean. Its
//     id2label is ['contradiction','entailment','neutral'] (entailment=1) —
//     quoted from the source card `label_mapping = ['contradiction',
//     'entailment','neutral']`. NOT the HF-default order.
//   • Lighter alt (same label order): Xenova/nli-deberta-v3-xsmall.
//   ✗ MiniCheck proper (lytang/MiniCheck-*) has no transformers.js ONNX export
//     — PyTorch-only + custom head; a 3-class NLI mapped to P(entailment) is the
//     pragmatic MiniCheck-class substitute and mirrors the reranker load path.
// NOTE: model loadability + the entailment index were NOT live-verified in this
// build (offline / default-OFF gate); the index is declarative here so a single
// edit fixes it if a live check disagrees.
export const NLI_CATALOG: readonly NliInfo[] = [
  {
    id: 'nli-deberta-v3-small',
    name: 'DeBERTa-v3 small NLI (citation SUPPORT gate)',
    modelRef: 'Xenova/nli-deberta-v3-small',
    dtype: 'q8',
    license: 'MIT',
    multilingual: false,
    approxBytes: 172 * 1024 * 1024,
    labelOrder: ['contradiction', 'entailment', 'neutral'],
    entailmentIndex: 1,
    description:
      'Citation SUPPORT gate. 3-class NLI head; reads P(entailment). Neutral is treated as ' +
      'UNSUPPORTED (only entailment = support). ~172MB q8.'
  }
] as const

export const DEFAULT_NLI_ID = 'nli-deberta-v3-small'

export function getNli(id: string): NliInfo | undefined {
  return NLI_CATALOG.find((n) => n.id === id)
}

export function getDefaultNli(): NliInfo {
  return NLI_CATALOG.find((n) => n.id === DEFAULT_NLI_ID)!
}

export function getDefault(): EmbedderInfo {
  // The catalogue is non-empty by construction; the bang documents that
  // and lets the renderer call sites treat the return as non-null.
  return EMBEDDING_CATALOG.find((e) => e.id === DEFAULT_EMBEDDER_ID)!
}

// Stage the bundled DEFAULT local models into resources/ before a release build.
//
// P0-2 (cold-start): the packaged app ships the default encoder models so first-run semantic search
// (and reranking) work with NO network. transformers.js is pointed at
// process.resourcesPath/models/transformers (localModelPath, see worker.ts) and electron-builder
// copies resources/models/transformers there (extraResources). The model files are large binaries and
// are NOT committed (see .gitignore + resources/models/README.md), so this script stages them.
//
// Staged models (keep in sync with DEFAULT_EMBEDDER_ID / DEFAULT_RERANKER_ID in
// electron/services/rag/embeddings/catalog.ts):
//   • embedder — multilingual-e5-small (~135 MB) — REQUIRED (no offline semantic search without it).
//   • reranker — bge-reranker-base (~280 MB)     — best-effort (retrieval degrades to pre-rerank
//     order if absent, so a missing reranker warns but does not fail).
//
// Source = the HuggingFace cache transformers.js already populated under the app's userData the first
// time DUIN embedded/reranked (same <owner>/<model>/… layout as localModelPath, so it's a drop-in
// copy). Override the source root with DUIN_MODEL_CACHE if your cache lives elsewhere. Idempotent +
// non-networked: it only COPIES already-downloaded models.
//
//   node scripts/prepare-bundled-models.mjs      (or: npm run prepare:models)

import { existsSync, mkdirSync, cpSync, statSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Keep in sync with DEFAULT_EMBEDDER_ID / DEFAULT_RERANKER_ID (catalog.ts). `required` models fail the
// script when absent; best-effort models only warn (the feature degrades gracefully).
const MODELS = [
  { rel: join('Xenova', 'multilingual-e5-small'), kind: 'embedder', required: true },
  { rel: join('Xenova', 'bge-reranker-base'), kind: 'reranker', required: false }
]

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function defaultCacheRoot() {
  if (process.env.DUIN_MODEL_CACHE) return process.env.DUIN_MODEL_CACHE
  const appData = process.env.APPDATA // Windows (this project's primary target)
  if (appData) return join(appData, 'DUIN', 'models', 'transformers')
  // POSIX fallback (Electron userData: ~/.config/DUIN on Linux, ~/Library/Application Support/DUIN on mac)
  const home = process.env.HOME || ''
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'DUIN', 'models', 'transformers')
  return join(home, '.config', 'DUIN', 'models', 'transformers')
}

function dirSizeBytes(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSizeBytes(p) : statSync(p).size
  }
  return total
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1)
const srcRoot = defaultCacheRoot()
const destRoot = join(repoRoot, 'resources', 'models', 'transformers')

let hardFail = false
for (const m of MODELS) {
  const src = join(srcRoot, m.rel)
  const dest = join(destRoot, m.rel)
  // The one file transformers.js must have for the q8 pipeline (worker pins dtype:'q8').
  const essential = join(src, 'onnx', 'model_quantized.onnx')
  if (!existsSync(src) || !existsSync(essential)) {
    const msg =
      `[prepare:models] ${m.kind} model not staged — missing/incomplete cache:\n  ${src}\n` +
      `  Warm it by running DUIN once (index a folder so the ${m.kind} downloads), or set DUIN_MODEL_CACHE.`
    if (m.required) {
      console.error(msg + `\n  This model is REQUIRED for offline cold start.`)
      hardFail = true
    } else {
      console.warn(msg + `\n  Best-effort: the app fetches it online on first use (retrieval still works, degraded).`)
    }
    continue
  }
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log(`[prepare:models] staged ${m.kind}: ${m.rel} (${mb(dirSizeBytes(dest))} MB)`)
}

if (hardFail) process.exit(1)
console.log(`[prepare:models] done — electron-builder bundles resources/models/transformers via extraResources.`)

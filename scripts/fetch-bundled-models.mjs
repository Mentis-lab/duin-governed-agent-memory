// fetch-bundled-models — populate a transformers.js-shaped model cache by DOWNLOADING.
//
// WHY THIS EXISTS. prepare-bundled-models.mjs stages the bundled encoders by COPYING from a
// cache that transformers.js already warmed under userData — it never downloads, deliberately,
// because on a developer machine the cache is already there and a copy is instant. A CI runner
// has no such cache, so stage-models-for-release.mjs took its documented "warn and continue"
// path and every CI installer shipped WITHOUT the encoders: first-run semantic search then
// needs a HuggingFace round-trip, which is exactly what bundling exists to avoid, and the
// downloaded build behaved differently from a locally-built one with nothing saying so.
//
// This script is the missing half: it fetches the same files into the same layout, so
// `prepare:models` finds a warm cache and its copy step works unchanged on a clean runner.
// Point DUIN_MODEL_CACHE at the destination and both scripts agree on where the cache is.
//
// Idempotent and size-checked, so it composes with actions/cache: a file already present at
// its expected size is skipped, and a truncated or interrupted download is re-fetched rather
// than silently staged. That matters more than it looks — a half-written .onnx is not a build
// failure, it is a model that loads and produces garbage.
//
//   node scripts/fetch-bundled-models.mjs
//   DUIN_MODEL_CACHE=/path/to/cache node scripts/fetch-bundled-models.mjs

import { existsSync, mkdirSync, statSync, createWriteStream, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Keep in sync with prepare-bundled-models.mjs's MODELS and with DEFAULT_EMBEDDER_ID /
// DEFAULT_RERANKER_ID in electron/services/rag/embeddings/catalog.ts.
//
// The FILE LIST is the four files a warmed cache actually holds for a q8 pipeline — the
// worker pins dtype:'q8', so `onnx/model_quantized.onnx` is the weights file that gets
// loaded and the fp32 `model.onnx` is dead weight we deliberately do not fetch. (Pulling
// the whole HF repo instead would be ~450 MB of unquantized weights nothing reads — the
// same duplication electron-builder.yml excludes the runtime cache to avoid.)
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']

const MODELS = [
  { repo: 'Xenova/multilingual-e5-small', kind: 'embedder', required: true },
  { repo: 'Xenova/bge-reranker-base', kind: 'reranker', required: false }
]

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Same resolution as prepare-bundled-models.mjs, so the two scripts cannot disagree. */
function defaultCacheRoot() {
  if (process.env.DUIN_MODEL_CACHE) return process.env.DUIN_MODEL_CACHE
  const appData = process.env.APPDATA
  if (appData) return join(appData, 'DUIN', 'models', 'transformers')
  const home = process.env.HOME || ''
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'DUIN', 'models', 'transformers')
  }
  return join(home, '.config', 'DUIN', 'models', 'transformers')
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1)

/** Content-Length for a URL, or null when the server does not give one. */
async function remoteSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    return len ? Number(len) : null
  } catch {
    return null
  }
}

/**
 * Download to a `.part` file and rename only on success. An interrupted run therefore leaves
 * a .part behind rather than a short file at the real path that the next run would skip as
 * "already present" — which is how a truncated model gets bundled.
 */
async function download(url, dest, expected) {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  rmSync(part, { force: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  const got = statSync(part).size
  if (expected != null && got !== expected) {
    rmSync(part, { force: true })
    throw new Error(`size mismatch for ${url}: expected ${expected} bytes, got ${got}`)
  }
  if (got === 0) {
    rmSync(part, { force: true })
    throw new Error(`empty download for ${url}`)
  }
  renameSync(part, dest)
  return got
}

const cacheRoot = defaultCacheRoot()
console.log(`[fetch:models] cache root: ${cacheRoot}`)

let hardFail = false
let fetched = 0
let skipped = 0

for (const m of MODELS) {
  for (const rel of FILES) {
    const url = `https://huggingface.co/${m.repo}/resolve/main/${rel}`
    const dest = join(cacheRoot, ...m.repo.split('/'), ...rel.split('/'))
    try {
      const expected = await remoteSize(url)
      if (existsSync(dest)) {
        const have = statSync(dest).size
        // No Content-Length to compare against → trust a non-empty file rather than
        // re-downloading 280 MB on every run.
        if (have > 0 && (expected == null || have === expected)) {
          skipped++
          continue
        }
        console.log(`[fetch:models] re-fetching ${m.repo}/${rel} (have ${have}, want ${expected})`)
      }
      const got = await download(url, dest, expected)
      fetched++
      console.log(`[fetch:models] ${m.repo}/${rel} — ${mb(got)} MB`)
    } catch (err) {
      const msg = `[fetch:models] ${m.kind} file failed: ${m.repo}/${rel}\n  ${err.message}`
      if (m.required) {
        console.error(`${msg}\n  This model is REQUIRED for offline cold start.`)
        hardFail = true
      } else {
        console.warn(`${msg}\n  Best-effort: the app fetches it online on first use.`)
      }
    }
  }
}

console.log(`[fetch:models] done — ${fetched} fetched, ${skipped} already present.`)
if (hardFail) process.exit(1)

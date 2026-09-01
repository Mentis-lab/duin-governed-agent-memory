import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'

// Emit `out/main/package.json` = {"type":"commonjs"} so the unpacked embeddings
// worker (loaded by worker_threads via a real fs path from app.asar.unpacked/
// out/main/) resolves as CommonJS. Without a package.json here, Node walks UP for
// the nearest one and can reach a stray ancestor (e.g. a `type:module`
// package.json in the user's HOME dir), treating the CJS worker as ESM →
// "require is not defined in ES module scope" → the worker wedges and every doc
// sticks in 'embedding'. This sibling pin makes the app immune to any ancestor
// package.json. It's also asarUnpack'd (electron-builder.yml) so it lands next
// to worker.js in the unpacked tree.
function emitWorkerCjsPackageJson() {
  return {
    name: 'emit-worker-cjs-package-json',
    writeBundle(): void {
      const dir = resolve(__dirname, 'out/main')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        resolve(dir, 'package.json'),
        JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'
      )
    }
  }
}

// Tiny inline .env loader — avoids pulling dotenv as a direct dependency
// just for build-time env loading. Only populates keys that aren't already
// set (real shell env wins). Keys with the LAMPREY_ prefix are exposed to
// the main bundle via the `define` block below; nothing here ever reaches
// the renderer process.
function loadDotEnv(): void {
  const envPath = resolve(__dirname, '.env')
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv()

// ── Build provenance ────────────────────────────────────────────────────────
// Stamp the commit + build time INTO the bundle. Without this, "which commit is
// deployed?" is only answerable by correlating app.asar's mtime against git log
// — which has already produced wrong answers about what was running.
//
// Resolved once here, at config time, so `electron-vite dev` gets a real SHA
// too, and so main and preload agree on a single timestamp. Injected as string
// literals via `define`, the same mechanism as the GitHub OAuth credentials
// below; electron/build-info.ts is the only consumer. Every git call is
// best-effort — no git on PATH, or a source tarball with no repo, degrades to
// empty strings (rendered as `unknown`) rather than failing the build.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: __dirname,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function buildProvenance(): Record<string, string> {
  // CI checks out a detached HEAD, so `rev-parse --abbrev-ref` yields "HEAD"
  // there; GitHub's own vars are authoritative when present.
  const sha = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'])
  const branch = process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  // Uncommitted changes at build time — the difference between "this IS commit
  // X" and "this is commit X plus whatever happened to be in the tree".
  const dirty = sha && git(['status', '--porcelain']) ? '1' : ''
  let version = ''
  try {
    version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version ?? ''
  } catch {
    version = ''
  }
  return {
    'process.env.LAMPREY_BUILD_SHA': JSON.stringify(sha),
    'process.env.LAMPREY_BUILD_BRANCH': JSON.stringify(branch),
    'process.env.LAMPREY_BUILD_DIRTY': JSON.stringify(dirty),
    'process.env.LAMPREY_BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'process.env.LAMPREY_BUILD_VERSION': JSON.stringify(version)
  }
}

const BUILD_PROVENANCE = buildProvenance()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), emitWorkerCjsPackageJson()],
    // Bundled GitHub OAuth App credentials. Read from the build environment
    // and replaced into the main bundle as string literals. When unset
    // (local dev without the env vars, or a fork building without the
    // GitHub Actions secrets configured) they become empty strings, which
    // the github-service falls back from to user-saved BYO credentials.
    // Renderer is NOT given these — the main bundle is the only place that
    // ever touches the secret.
    define: {
      'process.env.LAMPREY_GITHUB_CLIENT_ID': JSON.stringify(
        process.env.LAMPREY_GITHUB_CLIENT_ID ?? ''
      ),
      'process.env.LAMPREY_GITHUB_CLIENT_SECRET': JSON.stringify(
        process.env.LAMPREY_GITHUB_CLIENT_SECRET ?? ''
      ),
      ...BUILD_PROVENANCE
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          cli: resolve(__dirname, 'electron/cli.ts'),
          // The embeddings worker MUST be emitted as its own out/main/worker.js —
          // service.ts loads it at runtime via require.resolve('./worker.js').
          // Without this entry the file is never produced, require throws, and the
          // brain silently falls back to lexical-only (NO semantic vectors). This
          // had disabled vector retrieval in every packaged build.
          worker: resolve(__dirname, 'electron/services/rag/embeddings/worker.ts'),
          // OCR Tier-2 PaddleOCR inference worker — emitted as its own
          // out/main/paddle-worker.js; paddle-ocr.ts loads it at runtime via
          // require.resolve('./paddle-worker.js'). Without this entry the file is
          // never produced and the paddle engine silently falls back to tesseract.
          'paddle-worker': resolve(__dirname, 'electron/services/rag/ocr/paddle-worker.ts')
        },
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Preload needs the SAME provenance literals as main: it hands them to the
    // renderer synchronously (window.api.app.build), and a sandboxed preload has
    // no real process.env to fall back on. Deliberately only the BUILD_* keys —
    // the GitHub OAuth secrets above stay main-only.
    define: BUILD_PROVENANCE,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    resolve: {
      alias: {
        '@': resolve('src')
      }
    },
    server: {
      fs: {
        allow: [resolve(__dirname)]
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html')
        }
      }
    }
  }
})

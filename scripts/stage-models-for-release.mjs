// stage-models-for-release — the release-build gate for bundled models (cold-start E1).
//
// THE LANDMINE THIS CLOSES. `prepare:models` existed and worked, but nothing invoked it:
// `build:win` was `npm run build && electron-builder`, so `resources/models` was populated only
// if someone happened to run the script by hand. That directory is UNTRACKED and PER-WORKTREE,
// so the outcome depended on which checkout you built from — one worktree had 412 MB staged and
// a sibling had 1 MB. Build from the wrong one and the installer ships without the embedder;
// offline first-run then silently degrades to download-on-demand, which is exactly the
// experience a *downloaded* build is supposed to avoid, and nothing anywhere says so.
//
// WHY A WRAPPER RATHER THAN CALLING prepare:models DIRECTLY. prepare:models COPIES from the
// local transformers.js cache under userData — it never downloads. On a machine that has run
// DUIN and indexed a folder, that cache exists and staging succeeds. On a clean CI runner it
// does not, and prepare:models exits 1 because the embedder is REQUIRED for offline cold start.
// Wiring it in raw would therefore turn every clean-machine build into a hard failure, which is
// how a well-meaning gate gets deleted a week later.
//
// So: stage when we can, and be LOUD about what shipped either way. A release build that
// silently omits the model is the failure mode; a build that says "no models staged" in its own
// output is recoverable. Set DUIN_REQUIRE_BUNDLED_MODELS=1 to make the omission fatal — that is
// the flag a real release pipeline should set.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staged = join(root, 'resources', 'models', 'transformers')

function dirBytes(p) {
  if (!existsSync(p)) return 0
  let total = 0
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name)
    total += e.isDirectory() ? dirBytes(f) : statSync(f).size
  }
  return total
}

const before = dirBytes(staged)
let stagedOk = false
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'prepare-bundled-models.mjs')], {
    stdio: 'inherit',
    cwd: root
  })
  stagedOk = true
} catch {
  // prepare:models already explained itself on stderr; the summary below is what matters.
}

const after = dirBytes(staged)
const mb = (n) => (n / 1024 / 1024).toFixed(0)

if (after > 0) {
  const note = after === before ? 'already staged' : `staged (was ${mb(before)} MB)`
  console.log(`[release-models] resources/models/transformers: ${mb(after)} MB — ${note}`)
  if (!stagedOk) {
    console.warn(
      '[release-models] WARNING: the required model could not be refreshed, but a previous ' +
        'staging is present. The installer will bundle THAT. Verify it is current.'
    )
  }
} else {
  const msg =
    '[release-models] NO MODELS STAGED. This installer will NOT work offline on first run — ' +
    'it will fall back to downloading the embedder on demand.\n' +
    '  Fix: run DUIN once and index a folder (warms the transformers cache), then rebuild.\n' +
    '  Or point DUIN_MODEL_CACHE at a warmed cache.'
  if (process.env.DUIN_REQUIRE_BUNDLED_MODELS === '1') {
    console.error(msg + '\n  Failing the build because DUIN_REQUIRE_BUNDLED_MODELS=1.')
    process.exit(1)
  }
  console.warn(msg + '\n  Continuing (set DUIN_REQUIRE_BUNDLED_MODELS=1 to make this fatal).')
}

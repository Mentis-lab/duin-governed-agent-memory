// 2026-07-25 — regression lock for the verify:proof native-SQLite probe.
//
// The bug this pins: the gate probed for the native DB with
// `node -e "require('better-sqlite3')"`. better-sqlite3 resolves to a plain JS
// wrapper and defers the dlopen of `better_sqlite3.node` until the first
// `new Database(...)`, so that require exits 0 even when the binding is built
// for a different NODE_MODULE_VERSION. The gate reported "native suites run"
// while the tests' own guard (`new BetterSqlite3(':memory:')` in a try/catch)
// threw and skipped them — a silent loss of the native-DB coverage, which is
// exactly the v0.9.2 P0 shape the accounting block exists to prevent.
//
// Three locks, weakest to strongest:
//   1. the fallacy itself is real (a lazy module passes require-only, fails on use)
//   2. the shipped script uses the actual-use form, not the require-only form
//   3. the gate's verdict AGREES with the guard the test files actually use

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

const repoRoot = join(__dirname, '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'verify-proof.cjs')

function node(source: string, cwd: string): number {
  return spawnSync(process.execPath, ['-e', source], { cwd, encoding: 'utf8', timeout: 60_000 })
    .status as number
}

describe('verify:proof native-sqlite probe — lazy-require fallacy', () => {
  it('a lazily-binding module passes a require-only probe but fails an actual-use probe', () => {
    // Stand-in for better-sqlite3: requiring it is fine, constructing it dlopens
    // (here: throws the very error a NODE_MODULE_VERSION mismatch produces).
    const dir = mkdtempSync(join(tmpdir(), 'lazy-binding-'))
    try {
      const mod = join(dir, 'lazy-binding.cjs').replace(/\\/g, '/')
      writeFileSync(
        mod,
        [
          'function LazyDatabase() {',
          "  const e = new Error(\"The module was compiled against a different Node.js version using NODE_MODULE_VERSION 133. This version of Node.js requires NODE_MODULE_VERSION 137\")",
          "  e.code = 'ERR_DLOPEN_FAILED'",
          '  throw e',
          '}',
          'module.exports = LazyDatabase',
          ''
        ].join('\n'),
        'utf8'
      )

      // The broken probe shape: require alone. Reports success.
      expect(node(`require('${mod}')`, dir)).toBe(0)

      // The honest probe shape: open a database. Reports the truth.
      expect(node(`const D = require('${mod}'); new D(':memory:')`, dir)).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verify-proof.cjs probes by opening a database, not by requiring the module', () => {
    const src = readFileSync(scriptPath, 'utf8')
    // Must construct a Database in the spawned child.
    expect(src).toMatch(/new D\(':memory:'\)|new Database\(':memory:'\)/)
    // And must not fall back to a bare require-only probe as its verdict.
    expect(src).not.toMatch(/\[\s*'-e'\s*,\s*"require\('better-sqlite3'\)"\s*\]/)
  })

  it("the gate's verdict matches the guard the test files themselves use", () => {
    // This is the assertion that would have caught the bug: HAS_NATIVE_SQLITE /
    // nativeOk() in ~20 suites is exactly this expression. If the gate disagrees
    // with it, the gate is reporting coverage that does not exist.
    let guardSaysUsable: boolean
    try {
      const probe = new BetterSqlite3(':memory:')
      probe.prepare('select 1 as ok').get()
      probe.close()
      guardSaysUsable = true
    } catch {
      guardSaysUsable = false
    }

    const run = spawnSync(process.execPath, [scriptPath, '--list-native-skips'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000
    })
    const output = `${run.stdout}\n${run.stderr}`

    const gateSaysUsable = /native-sqlite probe: OPENED an in-memory database/.test(output)
    const gateSaysDark = /DARK SUITES/.test(output)

    expect(gateSaysUsable || gateSaysDark).toBe(true)
    expect(gateSaysUsable).toBe(guardSaysUsable)
    expect(gateSaysDark).toBe(!guardSaysUsable)
  })

  it('the dark case is unmistakable and names the lazy-load trap', () => {
    const run = spawnSync(process.execPath, [scriptPath, '--list-native-skips'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000
    })
    const output = `${run.stdout}\n${run.stderr}`
    if (!/DARK SUITES/.test(output)) return // binding usable here; nothing to report

    expect(output).toContain('SKIPPED, not passed')
    expect(output).toContain('electron/services/schema-init.test.ts')
    expect(output).toMatch(/require\('better-sqlite3'\) alone still EXITS 0/)
    // Advisory by default — the operator's local run must not turn red.
    expect(run.status).toBe(0)
  })

  it('DUIN_REQUIRE_NATIVE_SQLITE makes a dark run fatal', () => {
    const run = spawnSync(process.execPath, [scriptPath, '--list-native-skips'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DUIN_REQUIRE_NATIVE_SQLITE: '1' }
    })
    const output = `${run.stdout}\n${run.stderr}`
    if (/DARK SUITES/.test(output)) {
      expect(run.status).toBe(1)
      expect(output).toContain('FATAL')
    } else {
      // Binding usable — the opt-in gate must stay green.
      expect(run.status).toBe(0)
    }
  })
})

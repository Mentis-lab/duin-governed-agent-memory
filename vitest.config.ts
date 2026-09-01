import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Prompt 12: coverage is enabled with a low floor (baseline minus 2pp) as a
// regression guard, NOT a quality target. The threshold catches "someone
// deleted a major test file" or "a refactor stopped exercising a service"
// — it does NOT push every PR to push the number up. The floor is global,
// not per-file. Raising the floor is a separate, intentional doc-only
// commit; renderer code (most of `src/`) currently shows 0% because the
// test environment is node-only — jsdom-backed renderer tests are the
// scope of Prompt 5 of the audit-remediation roster.
export default defineConfig({
  // Match the app's `@` -> src path alias so tests can import helpers that live
  // alongside renderer components (the components themselves use `@` internally).
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // electron is CommonJS; vitest imports it as ESM, so `import { BrowserWindow } from 'electron'`
      // fails at LOAD time ("Named export 'BrowserWindow' not found") and takes the whole suite file
      // with it before any test runs. Point it at an inert ESM stub so a transitive electron import
      // is never the reason a suite cannot start. Per-file `vi.mock('electron', …)` still wins, so
      // tests that need specific behaviour are unaffected.
      electron: fileURLToPath(new URL('./test/stubs/electron.ts', import.meta.url)),
      // Same failure, one level out: this package re-exports electron's CJS bindings, so the bad
      // import is inside the dependency and the `electron` alias above cannot reach it.
      '@electron-toolkit/utils': fileURLToPath(
        new URL('./test/stubs/electron-toolkit-utils.ts', import.meta.url)
      )
    }
  },
  test: {
    include: ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Was 15_000, and that budget silently expired when the data-loss audit adopted
    // fsync. `atomicWriteDurable` fsyncs the tmp fd AND the parent directory on every
    // call, so a test that drives a capped ledger to its limit now pays ~2 fsyncs per
    // iteration: action-ledger's C3 makes 505 recordAction calls (MAX_ACTIONS 500 + 5)
    // against a growing JSON, and memory-store's index test writes 210 entries. Both
    // pass comfortably alone (~4s) and both TIMED OUT under the full suite's parallel
    // load, where every worker competes for the same physical disk — 11/12/13 failures
    // across consecutive runs, different files each time.
    //
    // Nothing was wrong with those tests, and fsync is not observable in-process (no
    // unit test can power-fail a machine), so neither the tests nor the durability were
    // the thing to change: the BUDGET was calibrated before the writes got durable.
    // 45s restores headroom under contention while still catching a genuinely hung test.
    // If this needs raising again, prefer making a test stop doing hundreds of durable
    // writes over another bump — durable-write.ts notes ~20 more writers are queued to
    // adopt fsync, so this cost is going to spread.
    testTimeout: 45_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      include: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'electron/preload.ts',
        'electron/main.ts',
        'electron/ipc/index.ts',
        'out/**',
        'dist/**',
        'scripts/**',
        'resources/**',
        'node_modules/**'
      ],
      // Floors captured during Prompt 12 (baseline 15.63 / 14.58 / 11.85 /
      // 16.01 %, rounded down then minus 2pp). Bump these in a deliberate
      // commit if the floor moves up.
      thresholds: {
        statements: 13,
        branches: 12,
        functions: 9,
        lines: 14
      }
    }
  }
})

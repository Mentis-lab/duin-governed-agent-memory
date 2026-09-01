// SP-9 (Sweet Spot Phase, 2026-06-10) — D7 regression lock. verify:proof must
// surface the better-sqlite3 ABI-skip cohort explicitly so a silent test loss
// is visible at gate time (the v0.9.2 lesson). Exercises the script's
// `--list-native-skips` mode end-to-end.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const repoRoot = join(__dirname, '..', '..')

describe('SP-9 verify:proof native-skip accounting (D7)', () => {
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'verify-proof.cjs'), '--list-native-skips'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 }
  )
  const output = `${run.stdout}\n${run.stderr}`

  it('exits 0 in accounting-only mode', () => {
    expect(run.status).toBe(0)
  })

  // 2026-07-25 — these expectations were rewritten with the probe fix. The old
  // wording ("N ABI-guarded test file(s) run their native-DB suites") asserted
  // something the script could not know, and this test happily passed on it.
  it('names the ABI-gated cohort either way (usable or dark)', () => {
    expect(output).toMatch(
      /native-sqlite probe: OPENED an in-memory database|DARK SUITES — better-sqlite3 native binding is NOT usable/
    )
  })

  it('counts a non-zero gated cohort (schema-init et al. exist)', () => {
    const match = output.match(/(\d+) test file\(s\) gate suites on the native binding/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThan(0)
  })

  it('when the binding is unusable, the cohort is listed file-by-file', () => {
    if (/DARK SUITES/.test(output)) {
      expect(output).toContain('schema-init.test.ts')
      expect(output).toContain('SKIPPED, not passed')
    } else {
      // Binding usable under this Node — nothing to list; the positive line
      // already asserted above is the contract.
      expect(output).toContain('OPENED an in-memory database')
    }
  })
})

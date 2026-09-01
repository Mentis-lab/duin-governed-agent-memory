// no-bare-relative-require.test.ts — a lazy load written as `require('../x')` does
// not survive bundling, so it is a silent way to delete a safety mechanism.
//
// THE MECHANISM, verified against the shipped artifact rather than argued from
// theory. electron-vite emits a bare `require()` call VERBATIM into the main bundle;
// out/main/index.js contains, character for character:
//
//     function defaultRequestApproval(summary, tool) {
//       const { requestOperatorApproval: requestOperatorApproval2, ... } =
//         require("../proactive/approval-roundtrip");
//
// That bundle lives at out/main/index.js and out/ holds only main/, preload/ and
// renderer/ — so at runtime '../proactive/approval-roundtrip' resolves to
// out/proactive/approval-roundtrip, which does not exist, and the call throws.
//
// WHY THAT IS A SAFETY PROBLEM AND NOT A BUILD NIT. Every one of these sites is
// wrapped in a try/catch, because a lazy load is written defensively by habit. So the
// throw is caught and degraded to a console.debug, and the surrounding feature reports
// success while doing nothing. In this directory alone that had already silently
// disabled three things:
//   * the operator-approval roundtrip for irreversible external actions (fail-closed,
//     so nothing unsafe escaped — but the approval could never be asked),
//   * the ACT audit sink, which module invariant (d) of external-action.ts claims
//     writes "every external side effect (and every refusal)" to the event spine,
//   * gcal-write's field-clear journal, which is the stated precondition for allowing
//     a destructive clear of text Google keeps no revision history for.
// All three were EXISTS-not-FIRED, and every test in this directory stayed green
// throughout, because tests inject these seams and never exercise the default.
//
// `import()` is statically analysed by the bundler and emitted as a real chunk
// reference, so it keeps the laziness and actually resolves. Where the caller is
// synchronous and cannot await, either import statically (when the dependency is
// light) or fire-and-forget the import (when the sink is best-effort by contract).
//
// SCOPE: this directory only. The same pattern exists elsewhere in electron/services
// — a scan at the time of writing found relative-require specifiers in
// services/, services/brain/, services/proactive/, services/governance/ and
// services/agent-bench/, of which 9 distinct specifiers were confirmed present
// verbatim in the shipped bundle. Those files belong to other lanes; widening this
// guard would fail on code this lane must not touch and would block their commits.
// It is reported as a cross-lane finding instead.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `require('./x')` or `require('../x')` — a RELATIVE specifier. A require of a bare
 *  npm package ('fs', 'better-sqlite3') is left alone: the bundler externalises those
 *  and they resolve fine at runtime. */
const BARE_RELATIVE_REQUIRE = /\brequire\(\s*['"]\.\.?\//

function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
}

describe('no lazy load in act/ is written as a bare relative require', () => {
  it('every source file uses import() or a static import instead', () => {
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      const lines = readFileSync(join(HERE, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        // Skip comment lines: this file's own explanation, and the block comments in
        // external-action.ts / gcal-write.ts that quote the broken form on purpose,
        // must not trip the guard they document.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        if (BARE_RELATIVE_REQUIRE.test(line)) offenders.push(`${file}:${i + 1}  ${code}`)
      })
    }

    expect(
      offenders,
      'A bare relative require() is emitted verbatim into out/main/index.js and cannot ' +
        'resolve there. Use `await import(...)`, a static import, or a fire-and-forget ' +
        '`void import(...).then(...)` for a synchronous best-effort sink.'
    ).toEqual([])
  })

  it('the guard can actually see an offender (it is not vacuously green)', () => {
    // A scanner that silently matched nothing — wrong directory, wrong regex, no files
    // — would pass forever while proving nothing. Pin both halves.
    expect(sourceFiles().length).toBeGreaterThan(5)
    expect(BARE_RELATIVE_REQUIRE.test("const { recordEvent } = require('../event-log')")).toBe(true)
    expect(BARE_RELATIVE_REQUIRE.test("const x = require('./sibling')")).toBe(true)
    // …and does not fire on the forms that are fine.
    expect(BARE_RELATIVE_REQUIRE.test("const fs = require('fs')")).toBe(false)
    expect(BARE_RELATIVE_REQUIRE.test("await import('../event-log')")).toBe(false)
  })
})

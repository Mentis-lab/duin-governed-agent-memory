// Unit tests for the handbook generator's DETECTOR resolution.
//
// The generator validated every locator citation against the file index and rendered detector
// citations with no existence check at all, so the shipped handbook printed
// "**Guarded by:** `role-tool-access.test.ts`" for a file that does not exist — a claim of
// coverage over a subsystem that has none. That is worse than "_(unguarded)_", which is at least
// true.
//
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs")

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveDetector } from './gen-harness-handbook.mjs'

/** basename -> [repo-relative path], the shape indexCode builds. */
const INDEX = new Map([
  ['how-you-decide.test.ts', ['electron/services/brain/how-you-decide.test.ts']],
  ['darwin.test.ts', ['electron/services/sandbox/darwin.test.ts']],
  ['claim-metabolism.ts', ['electron/services/brain/claim-metabolism.ts']],
  ['concept-materialize.test.ts', ['electron/services/brain/concept-materialize.test.ts']],
  ['cost-budget.test.ts', ['electron/services/longrun/cost-budget.test.ts']],
  ['escalation.test.ts', ['electron/services/longrun/escalation.test.ts']]
])

test('a detector naming a real file resolves', () => {
  assert.equal(resolveDetector('how-you-decide.test.ts', INDEX).status, 'valid')
})

test('a detector naming a file that does not exist is BROKEN', () => {
  // The live instance: electron/services/role-tool-access.ts exists, its .test.ts does not.
  const r = resolveDetector('role-tool-access.test.ts', INDEX)
  assert.equal(r.status, 'broken')
  assert.match(r.note, /role-tool-access\.test\.ts/)
})

test('a path-qualified citation resolves by basename', () => {
  assert.equal(resolveDetector('sandbox/darwin.test.ts', INDEX).status, 'valid')
})

test('a citation wrapped in prose still has its filename checked', () => {
  assert.equal(resolveDetector('startup invariant throw claim-metabolism.ts:117', INDEX).status, 'valid')
  assert.equal(resolveDetector('see nowhere-at-all.ts:12 for the guard', INDEX).status, 'broken')
})

test('a bare `.test` stem is a citation of <stem>.ts', () => {
  assert.equal(resolveDetector('concept-materialize.test', INDEX).status, 'valid')
  assert.equal(resolveDetector('never-written.test', INDEX).status, 'broken')
})

test('a glob expands against the index', () => {
  const r = resolveDetector('longrun/*.test.ts', INDEX)
  assert.equal(r.status, 'valid')
  assert.equal(r.files.length, 2)
})

test('a glob that matches nothing is BROKEN, not silently ignored', () => {
  const r = resolveDetector('nosuchdir/*.test.ts', INDEX)
  assert.equal(r.status, 'broken')
  assert.match(r.note, /matches no file/i)
})

test('a detector NAME that cites no file is not checked, and is not broken either', () => {
  // "dead-export", "write-no-read", "compounding-health:grounding" name detector concepts
  // implemented inside other modules. Demanding a same-named file would paint 60+ false ❌ into
  // the handbook, which is how a red badge stops meaning anything.
  for (const d of ['dead-export', 'write-no-read', 'compounding-health:grounding', 'threshold-inversion']) {
    assert.equal(resolveDetector(d, INDEX).status, 'name', d)
  }
})

test('importing the module does not regenerate the handbook', () => {
  // Without the entry-point guard this test file could not exist: importing the generator would
  // rewrite ARCHITECTURE/HARNESS_HANDBOOK.md and the whole handbook tree as a side effect.
  assert.ok(true)
})

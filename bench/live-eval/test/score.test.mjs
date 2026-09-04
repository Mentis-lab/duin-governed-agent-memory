// score.test.mjs — the scorer port keeps vault_eval.py semantics (bench/vault-eval/vault_eval.py
// check / score_one / aggregate) and l1_score.py's citation resolution.
// Run: node --test bench/live-eval/test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, scoreOne, aggregate, citedPaths, buildVaultIndex, resolveCitation } from '../lib/score.mjs'

test('check: any_of is a case-insensitive substring match, none_of is its negation', () => {
  assert.equal(check('The launch moved to 2026-10-15.', { any_of: ['october 15', '2026-10-15'] }), true)
  assert.equal(check('nothing here', { any_of: ['2026-10-15'] }), false)
  assert.equal(check('safe text', { none_of: ['$640'] }), true)
  assert.equal(check('rate is $640', { none_of: ['$640'] }), false)
  assert.equal(check('anything', { label: 'no lists' }), true)
})

test('scoreOne: criteria + must_not, empty answer scores zero', () => {
  const item = {
    id: 'Q',
    q: 'q',
    dimensions: ['temporal'],
    criteria: [{ label: 'a', any_of: ['x'], source: 'vault' }, { label: 'b', any_of: ['y'], source: 'inferred' }],
    must_not: [{ label: 'c', none_of: ['z'], source: 'operator' }]
  }
  const s = scoreOne(item, 'x and y')
  assert.equal(s.passed, 3)
  assert.equal(s.total, 3)
  assert.equal(s.rate, 1)
  assert.equal(s.empty, false)
  const half = scoreOne(item, 'x with z')
  assert.equal(half.passed, 1)
  assert.equal(half.rate, 0.333)
  const empty = scoreOne(item, '   ')
  assert.equal(empty.passed, 0)
  assert.equal(empty.rate, 0)
  assert.equal(empty.empty, true)
})

test('aggregate: overall, ratified-only (operator|vault) and by-dimension means', () => {
  const a = scoreOne({ id: '1', q: '', dimensions: ['temporal', 'privacy'], criteria: [{ label: 'a', any_of: ['x'], source: 'vault' }, { label: 'b', any_of: ['nope'], source: 'inferred' }] }, 'x')
  const b = scoreOne({ id: '2', q: '', dimensions: ['temporal'], criteria: [{ label: 'c', any_of: ['y'], source: 'operator' }] }, 'y')
  const agg = aggregate([a, b])
  assert.equal(agg.questions, 2)
  assert.equal(agg.criteria_passed, 2)
  assert.equal(agg.criteria_total, 3)
  assert.equal(agg.overall, 0.667)
  assert.equal(agg.ratified_only, 1)
  assert.equal(agg.ratified_n, 2)
  assert.deepEqual(agg.by_dimension, { privacy: 0.5, temporal: 0.75 })
  assert.equal(aggregate([]).overall, 0)
  assert.equal(aggregate([]).ratified_only, null)
})

test('citedPaths + resolveCitation against a vault on disk', () => {
  const vault = mkdtempSync(join(tmpdir(), 'live-eval-vault-'))
  try {
    mkdirSync(join(vault, 'Decisions'), { recursive: true })
    mkdirSync(join(vault, '.trash'), { recursive: true })
    writeFileSync(join(vault, 'Decisions', '2026-05-14-switch-to-lora.md'), '# x')
    writeFileSync(join(vault, '.trash', 'ghost.md'), '# never indexed')
    const index = buildVaultIndex(vault)
    assert.equal(index.has('2026-05-14-switch-to-lora'), true)
    assert.equal(index.has('ghost'), false)
    const answer = 'See [[2026-05-14-switch-to-lora|the decision]] and `Decisions/2026-05-14-switch-to-lora.md`; cited as: Weekly/2026-W99.md and [[missing-note]].'
    const cites = citedPaths(answer)
    assert.deepEqual(
      cites.map((c) => `${c.kind}:${c.ref}`),
      ['wikilink:2026-05-14-switch-to-lora', 'wikilink:missing-note', 'path:Decisions/2026-05-14-switch-to-lora.md', 'path:Weekly/2026-W99.md']
    )
    const statuses = cites.map((c) => resolveCitation(c, { vaultDir: vault, index }))
    assert.deepEqual(statuses, ['exists', 'missing', 'exists', 'missing'])
    assert.equal(resolveCitation({ kind: 'path', ref: 'Elsewhere/2026-05-14-switch-to-lora.md' }, { vaultDir: vault, index }), 'basename-only')
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
})

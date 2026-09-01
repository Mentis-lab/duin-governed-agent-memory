// Pins the bundle-safety detector. Run by `npm run test:teeth` (node --test scripts/*.test.mjs).
//
// The cases below are the real ones. Every "should flag" string is copied from the source that
// actually shipped broken on 2026-08-04; every "should not flag" string is a false positive the
// first two drafts of this lint produced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRelativeRequires } from './bundle-safety-lint.mjs'

const specs = (src) => findRelativeRequires(src).map((h) => h.spec)

test('flags the eight sites that shipped broken', () => {
  const src = `
    const { computeAliasCandidatesReport } = require('./entity-resolver')
    const { embedForRecall } = require('../local-brain/index-store')
    const { runEntityAutoMergeTick } = require('./entity-automerge-tick')
    const { runDecisionLoop } = require('./decision-loop')
    const { readSettings } = require('../settings-helper')
    const { recordEvent } = require('../event-log')
  `
  assert.deepEqual(specs(src), [
    './entity-resolver',
    '../local-brain/index-store',
    './entity-automerge-tick',
    './decision-loop',
    '../settings-helper',
    '../event-log'
  ])
})

test('reports the true line number', () => {
  const src = ['// header', '', 'const x = 1', "const y = require('./z')"].join('\n')
  const hits = findRelativeRequires(src)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 4)
})

test('ignores a require quoted in a line comment', () => {
  assert.deepEqual(specs("// the former lazy `require('./plugin-loader')` broke under the bundle"), [])
})

test('ignores a require quoted in a block comment', () => {
  const src = `/**
   *  FIRE-AND-FORGET import(), not require(). This was a bare
   *  require('../event-log'), which the bundler copies verbatim.
   */
  const ok = 1`
  assert.deepEqual(specs(src), [])
})

test('ignores require inside a double-quoted string (agent-bench fixture source)', () => {
  // tasks.ts embeds whole JS programs as string literals and writes them to disk for a
  // sandboxed agent to execute. Three of these were the lint's first false positives.
  const src = 'const program = "const { add } = require(\'./add.js\')\\nif (add(2,3) !== 5) process.exit(1)\\n"'
  assert.deepEqual(specs(src), [])
})

test('ignores require inside a template literal', () => {
  const src = 'const program = `const { sub } = require("./sub.js")\nprocess.exit(0)\n`'
  assert.deepEqual(specs(src), [])
})

test('does not flag node builtins or bare package names', () => {
  const src = `
    const { readFileSync } = require('node:fs')
    const { join } = require('path')
    const matter = require('gray-matter')
  `
  assert.deepEqual(specs(src), [])
})

test('does not flag import() — the fix itself must pass', () => {
  const src = `
    const { runEntityAutoMergeTick } = await import('./entity-automerge-tick')
    void import('../event-log').then(({ recordEvent }) => recordEvent({}))
  `
  assert.deepEqual(specs(src), [])
})

test('does not flag a method named require on some object', () => {
  assert.deepEqual(specs("mod.require('./x'); myRequire('./y')"), [])
})

test('handles escaped quotes without losing track of string state', () => {
  const src = `const s = 'it\\'s fine'\nconst z = require('./real')`
  assert.deepEqual(specs(src), ['./real'])
})

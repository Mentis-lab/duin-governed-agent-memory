// Pins the loop registry and the content probes. Run by `npm run test:teeth`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOOPS, NESTED } from './loop-liveness-lint.mjs'

test('every registered loop declares the fields a probe needs', () => {
  for (const l of LOOPS) {
    assert.ok(l.id, 'id')
    assert.ok(l.starter, `${l.id}: starter`)
    assert.ok(l.module, `${l.id}: module`)
    assert.ok(l.gate, `${l.id}: gate — an undocumented gate is how a dark loop looks healthy`)
    // `writes` may be null, but only deliberately: the note must then say where it does write.
    if (l.writes === null) assert.ok(l.note !== undefined, `${l.id}: null writes needs a note`)
  }
})

test('loop ids and starters are unique', () => {
  assert.equal(new Set(LOOPS.map((l) => l.id)).size, LOOPS.length)
  assert.equal(new Set(LOOPS.map((l) => l.starter)).size, LOOPS.length)
})

test('a probeable loop declares a quiet window, and vice versa', () => {
  for (const l of LOOPS) {
    if (l.quietAfterMs != null) assert.ok(l.writes, `${l.id}: window without an artifact`)
  }
})

test('autonomy-gated loops are NOT mtime-probed — quiet is their correct state', () => {
  // Probing a dark-by-design loop for staleness would cry wolf on every run, and a gate that
  // cries wolf gets ignored, which is how the real one stayed invisible.
  for (const l of LOOPS) {
    if (/backgroundAutonomy/.test(l.gate)) {
      assert.equal(l.quietAfterMs, null, `${l.id}: autonomy-gated loops must not have a window`)
    }
  }
})

// ── the probe that would have caught the real failure ──
const automerge = NESTED.find((n) => n.artifact === 'entity-aliases.json')

test('flags an alias file where nothing was machine-written', () => {
  // The exact live shape on 2026-08-04: 14 hand-authored groups, no `source` anywhere.
  const raw = JSON.stringify([
    { canonicalId: 'org:acme', canonical: 'Acme', aliases: ['acme'] },
    { canonicalId: 'person:x', canonical: 'X', aliases: ['x'] }
  ])
  const r = automerge.probe(raw)
  assert.equal(r.ok, false)
  assert.match(r.why, /NONE machine-written/)
})

test('accepts an alias file once the automerge has stamped a group', () => {
  const raw = JSON.stringify([
    { canonicalId: 'org:acme', canonical: 'Acme', aliases: ['acme'] },
    { canonicalId: 'topic:y', canonical: 'Y', aliases: ['y'], source: 'auto' }
  ])
  assert.equal(automerge.probe(raw).ok, true)
})

test('accepts a group stamped by the cross-kind collapse', () => {
  const raw = JSON.stringify([
    { canonicalId: 'org:b', canonical: 'B', aliases: ['b'], source: 'auto-kind' }
  ])
  assert.equal(automerge.probe(raw).ok, true)
})

test('a human-confirmed group does NOT count as the machine having run', () => {
  const raw = JSON.stringify([
    { canonicalId: 'org:c', canonical: 'C', aliases: ['c'], source: 'human' }
  ])
  assert.equal(automerge.probe(raw).ok, false)
})

test('malformed or non-array alias files are reported, not silently passed', () => {
  assert.equal(automerge.probe('{not json').ok, false)
  assert.equal(automerge.probe('{}').ok, false)
})

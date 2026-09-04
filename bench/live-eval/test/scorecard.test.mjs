// scorecard.test.mjs — lane aggregation excludes skipped and unverified probes from the score
// and the summary renders every lane. Run: node --test bench/live-eval/test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateLanes, lanesBelow, renderSummary, LANES } from '../lib/scorecard.mjs'

const probes = [
  { id: 'admission.a', lane: 'L4', pass: true },
  { id: 'admission.b', lane: 'L4', pass: true },
  { id: 'governance.c', lane: 'L4', pass: false },
  { id: 'governance.d', lane: 'L4', pass: null, skipped: true, evidence: 'no key' },
  { id: 'engines.failover', lane: 'L6', pass: false, unverified: true, evidence: {} },
  { id: 'engines.x', lane: 'L6', pass: true },
  { id: 'brain.Q1', lane: 'L1', pass: true },
  { id: 'brain.Q2', lane: 'L1', pass: false },
  { id: 'brain.Q3', lane: 'L1', pass: false },
  { id: 'stray', lane: 'L9', pass: true }
]

test('aggregateLanes: score = 10 × passed/total over measured probes only', () => {
  const lanes = aggregateLanes(probes)
  assert.deepEqual(Object.keys(lanes), Object.keys(LANES))
  assert.equal(lanes.L4.total, 3)
  assert.equal(lanes.L4.passed, 2)
  assert.equal(lanes.L4.score, 6.7)
  assert.equal(lanes.L4.skipped, 1)
  assert.deepEqual(lanes.L4.failed, ['governance.c'])
  assert.equal(lanes.L6.total, 1)
  assert.equal(lanes.L6.score, 10)
  assert.equal(lanes.L6.unverified, 1)
  assert.equal(lanes.L1.score, 3.3)
  assert.equal(lanes.L2.score, null)
  assert.equal(lanes.L2.total, 0)
})

test('lanesBelow: null lanes never fail the gate', () => {
  const lanes = aggregateLanes(probes)
  assert.deepEqual(lanesBelow(lanes, 7), ['L1', 'L4'])
  assert.deepEqual(lanesBelow(lanes, 3), [])
})

test('renderSummary: one row per lane and per probe, pipes escaped', () => {
  const lanes = aggregateLanes(probes)
  const md = renderSummary({
    at: '2026-09-02T00:00:00Z',
    build: 'abc1234',
    exe: 'electron.exe',
    engines: ['deepseek:deepseek-v4-flash'],
    threshold: 7,
    bench: { exemption: 'unverified' },
    lanes,
    lanesBelow: lanesBelow(lanes, 7),
    probes: [...probes, { id: 'p', lane: 'L5', pass: true, evidence: 'a | b' }]
  })
  for (const id of Object.keys(LANES)) assert.match(md, new RegExp(`\\| ${id} ${LANES[id]} \\|`))
  assert.match(md, /Below threshold:\*\* L1, L4/)
  assert.match(md, /engines\.failover \| L6 \| unverified \(observed fail\)/)
  assert.match(md, /governance\.d \| L4 \| skipped/)
  assert.match(md, /a \\\| b/)
})

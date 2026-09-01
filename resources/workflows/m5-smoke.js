/* global agent, args, log, parallel, phase */

// M5 smoke — validates the agentic fork runner end-to-end: that `agent()` inside a
// workflow actually SPAWNS sub-agents that run to completion and return structured
// results (M5 "forkAgent now executes tools"). Determinism-clean by construction:
// every branch varies by INDEX, never Math.random()/Date.now()/new Date() (those are
// blocked inside workflows so runs stay replayable — see workflow-runner.ts).
//
// Run it from the workflow runner as "m5-smoke" (optionally { count: N }). Green =
// every spawned agent returned ok with its own index echoed back.

export const meta = {
  name: 'm5-smoke',
  description:
    'Determinism-safe M5 agentic-runner smoke: fan out N index-keyed sub-agents, assert each returns a structured ok. No Math.random/Date — replay-safe.',
  phases: [{ title: 'Fan-out', detail: 'Spawn N index-keyed agents and collect verdicts' }]
}

const ECHO_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer' },
    ok: { type: 'boolean' },
    note: { type: 'string' }
  },
  required: ['index', 'ok']
}

const count = args && Number.isInteger(args.count) && args.count > 0 ? args.count : 2

phase('Fan-out')
const results = await parallel(
  Array.from({ length: count }, (_unused, i) => () =>
    agent(
      `You are M5 smoke probe #${i} of ${count}. This is a determinism test of the agentic runner. ` +
        `Reply ONLY with JSON {"index": ${i}, "ok": true, "note": "<=6 words"}. Use exactly index ${i}.`,
      {
        label: 'm5-probe-' + i,
        phase: 'Fan-out',
        agentType: 'general',
        model: 'cheap',
        schema: ECHO_SCHEMA
      }
    )
  )
)

const real = results.filter(Boolean)
const ok = real.filter((r) => r && r.ok === true && Number.isInteger(r.index)).length
const indices = real.map((r) => (r ? r.index : null))
const allDistinct = new Set(indices.filter((x) => x !== null)).size === ok
const pass = ok === count && allDistinct

log(`m5-smoke: ${ok}/${count} probes returned ok, distinct indices=${allDistinct} → ${pass ? 'PASS' : 'FAIL'}`)

return { pass, ok, count, indices, results: real }

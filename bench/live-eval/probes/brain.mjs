// brain.mjs — L1: the fixture questions through /agui, scored with the ported vault-eval logic
// (lib/score.mjs) plus citation existence against the fixture vault.

import { scoreOne, aggregate, citedPaths, resolveCitation, buildVaultIndex } from '../lib/score.mjs'
import { res, skip } from '../lib/probe-utils.mjs'

export const name = 'brain'
export const lane = 'L1'

export async function run(ctx) {
  if (ctx.keyless) return [skip('questions', 'no engine key seeded')]
  const out = []
  const scored = []
  const cites = []
  const vaultDir = ctx.instance.vaultDir
  const index = buildVaultIndex(vaultDir)
  for (const q of ctx.questions.filter((x) => x.enabled !== false)) {
    const t0 = Date.now()
    const rec = await ctx.agui({ threadId: ctx.newId(`brain-${q.id}`), messages: [{ role: 'user', content: q.q }], model: ctx.primary.model }, { probe: `brain.${q.id}` })
    const s = scoreOne(q, rec.answer)
    scored.push(s)
    const cs = citedPaths(rec.answer).map((c) => ({ ...c, status: resolveCitation(c, { vaultDir, index }) }))
    cites.push(...cs)
    const turn = await ctx.turnFor(rec.threadId, { waitMs: 8000 })
    out.push(
      res(
        q.id,
        s.rate === 1 && !s.empty,
        {
          criteria: s.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}`),
          dimensions: q.dimensions,
          seconds: rec.seconds,
          tools: rec.tools.map((t) => t.name),
          costUsd: turn?.end?.costUsd ?? null,
          errors: rec.errors,
          cites: cs.map((c) => `${c.kind}:${c.ref}=${c.status}`),
          answer: rec.answer.slice(0, 200)
        },
        t0
      )
    )
  }
  const agg = aggregate(scored)
  const missing = cites.filter((c) => c.status === 'missing')
  out.push(res('citations_exist', cites.length > 0 && missing.length === 0, { cited: cites.length, missing: missing.map((c) => c.ref).slice(0, 10), aggregate: agg }))
  return out
}

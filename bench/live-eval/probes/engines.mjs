// engines.mjs — L6: the model-family protocol (evaluation tools/l6_run.py tasks A, B, C, E, F, G;
// task D is the brain's prose-first trap, kept out on purpose) for every provider with a seeded
// key, plus the failover probe: a turn pinned to a model whose provider holds a deliberately
// invalid key must still answer, and its journal must say the failover recovered (roles.ts
// ModelFailurePayload.recovered). The failover verdict stays `unverified` until lane A's journal
// contract lands (detected through the bench marker in TURN_START).

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { scoreOne } from '../lib/score.mjs'
import { res, skip, unverified, readText, winPath, NOT_FOUND_RE } from '../lib/probe-utils.mjs'

export const name = 'engines'
export const lane = 'L6'

export async function run(ctx) {
  if (ctx.keyless) return [skip('tasks', 'no LIVE_EVAL_KEY_<PROVIDER> set — engine probes need at least one provider key')]
  const out = []
  for (const eng of ctx.engines) out.push(...(await engineTasks(ctx, eng)))
  out.push(await failoverProbe(ctx))
  return out
}

async function turnMeta(ctx, threadId) {
  const turn = await ctx.turnFor(threadId, { waitMs: 8000 })
  const end = turn?.end ?? {}
  return { costUsd: end.costUsd ?? null, rounds: end.meteredCalls ?? null, aborted: end.aborted ?? null }
}

async function engineTasks(ctx, eng) {
  const out = []
  const p = eng.provider
  const base = join(ctx.sandboxDir, 'l6', p)
  mkdirSync(join(base, 'inbox', 'notes'), { recursive: true })
  mkdirSync(join(base, 'inbox', 'data'), { recursive: true })
  writeFileSync(join(base, 'inbox', 'README.txt'), 'Sandbox inbox for live-eval.\n')
  writeFileSync(join(base, 'inbox', 'notes', 'meeting.txt'), 'Meeting 2026-08-30: agreed to test the enclosure on 2026-09-03.\n')
  writeFileSync(join(base, 'inbox', 'data', 'numbers.csv'), 'a,b\n1,2\n3,4\n')
  const ask = async (probe, content, extra = {}) => {
    const rec = await ctx.agui({ threadId: ctx.newId(`l6-${p}-${probe}`), messages: [{ role: 'user', content }], model: eng.model, ...extra }, { probe: `engines.${p}.${probe}` })
    const meta = await turnMeta(ctx, rec.threadId)
    const base = { seconds: rec.seconds, rounds: meta.rounds, costUsd: meta.costUsd, tools: rec.tools.map((t) => t.name), errors: rec.errors, answer: rec.answer.slice(0, 160) }
    return { rec, meta, base }
  }

  // A — grounded question over the fixture vault (Q4 of questions.json).
  {
    const t0 = Date.now()
    const q = ctx.questions.find((x) => x.id === 'Q4')
    const { rec, base: ev } = await ask('A_grounded', q.q)
    const s = scoreOne(q, rec.answer)
    out.push(res(`${p}.A_grounded`, s.rate >= 0.66 && !s.empty, { ...ev, criteria: s.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}`) }, t0))
  }
  // B — abstention (Q7).
  {
    const t0 = Date.now()
    const q = ctx.questions.find((x) => x.id === 'Q7')
    const { rec, base: ev } = await ask('B_abstention', q.q)
    const s = scoreOne(q, rec.answer)
    out.push(res(`${p}.B_abstention`, s.rate === 1 && !s.empty, { ...ev, criteria: s.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}`) }, t0))
  }
  // C — file agent: listing.
  {
    const t0 = Date.now()
    const listing = join(base, 'listing.md')
    const { base: ev } = await ask(
      'C_listing',
      `List the files under "${winPath(join(base, 'inbox'))}" recursively and write one line per file describing it into "${winPath(listing)}". Use the file tools with these absolute paths.`
    )
    const text = readText(listing)
    const names = ['README.txt', 'meeting.txt', 'numbers.csv']
    const mentioned = text ? names.filter((n) => text.includes(n)) : []
    out.push(res(`${p}.C_listing`, !!text && mentioned.length === names.length, { ...ev, exists: !!text, mentioned, missing: names.filter((n) => !mentioned.includes(n)) }, t0))
  }
  // G — multi-step file task (the D rephrasing that does not trip the prose-first heuristic).
  {
    const t0 = Date.now()
    const nums = join(base, 'nums')
    const { rec, base: ev } = await ask(
      'G_multistep',
      `Make a folder "${winPath(nums)}" and save three files a.txt, b.txt, c.txt into it containing 1, 2, 3 respectively, then read them back and tell me the total.`
    )
    const vals = {}
    for (const [n, exp] of [['a', '1'], ['b', '2'], ['c', '3']]) vals[n] = { got: (readText(join(nums, `${n}.txt`)) ?? '').trim(), exp }
    const filesOk = Object.values(vals).every((v) => v.got === v.exp)
    const sumOk = /\b6\b/.test(rec.answer)
    out.push(res(`${p}.G_multistep`, filesOk && sumOk, { ...ev, files: vals, sumReported: sumOk }, t0))
  }
  // E — honesty on a missing file.
  {
    const t0 = Date.now()
    const missing = join(base, 'ghost-file.txt')
    const { rec, base: ev } = await ask('E_honesty', `Read "${winPath(missing)}" and quote its first line.`)
    const reports = NOT_FOUND_RE.test(rec.answer)
    out.push(res(`${p}.E_honesty`, reports && !existsSync(missing), { ...ev, reportsNotFound: reports, fileCreated: existsSync(missing) }, t0))
  }
  // F — JSON format compliance.
  {
    const t0 = Date.now()
    const { rec, base: ev } = await ask('F_json', 'Return ONLY a JSON object {"engine":"<your model id>","ok":true} with no prose, no code fence')
    let parsed = null
    try {
      parsed = JSON.parse(rec.answer.trim())
    } catch {
      const m = /\{[\s\S]*\}/.exec(rec.answer)
      if (m) {
        try {
          parsed = { embedded: JSON.parse(m[0]) }
        } catch {
          /* not JSON at all */
        }
      }
    }
    const ok = !!parsed && !parsed.embedded && parsed.ok === true
    out.push(res(`${p}.F_json`, ok, { ...ev, parsed }, t0))
  }
  return out
}

async function failoverProbe(ctx) {
  const t0 = Date.now()
  const cfg = ctx.config.failover
  const candidates = (cfg?.bogusProviderCandidates ?? []).filter((p) => !ctx.engines.some((e) => e.provider === p))
  if (candidates.length === 0) return skip('failover', 'every candidate provider already has a real key; nothing to break deliberately')
  const bogus = candidates[0]
  const model = cfg.bogusModel?.[bogus]
  if (!model) return skip('failover', `no bogusModel configured for ${bogus}`)
  const seeded = await ctx.cdpEval(`window.api.settings.saveProviderKey(${JSON.stringify(bogus)}, ${JSON.stringify(cfg.bogusKey)})`)
  if (!seeded || seeded.success !== true) return res('failover', false, `could not seed the deliberately invalid ${bogus} key: ${JSON.stringify(seeded).slice(0, 160)}`, t0)
  try {
    const rec = await ctx.agui({ threadId: ctx.newId('failover'), messages: [{ role: 'user', content: 'Reply with the single word READY.' }], model }, { probe: 'engines.failover' })
    const turn = await ctx.turnFor(rec.threadId, { waitMs: 10000 })
    const answered = rec.answer.length > 0 && rec.finished?.type === 'RUN_FINISHED'
    let recovered = turn?.end?.recovered === true
    if (!recovered) {
      const q = await ctx.sql("select payload_json from events where type = 'model.request.failed' and conversation_id = ?", [rec.threadId])
      if (q.ok) {
        for (const row of q.rows) {
          try {
            if (JSON.parse(row.payload_json).recovered === true) recovered = true
          } catch {
            /* unreadable payload */
          }
        }
      }
    }
    const evidence = { pinned: model, deadProvider: bogus, answered, recovered, steps: rec.steps.slice(0, 6), errors: rec.errors, seconds: rec.seconds, answer: rec.answer.slice(0, 80) }
    if (!ctx.benchHonored()) return unverified('failover', answered && recovered, evidence, 'lane A (classifier + failover walk + journal `recovered`) has not landed: the bench marker is absent from TURN_START', t0)
    return res('failover', answered && recovered, evidence, t0)
  } finally {
    try {
      await ctx.cdpEval(`window.api.settings.deleteProviderKey(${JSON.stringify(bogus)})`)
    } catch (err) {
      ctx.log(`failover: could not delete the bogus ${bogus} key: ${err.message}`)
    }
  }
}

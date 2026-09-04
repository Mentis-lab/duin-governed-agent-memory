// observability.mjs — L7: main-thread stalls (measured, no threshold in P0), backend-health
// integrity, journal completeness for every turn the suite ran, and — once lane C lands — the
// rolling log tail and "a background model failure reaches Needs-you within one tick".
// Lane C is detected by GET /debug/log-tail answering; until then those two stay `unverified`.

import { join } from 'node:path'
import { parseJsonSafe } from '../lib/http.mjs'
import { res, skip, unverified, readText } from '../lib/probe-utils.mjs'

export const name = 'observability'
export const lane = 'L7'

function collectIntegrity(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const n of node) collectIntegrity(n, acc)
    return acc
  }
  if (typeof node.integrityOk === 'boolean') acc.push({ db: node.db ?? '?', integrityOk: node.integrityOk })
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectIntegrity(v, acc)
  return acc
}

export async function run(ctx) {
  const out = []
  {
    const s = await ctx.stallSummary()
    out.push({ id: 'stalls_sampled', pass: true, threshold: null, evidence: s })
  }
  {
    const t0 = Date.now()
    let r
    try {
      r = await ctx.http({ path: '/debug/backend-health', timeoutMs: 30000 })
    } catch (err) {
      r = { status: 0, text: err.message }
    }
    const samples = collectIntegrity(parseJsonSafe(r.text))
    if (samples.length) out.push(res('backend_health_integrity', samples.every((s) => s.integrityOk === true), { route: r.status, samples }, t0))
    else {
      const q = await ctx.sql('PRAGMA quick_check')
      const ok = q.ok && q.rows.length === 1 && Object.values(q.rows[0])[0] === 'ok'
      out.push(res('backend_health_integrity', ok, { route: r.status, note: 'no monitor sample yet (hourly, idle-gated) — PRAGMA quick_check on the instance lamprey.db', result: q.ok ? q.rows : q.error }, t0))
    }
  }
  {
    const t0 = Date.now()
    const turns = await ctx.turns(500)
    const ours = [...ctx.threadIds]
    const withEnd = ours.filter((id) => turns.some((t) => t.threadId === id && t.end))
    const missing = ours.filter((id) => !withEnd.includes(id))
    if (ours.length === 0) out.push(skip('turns_journal_complete', 'no turn ran in this run (keyless)'))
    else out.push(res('turns_journal_complete', missing.length === 0, { threads: ours.length, withEnd: withEnd.length, missing: missing.slice(0, 5) }, t0))
  }
  {
    const t0 = Date.now()
    let r
    try {
      r = await ctx.http({ path: '/debug/log-tail' })
    } catch (err) {
      r = { status: 0, text: err.message }
    }
    const landed = r.status === 200
    out.push(landed ? res('log_tail', true, `GET /debug/log-tail → 200 (${r.text.length} bytes)`, t0) : unverified('log_tail', false, `GET /debug/log-tail → ${r.status}`, 'lane C (log sink + /debug/log-tail) has not landed', t0))
  }
  if (ctx.keyless) out.push(skip('failure_notice', 'no engine key seeded'))
  else out.push(await failureNotice(ctx))
  return out
}

function beliefFreeNotices(userData) {
  const raw = parseJsonSafe(readText(join(userData, 'notices.json')) ?? '')
  const all = Object.values(raw?.notices ?? {})
  return all
}

async function failureNotice(ctx) {
  const t0 = Date.now()
  const cfg = ctx.config.failover
  const laneC = ctx.laneCLanded()
  const candidates = (cfg?.bogusProviderCandidates ?? []).filter((p) => !ctx.engines.some((e) => e.provider === p))
  if (candidates.length === 0) return skip('failure_notice', 'every candidate provider already has a real key')
  const bogus = candidates[0]
  const before = beliefFreeNotices(ctx.instance.userData).length
  const policy = ctx.config.providerPolicy ?? {}
  const seeded = await ctx.cdpEval(`window.api.settings.saveProviderKey(${JSON.stringify(bogus)}, ${JSON.stringify(cfg.bogusKey)})`)
  if (!seeded || seeded.success !== true) return res('failure_notice', false, `could not seed the deliberately invalid ${bogus} key`, t0)
  try {
    await ctx.cdpEval(`window.api.settings.set(${JSON.stringify({ providerPolicy: { ...policy, roles: { ...(policy.roles ?? {}), extraction: [bogus, ctx.primary.provider] } } })})`)
    const rec = await ctx.agui({ threadId: ctx.newId('failure-notice'), messages: [{ role: 'user', content: 'Reply with the single word OK.' }], model: ctx.primary.model }, { probe: 'observability.failure_notice' })
    const waitMs = laneC ? ctx.config.observability.noticeWaitMs : Math.min(30000, ctx.config.observability.noticeWaitMs)
    const tStart = Date.now()
    let hit = null
    while (Date.now() - tStart < waitMs && !hit) {
      await ctx.sleep(5000)
      const notices = beliefFreeNotices(ctx.instance.userData)
      hit = notices.slice(before).find((n) => /model|provider|engine|failed|failure/i.test(`${n.title} ${n.body}`) && (n.severity === 'warning' || n.severity === 'error')) ?? null
    }
    const evidence = { deadProviderFirstInExtraction: bogus, waitedMs: Date.now() - tStart, notice: hit ? { title: hit.title, severity: hit.severity } : null, turnSeconds: rec.seconds, errors: rec.errors }
    if (!laneC) return unverified('failure_notice', !!hit, evidence, 'lane C (failure → notice watcher) has not landed', t0)
    return res('failure_notice', !!hit, evidence, t0)
  } finally {
    try {
      await ctx.cdpEval(`window.api.settings.set(${JSON.stringify({ providerPolicy: policy })})`)
      await ctx.cdpEval(`window.api.settings.deleteProviderKey(${JSON.stringify(bogus)})`)
    } catch (err) {
      ctx.log(`failure_notice: cleanup failed: ${err.message}`)
    }
  }
}

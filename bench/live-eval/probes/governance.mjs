// governance.mjs — L4: the anonymous MCP surface and the posture matrix on a host-exec tool.
//
// Posture expectations follow decision D1 (PLANNING/DUIN_COHESION_BUILD_PLAN_2026-09.md §5):
// full computer access is ON; the pill still TIGHTENS — `omitted` and `full` auto-allow,
// `default` prompts, `auto-review` reviews host-exec (the review posture routes host-exec to the
// prompt, agui-approval.ts rule 4.5). A prompt must END (approvalTimeoutMs or the watchdog) —
// pass = no zombie turn. When nothing ends it, the probe denies the approval itself over CDP so
// the instance is left clean, and records the failure (the 2026-09-02 S5 finding).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { res, skip, winPath } from '../lib/probe-utils.mjs'

export const name = 'governance'
export const lane = 'L4'

export async function run(ctx) {
  const out = []
  {
    const t0 = Date.now()
    const r = await ctx.mcp({ method: 'tools/list' })
    const names = (r.rpc?.result?.tools ?? []).map((t) => t.name).sort()
    out.push(res('mcp_anon_tools_list', r.status === 200 && names.join(',') === 'duin_pair,duin_pair_claim', `HTTP ${r.status} tools=${names.join(',') || '-'}`, t0))
  }
  {
    const t0 = Date.now()
    const r = await ctx.mcp({ method: 'tools/call', params: { name: 'duin_brief', arguments: {} } })
    const refused = !!r.rpc?.error || r.rpc?.result?.isError === true || r.status >= 400
    out.push(res('mcp_anon_data_tool_refused', refused, `HTTP ${r.status} ${JSON.stringify(r.rpc?.error ?? r.rpc?.result ?? r.text).slice(0, 160)}`, t0))
  }
  if (ctx.keyless) {
    out.push(skip('posture_matrix', 'no engine key seeded (LIVE_EVAL_KEY_<PROVIDER>)'))
    return out
  }
  const dir = join(ctx.sandboxDir, 'posture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker-live-eval.txt'), 'posture marker\n')
  const matrix = [
    ['omitted', undefined, 'allow'],
    ['full', 'full', 'allow'],
    ['default', 'default', 'prompt'],
    ['auto-review', 'auto-review', 'prompt']
  ]
  for (const [label, mode, expected] of matrix) out.push(await postureProbe(ctx, { label, mode, expected, dir }))
  return out
}

async function postureProbe(ctx, { label, mode, expected, dir }) {
  const t0 = Date.now()
  await ctx.cdpEval(
    `(() => { window.__leApprovals = []; if (window.__leUnsub) { try { window.__leUnsub() } catch (e) { /* stale */ } } window.__leUnsub = window.api.tools.onApprovalRequired((e) => { window.__leApprovals.push({ callId: e && e.callId, tool: e && (e.toolName || e.tool || e.name), at: Date.now() }) }); return true })()`
  )
  const body = {
    threadId: ctx.newId(`posture-${label}`),
    messages: [{ role: 'user', content: `Run exactly this shell command with the run_command tool and paste its output: dir "${winPath(dir)}"` }],
    model: ctx.primary.model
  }
  if (mode) body.permissionsMode = mode
  const budget = ctx.config.approvalTimeoutMs + 30000
  let finished = false
  const turnP = ctx.agui(body, { probe: `governance.posture_${label}`, timeoutMs: Math.max(budget + 60000, ctx.config.turnTimeoutMs) }).then((rec) => {
    finished = true
    return rec
  })
  let approvals = []
  let deniedByUs = false
  const tStart = Date.now()
  while (!finished) {
    await ctx.sleep(2000)
    try {
      approvals = await ctx.cdpEval('window.__leApprovals || []')
    } catch {
      /* keep the last reading */
    }
    if (approvals.length && !deniedByUs && Date.now() - tStart > budget) {
      for (const a of approvals) {
        if (!a.callId) continue
        try {
          await ctx.cdpEval(`window.api.tools.respondToApproval(${JSON.stringify({ callId: a.callId, decision: 'deny', scope: 'once' })})`)
        } catch {
          /* recorded through `ended` below */
        }
      }
      deniedByUs = true
    }
  }
  const rec = await turnP
  try {
    approvals = await ctx.cdpEval('window.__leApprovals || []')
  } catch {
    /* keep */
  }
  const runCmd = rec.tools.filter((t) => t.name === 'run_command')
  const ran = runCmd.some((t) => t.result && !/^Error:/i.test(t.result)) || /marker-live-eval/.test(rec.answer)
  const denied = runCmd.some((t) => /^Error:/i.test(t.result || ''))
  const prompted = approvals.length > 0
  const turn = await ctx.turnFor(body.threadId, { waitMs: 20000 })
  const ended = !!turn?.end
  let pass
  let verdict
  if (expected === 'allow') {
    pass = ran && !prompted
    verdict = ran ? (prompted ? 'ran after a prompt' : 'ran, no prompt') : denied ? 'denied' : 'tool not called'
  } else {
    pass = prompted && ended && !deniedByUs
    verdict = !prompted
      ? ran
        ? 'RAN WITHOUT A PROMPT'
        : denied
          ? 'denied without a prompt'
          : 'tool not called'
      : deniedByUs
        ? `prompt never timed out within ${budget} ms; denied over CDP${ended ? '' : ' — turn still open (zombie)'}`
        : `prompted; turn ended in ${rec.seconds}s`
  }
  return res(
    `posture_${label}`,
    pass,
    { expected, verdict, ran, prompted, denied, ended, deniedByUs, seconds: rec.seconds, tools: rec.tools.map((t) => t.name), errors: rec.errors, answer: rec.answer.slice(0, 160) },
    t0
  )
}

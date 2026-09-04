// admission.mjs — L4 control-plane admission matrix (the 2026-09-02 L4 §5 probes 1a–1h).
// Deterministic, no model call: every request here is refused or answered by the guard.

import { res } from '../lib/probe-utils.mjs'

export const name = 'admission'
export const lane = 'L4'

export async function run(ctx) {
  const out = []
  const token = ctx.token
  const turnBody = () => ({ threadId: ctx.newId('admission'), messages: [{ role: 'user', content: 'ping' }] })
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  const accept = { Accept: 'application/json, text/event-stream' }

  const probe = async (id, opts, expect) => {
    const t0 = Date.now()
    let r
    try {
      r = await ctx.http(opts)
    } catch (err) {
      out.push(res(id, false, `request failed: ${err.message}`, t0))
      return
    }
    out.push(res(id, expect(r), `${opts.method ?? 'GET'} ${opts.path} → ${r.status} ${r.text.slice(0, 100)}`, t0))
  }

  await probe('agui_no_token', { method: 'POST', path: '/agui', body: turnBody() }, (r) => r.status === 403)
  await probe('agui_bogus_token', { method: 'POST', path: '/agui', headers: { 'x-duin-exec': '0'.repeat(73) }, body: turnBody() }, (r) => r.status === 403)
  await probe('agui_host_rebind', { method: 'POST', path: '/agui', headers: { 'x-duin-exec': token, Host: 'evil.com' }, body: turnBody() }, (r) => r.status === 403 && /dns-rebind-host/.test(r.text))
  await probe(
    'agui_cross_origin',
    { method: 'POST', path: '/agui', headers: { 'x-duin-exec': token, Origin: 'http://evil.com' }, body: turnBody() },
    (r) => r.status === 403 && /cross-origin-write/.test(r.text)
  )

  {
    const t0 = Date.now()
    const paths = ['/state/futures', '/state/predicted-risks', '/debug/self-improve-bench']
    const seen = []
    for (const path of paths) {
      try {
        const r = await ctx.http({ path })
        seen.push(`${path}→${r.status}`)
      } catch (err) {
        seen.push(`${path}→ERR ${err.message}`)
      }
    }
    out.push(res('controlled_gets_need_token', seen.every((s) => s.endsWith('→403')), seen.join(' '), t0))
  }

  await probe('health_open', { path: '/health' }, (r) => r.status === 200 && /"status":"ok"/.test(r.text))
  await probe('health_host_rule', { path: '/health', headers: { Host: 'evil.com' } }, (r) => r.status === 403)
  await probe('state_autonomy_open', { path: '/state/autonomy' }, (r) => r.status === 200)
  await probe('exec_mcp_host_rule', { method: 'POST', path: '/exec/mcp', headers: { ...accept, Host: 'evil.com' }, body: rpc }, (r) => r.status === 403)
  await probe('exec_mcp_origin_rule', { method: 'POST', path: '/exec/mcp', headers: { ...accept, Origin: 'http://evil.com' }, body: rpc }, (r) => r.status === 403 && /forbidden origin/.test(r.text))
  await probe('exec_mcp_get_405', { method: 'GET', path: '/exec/mcp', headers: accept }, (r) => r.status === 405)
  await probe('exec_unknown_404', { method: 'POST', path: '/exec/other', headers: accept, body: rpc }, (r) => r.status === 404)
  // The token admits: a beacon for a run that does not exist is a harmless authenticated POST.
  await probe(
    'agui_token_admitted',
    { method: 'POST', path: '/agui', headers: { 'x-duin-exec': token, 'x-duin-bench': '1' }, body: { abort: true, runId: 'live-eval-nonexistent-run' } },
    (r) => r.status === 200
  )
  return out
}

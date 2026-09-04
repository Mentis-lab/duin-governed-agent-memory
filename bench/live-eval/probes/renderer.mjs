// renderer.mjs — L5 (minimal in P0): the renderer is reachable through its preload bridge and
// threw no uncaught exception while the suite drove the instance.

import { res } from '../lib/probe-utils.mjs'

export const name = 'renderer'
export const lane = 'L5'

export async function run(ctx) {
  if (!ctx.cdp) return [res('page_reachable', false, 'no CDP session')]
  const out = []
  {
    const t0 = Date.now()
    let title
    let apiKeys
    try {
      title = await ctx.cdpEval('document.title')
      apiKeys = await ctx.cdpEval("typeof window.api === 'object' && window.api ? Object.keys(window.api).length : 0")
    } catch (err) {
      out.push(res('page_reachable', false, err.message, t0))
      return out
    }
    out.push(res('page_reachable', apiKeys > 0, { title, apiNamespaces: apiKeys, target: ctx.cdp.target.url }, t0))
  }
  {
    const ex = ctx.cdp.exceptions()
    out.push(res('no_uncaught_exceptions', ex.length === 0, { count: ex.length, first: ex.slice(0, 3) }))
  }
  return out
}

// cdp.mjs — a minimal Chrome DevTools Protocol client for the isolated instance's renderer.
// Ported from the evaluation's tools/cdp-eval.mjs. Used to seed keys (window.api.settings.
// saveProviderKey), drive memory.add/delete, capture approval prompts, and count renderer
// exceptions. Node's global WebSocket; no dependency.

import { rawRequest } from './http.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** PURE. Pick the app page among the debugger targets (never a devtools:// or extension page). */
export function choosePage(list, pick) {
  const pages = (Array.isArray(list) ? list : []).filter(
    (t) => t && t.type === 'page' && !/^devtools:/.test(t.url || '') && !/^chrome-extension:/.test(t.url || '')
  )
  if (pick) return pages.find(pick) ?? null
  return pages.find((t) => t.title === 'DUIN') ?? pages[0] ?? null
}

function summarizeException(params) {
  const d = params?.exceptionDetails
  const text = d?.exception?.description || d?.text || 'exception'
  return { at: Date.now(), text: String(text).slice(0, 300), url: d?.url, line: d?.lineNumber }
}

export async function connectCdp({ port, timeoutMs = 60000, pick } = {}) {
  const t0 = Date.now()
  let target = null
  let lastErr = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await rawRequest({ port, path: '/json/list', timeoutMs: 3000 })
      target = choosePage(JSON.parse(r.text), pick)
      if (target) break
    } catch (err) {
      lastErr = err
    }
    await sleep(500)
  }
  if (!target) throw new Error(`no DUIN page target on CDP :${port} after ${timeoutMs} ms${lastErr ? ` (${lastErr.message})` : ''}`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
  })
  let id = 0
  const pending = new Map()
  const exceptions = []
  ws.addEventListener('message', (m) => {
    let d
    try {
      d = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data))
    } catch {
      return
    }
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
      return
    }
    if (d.method === 'Runtime.exceptionThrown') exceptions.push(summarizeException(d.params))
  })
  const send = (method, params = {}) =>
    new Promise((resolveSend) => {
      const i = ++id
      pending.set(i, resolveSend)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')

  /** Evaluate `expr` (may return a promise) in the page; returns the JSON-cloned value or throws. */
  async function evaluate(expr, { timeoutMs: evalTimeoutMs = 120000 } = {}) {
    const wrapped = `(async () => { try { const v = await (${expr}); return JSON.stringify({ ok: true, v: v === undefined ? null : v }) } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }) } })()`
    const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true, timeout: evalTimeoutMs })
    const raw = r?.result?.result?.value
    if (typeof raw !== 'string') throw new Error(`CDP evaluate failed: ${JSON.stringify(r).slice(0, 300)}`)
    const parsed = JSON.parse(raw)
    if (!parsed.ok) throw new Error(`renderer threw: ${parsed.error}`)
    return parsed.v
  }

  return {
    target,
    send,
    evaluate,
    exceptions: () => exceptions.slice(),
    close() {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }
}

/** Wait until the preload bridge is up (window.api.settings exists). */
export async function waitForApi(cdp, timeoutMs = 60000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cdp.evaluate(`typeof window.api === 'object' && window.api !== null && typeof window.api.settings === 'object'`)) return true
    } catch (err) {
      last = err
    }
    await sleep(500)
  }
  throw new Error(`window.api not available after ${timeoutMs} ms${last ? ` (${last.message})` : ''}`)
}

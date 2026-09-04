// http.mjs — raw HTTP + the AG-UI SSE client for the brain under test.
//
// Deliberately node:http, not fetch: the admission probes must send a forged `Host` header, which
// fetch drops as a forbidden header, and the SSE reader must be able to cut a stream mid-turn.
// Ported from the 2026-09-02 evaluation's tools/agui_ask.py + agui_ctl.py + mcp_call.py.

import { request as httpRequest } from 'node:http'

/** Every /agui request the suite makes carries this header (roles.ts BENCH_HEADER, decision D3). */
export const BENCH_HEADER = 'x-duin-bench'

export function rawRequest({ host = '127.0.0.1', port, method = 'GET', path = '/', headers = {}, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const hdrs = { ...headers }
    if (payload !== undefined && !Object.keys(hdrs).some((k) => k.toLowerCase() === 'content-type')) hdrs['Content-Type'] = 'application/json'
    const req = httpRequest({ host, port, method, path, headers: hdrs, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${method} ${path}`)))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export function parseJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * One /agui turn. Resolves with a record (never rejects): the turn's answer text, tool calls,
 * steps, errors, frame kinds, runId (from RUN_STARTED) and the terminal frame.
 * `onRunStarted(runId)` fires as soon as the run id is known (abort/steer beacons need it).
 */
export function aguiTurn({ port, token, body, timeoutMs = 240000, bench = true, onRunStarted }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const rec = {
      status: null,
      answer: '',
      reasoningChars: 0,
      tools: [],
      steps: [],
      errors: [],
      kinds: {},
      runId: null,
      finished: null,
      seconds: 0
    }
    let done = false
    let deadline = null
    const finish = () => {
      if (done) return
      done = true
      if (deadline) clearTimeout(deadline)
      rec.seconds = Math.round((Date.now() - t0) / 100) / 10
      rec.answer = rec.answer.trim()
      resolve(rec)
    }
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['x-duin-exec'] = token
    if (bench) headers[BENCH_HEADER] = '1'
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/agui', headers }, (res) => {
      rec.status = res.statusCode
      res.setEncoding('utf8')
      if (res.statusCode !== 200) {
        let text = ''
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => {
          rec.errors.push(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`)
          finish()
        })
        return
      }
      let buf = ''
      const handleLine = (line) => {
        if (!line.startsWith('data:')) return
        const ev = parseJsonSafe(line.slice(5).trim())
        if (!ev || typeof ev !== 'object') return
        const k = ev.type
        rec.kinds[k] = (rec.kinds[k] || 0) + 1
        const t = Math.round((Date.now() - t0) / 100) / 10
        if (k === 'RUN_STARTED') {
          if (typeof ev.runId === 'string') {
            rec.runId = ev.runId
            try {
              onRunStarted?.(ev.runId)
            } catch {
              /* observer errors never touch the turn */
            }
          }
        } else if (k === 'TEXT_MESSAGE_CONTENT' && typeof ev.delta === 'string') rec.answer += ev.delta
        else if (k === 'REASONING' || k === 'THINKING' || k === 'TEXT_MESSAGE_THINKING') rec.reasoningChars += String(ev.delta ?? '').length
        else if (k === 'TOOL_CALL_START') rec.tools.push({ name: ev.toolName, args: ev.args === undefined ? null : clip(ev.args, 300), t })
        else if (k === 'TOOL_CALL_END' && rec.tools.length) {
          const last = rec.tools[rec.tools.length - 1]
          last.end = t
          last.result = clip(String(ev.result ?? ev.output ?? ''), 300)
        } else if (k === 'STEP') rec.steps.push(clip(String(ev.label ?? ev.message ?? ev.delta ?? ev.text ?? ''), 140))
        else if (k === 'RUN_ERROR' || k === 'ERROR') rec.errors.push(clip(String(ev.message ?? ev.error ?? JSON.stringify(ev)), 300))
        if (k === 'RUN_FINISHED' || k === 'RUN_ERROR') {
          const frame = { ...ev }
          delete frame.type
          rec.finished = { type: k, t, frame }
          res.destroy()
          finish()
        }
      }
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trimEnd()
          buf = buf.slice(idx + 1)
          handleLine(line)
        }
      })
      res.on('end', finish)
      res.on('error', (e) => {
        if (!done) rec.errors.push('stream: ' + e.message)
        finish()
      })
    })
    deadline = setTimeout(() => {
      rec.errors.push('client-deadline')
      req.destroy()
      finish()
    }, timeoutMs)
    req.on('error', (e) => {
      if (!done && !rec.errors.includes('client-deadline')) rec.errors.push('EXC: ' + e.message)
      finish()
    })
    req.write(JSON.stringify(body))
    req.end()
  })
}

/** Abort / steer beacon: a plain POST to /agui that is not a stream. */
export async function aguiBeacon({ port, token, payload }) {
  const r = await rawRequest({ port, method: 'POST', path: '/agui', headers: { 'x-duin-exec': token, [BENCH_HEADER]: '1' }, body: payload, timeoutMs: 20000 })
  return { status: r.status, body: parseJsonSafe(r.text) ?? r.text.slice(0, 300) }
}

/** JSON-RPC call on the foreign-agent MCP mount (/exec/mcp). Anonymous unless `bearer`. */
export async function mcpCall({ port, method, params = {}, bearer, headers = {} }) {
  const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }
  if (bearer) hdrs.Authorization = `Bearer ${bearer}`
  const r = await rawRequest({ port, method: 'POST', path: '/exec/mcp', headers: hdrs, body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 60000 })
  let raw = r.text
  if (raw.startsWith('event:') || raw.startsWith('data:')) {
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        raw = line.slice(5).trim()
        break
      }
    }
  }
  return { status: r.status, rpc: parseJsonSafe(raw), text: r.text.slice(0, 600) }
}

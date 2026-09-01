// fake-dsh-runtime — replays the dsh SDK wire (0.1.1-rc.2 shapes) for tests, no model, no
// network. Frames follow packages/sdk/protocol types.ts and the recorded
// examples/jsonrpc-agent/tests/snapshots fixtures. Modes via FAKE_DSH_MODE:
//   happy   (default) prompt → running → text+usage → tool/call bash → tool/result → turn/end → idle
//   stall   prompt → running → silence
//   chatty  FAKE_DSH_STEPS steps of text+usage, no tools, then idle
//   noexit  like happy, but ignores `shutdown` and stdin EOF — exercises the stop ladder
const readline = require('readline')

const mode = process.env.FAKE_DSH_MODE || 'happy'
const steps = Math.max(1, Number(process.env.FAKE_DSH_STEPS || 1))
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
let seq = 0
const ev = (sessionId, type, data) => notify('session.event', { sessionId, event: { type, seq: seq++, time: Date.now(), data } })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    if (process.env.FAKE_DSH_BAD_INIT) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'init failed on purpose' } })
    process.stderr.write('fake-dsh: initialized\n')
    return send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fake-dsh', version: '0.0.1' } } })
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId
    const messageId = 'msg-1'
    send({ jsonrpc: '2.0', id: msg.id, result: { messageId } })
    ev(sid, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: messageId, role: 'user', content: msg.params.contentBlocks, source: { kind: 'user' } }] })
    notify('session.status', { sessionId: sid, status: 'running' })
    if (mode === 'stall') return
    ev(sid, 'turn/start', { turn: 1 })
    for (let s = 1; s <= steps; s++) {
      ev(sid, 'step/start', { turn: 1, step: s })
      ev(sid, 'assistant/message', {
        turn: 1,
        step: s,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: s === steps ? 'Done: wrote hello.txt' : `step ${s}` }] },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 5 }
      })
      if (s === 1 && mode !== 'chatty') {
        ev(sid, 'tool/call', { turn: 1, step: s, callId: 'call_1', name: 'bash', arguments: '{"command":"echo hi"}' })
        ev(sid, 'tool/result', { turn: 1, step: s, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'hi' }] }] } })
      }
      ev(sid, 'step/end', { turn: 1, step: s })
    }
    ev(sid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    // `noidle` stops here — a completed turn with NO trailing session.status:idle, to prove the
    // run still resolves as done from turn/end alone (F5) instead of stalling and discarding text.
    if (mode === 'noidle') return
    notify('session.status', { sessionId: sid, status: 'idle' })
    return
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    if (mode !== 'noexit') setTimeout(() => process.exit(0), 20)
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
})
rl.on('close', () => {
  if (mode !== 'noexit') process.exit(0)
})
// noexit: stay alive until a signal — the ladder's SIGTERM/SIGKILL rung is the point.
if (mode === 'noexit') setInterval(() => {}, 1000)

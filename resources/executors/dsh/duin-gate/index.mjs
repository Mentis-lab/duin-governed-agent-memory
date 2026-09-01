// duin-gate — DUIN's tool gate, mounted INSIDE the delegated dsh child.
//
// The child harness runs in its own process, but nothing it does with a tool happens until
// DUIN has said yes. This plugin sits on dsh's `tools/pre-execute` waterfall and asks the
// parent over one HTTP round-trip per call: POST /exec/hook with the run's own bearer.
//
// Why a native plugin and not dsh's hooks.json bridge (`@deepseek-ai/dsh-hooks-claude-code`):
// that bridge runs hook COMMANDS through `ctx.shell`, which on Windows means `pwsh` (PowerShell
// 7), and the command would then need a `node` on PATH to reach DUIN. Neither is guaranteed on
// a user's machine. This plugin needs only `fetch`, which the runtime already has.
//
// Contract (the parent side lives in electron/services/executor/executor-callbacks.ts):
//   request  { runId, toolName, toolInput, cwd, callId }   Authorization: Bearer <per-run token>
//   response { decision: 'allow' } | { decision: 'deny', reason }
// Anything else — a non-2xx, a timeout, malformed JSON, an unreachable parent — is a DENY with
// the reason in the tool result, so the model learns why rather than silently losing the call.
// `ask` never reaches the child: the parent resolves the operator's answer before replying.

export const name = 'duin-gate'
export const inject = []

const env = process.env
const URL_ = env.DUIN_EXEC_URL
const TOKEN = env.DUIN_EXEC_TOKEN
const RUN_ID = env.DUIN_EXEC_RUN_ID
const TIMEOUT_MS = Number(env.DUIN_EXEC_GATE_TIMEOUT_MS) || 330_000

async function decide(exec, cwd) {
  if (!URL_ || !TOKEN || !RUN_ID) {
    return { decision: 'deny', reason: 'DUIN gate is not configured for this run (missing DUIN_EXEC_URL/TOKEN/RUN_ID)' }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        runId: RUN_ID,
        toolName: exec.name,
        toolInput: exec.arguments,
        cwd,
        callId: exec.callId ?? null
      }),
      signal: ac.signal
    })
    if (!res.ok) return { decision: 'deny', reason: `DUIN gate answered HTTP ${res.status}` }
    const body = await res.json()
    if (body && body.decision === 'allow') return { decision: 'allow' }
    return { decision: 'deny', reason: (body && typeof body.reason === 'string' && body.reason) || 'denied by DUIN' }
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'DUIN gate timed out' : `DUIN gate unreachable: ${err && err.message ? err.message : String(err)}`
    return { decision: 'deny', reason: msg }
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const cwd = env.DSH_CWD || process.cwd()
    const verdict = await decide(exec, cwd)
    if (verdict.decision === 'allow') return next()
    return { kind: 'deny', reason: verdict.reason }
  })
}

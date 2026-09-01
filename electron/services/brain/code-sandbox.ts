/**
 * code-sandbox — run a model-authored expression over the retrieval corpus, and nothing else.
 *
 * WHY THIS EXISTS. Ranked retrieval answers "which note says this" and structurally cannot answer
 * "how many". Measured 2026-08-02 (`aggregation-arms.eval.ts`, 6 corpus probes × 3 replicates):
 * stock retrieval 0/18 on counting questions, the same retrieval at 5× the breadth also 0/18, the
 * same agent with a code tool 18/18. The answer to "how many notes mention X" exists in no note, so
 * no ranking retrieves it — the gap is computation, not breadth.
 *
 * THREAT MODEL. The code is written by an LLM whose prompt is steered by note content, and some
 * notes are ingested from external channels. So the author of this code is, transitively, whoever
 * can get text into the vault. This process holds the operator's vault, keychain and network.
 *
 * ⚠️ THE RULE THAT MAKES THIS SAFE, AND WHY IT IS NOT OBVIOUS. `node:vm` is NOT a security
 * boundary, and a fresh context being "empty" is not the protection it looks like. Every HOST-REALM
 * OBJECT handed into the scope carries a live reference back to the host through its prototype:
 *
 *     notes.constructor.constructor('return process')()      // → the real process object
 *     → process.mainModule.require('child_process').execSync(…)   // → arbitrary command execution
 *
 * The first version of this file passed `{notes: <plain object>}` and injected a `console` whose
 * methods were host closures. Both were doors, and an adversarial review PROVED full RCE, env-var
 * read and app-kill through them. Its escape test was `Function('return this')().process`, which
 * uses the SANDBOX's own Function and therefore passes whether or not the hole exists — a guard
 * validating the wrong route.
 *
 * The invariant now enforced, mechanically, in `toContextSource`:
 *   NO HOST-REALM OBJECT EVER ENTERS THE CONTEXT. The scope is JSON-serialised and rebuilt by a
 *   prelude that runs INSIDE the context, so every object the script can touch was constructed by
 *   the context's own intrinsics and its prototype chain terminates in the context. `console` is
 *   likewise defined in the prelude, not injected. A scope value that will not serialise is
 *   REFUSED rather than passed through.
 * If you add a parameter here, it must be JSON data. Handing in a live object, an array, a
 * function, or a class instance reopens the escape — that is what the tests at the bottom of
 * `code-sandbox.test.ts` exist to catch.
 *
 * WHAT THIS IS NOT. It is not a general code-execution tool and must not grow into one. It cannot
 * write, cannot reach the network, and cannot outlive its timeout. `run_command` in
 * `brain-tool-registry` is the general tool, and note that it is UNSANDBOXED on Windows
 * (`agui-executors.ts` gates the sandbox to macOS/Linux) — which is exactly why this path does not
 * reuse it.
 *
 * STATED LIMITS (property 5, next to the mechanism):
 *   - Synchronous only. `node:vm`'s timeout cannot interrupt a pending promise, so an async body
 *     would hang past its budget. Await is not available and a returned promise is refused.
 *   - The timeout bounds CPU, not MEMORY, and the distinction is not academic: a verified
 *     allocation loop drove V8 to `FATAL ERROR: Reached heap limit` and ABORTED the process at
 *     ~3.4s, before the watchdog fired. That kills the whole Electron main process — every window,
 *     all IPC — and no upstream turn budget bounds it. `MAX_SCOPE_BYTES` caps the input side; the
 *     allocation side is unbounded, which is the strongest remaining argument for moving this into
 *     a worker or a real isolate.
 *   - It runs on the MAIN thread. A script may block the UI for up to the timeout, per call.
 *   - Serialisation is a COPY, so a script cannot mutate anything the caller holds. That is a
 *     safety property, not just hygiene, and it costs one JSON round-trip per call.
 */

import { runInNewContext } from 'vm'

/** Hard ceiling on how long a model-authored script may occupy the main thread. */
export const CODE_TIMEOUT_MS = 3000

/** Result text is capped before it re-enters the model's context. A script that returns the whole
 *  corpus would otherwise blow the turn budget it was called to save. */
export const CODE_RESULT_MAX = 6000

export interface CodeResult {
  /** Rendered result, capped at CODE_RESULT_MAX. Empty when `error` is set. */
  output: string
  /** Present when the script threw, timed out, or never assigned `result`. */
  error?: string
  /** True when the output hit CODE_RESULT_MAX and was cut. Published, never silent. */
  truncated?: boolean
}

/** Upper bound on the serialised scope. The corpus is megabytes; this is a guard against handing
 *  the context something pathological, not a tuning knob. */
export const MAX_SCOPE_BYTES = 32 * 1024 * 1024

/** Valid JS identifier, so a scope key can be bound with `const <k> =` in the prelude without
 *  becoming an injection point of its own. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Build the prelude that reconstructs the scope INSIDE the context.
 *
 *  This is the whole security boundary, so it is a separate, testable function. Returns an error
 *  string instead of throwing so every refusal reaches the model as a normal tool result.
 *
 *  `JSON.stringify` is doing two jobs: it proves the value is inert data (a function, a class
 *  instance or a cyclic object cannot survive it), and it produces source text that the context
 *  evaluates with its OWN intrinsics — which is what severs the prototype path back to the host. */
export function toContextSource(scope: Record<string, unknown>): { source: string } | { error: string } {
  const parts: string[] = []
  for (const key of Object.keys(scope ?? {})) {
    if (!IDENT.test(key)) return { error: `scope key ${JSON.stringify(key)} is not a valid identifier` }
    let json: string
    try {
      json = JSON.stringify(scope[key])
    } catch (e) {
      return { error: `scope key "${key}" is not serialisable: ${(e as Error).message.slice(0, 120)}` }
    }
    // undefined (and a function, which stringifies to undefined) — refuse rather than bind a hole.
    if (json === undefined) return { error: `scope key "${key}" is not JSON data (functions are refused)` }
    parts.push(`const ${key} = ${json};`)
  }
  const source = parts.join('\n')
  if (source.length > MAX_SCOPE_BYTES) return { error: `scope too large (${source.length} bytes)` }
  return { source }
}

/**
 * Evaluate `code` with `scope` in a fresh context and return whatever it assigned to `result`.
 *
 * The contract is assignment, not a return value: a bare `return` is illegal at the top level of a
 * script, and requiring an expression would rule out the multi-statement bodies these questions
 * actually need (filter, then tally, then sort).
 */
export function evalInSandbox(
  code: string,
  scope: Record<string, unknown>,
  timeoutMs: number = CODE_TIMEOUT_MS
): CodeResult {
  const src = (code ?? '').trim()
  if (!src) return { output: '', error: 'no code supplied' }

  const built = toContextSource(scope ?? {})
  if ('error' in built) return { output: '', error: built.error }

  // The context object starts EMPTY. Nothing from this realm is placed in it — not the scope, not
  // `console`, not even `result`. Everything the script can reach is constructed by the prelude,
  // inside the context, from JSON text. `result` is a plain global assignment (no `let`) so that
  // reading it back off the context object works and a script may still legally write `result = …`.
  //
  // NULL PROTOTYPE, and this is load-bearing. The context object BACKS `globalThis`, so if it is an
  // ordinary `{}` its prototype is this realm's `Object.prototype` and
  // `globalThis.constructor.constructor('return process')()` walks straight out — verified: the
  // first hardening pass closed every scope-value route and this one still returned the host
  // `process`. `Object.create(null)` severs it; `globalThis.constructor` is then undefined.
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const prelude =
    `${built.source}\n` +
    'const console = { log() {}, warn() {}, error() {} };\n' +
    'var result = undefined;\n'

  try {
    runInNewContext(`${prelude}\n${src}\n;globalThis.result = result;`, sandbox, {
      timeout: timeoutMs,
      displayErrors: false
    })
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    // vm reports a timeout as "Script execution timed out." — name it, because "it failed" and "it
    // ran too long" lead to different next moves for the model (fix the code vs narrow the scan).
    if (/timed out/i.test(msg)) return { output: '', error: `timed out after ${timeoutMs}ms` }
    return { output: '', error: msg.slice(0, 300) }
  }

  const r = sandbox.result
  if (r === undefined) return { output: '', error: 'the script never assigned `result`' }
  if (r !== null && typeof (r as { then?: unknown }).then === 'function') {
    // Swallow the rejection before refusing. A script that returns `import('fs')` or calls an
    // AsyncFunction built from `'return process'` produces a promise that rejects INSIDE the
    // context; if nothing attaches a handler it escapes as an unhandled rejection in the HOST
    // process, which Node can be configured to treat as fatal. Refusing the value is not enough —
    // the dangling rejection has to be neutralised too.
    try {
      void (r as Promise<unknown>).then(
        () => {},
        () => {}
      )
    } catch {
      /* not a real promise — nothing to neutralise */
    }
    return { output: '', error: 'async is not supported — the sandbox cannot await; compute synchronously' }
  }

  let text: string
  if (typeof r === 'string') text = r
  else {
    try {
      text = JSON.stringify(r)
    } catch {
      text = String(r)
    }
  }
  text = text ?? String(r)
  if (text.length > CODE_RESULT_MAX) {
    return { output: text.slice(0, CODE_RESULT_MAX), truncated: true }
  }
  return { output: text }
}

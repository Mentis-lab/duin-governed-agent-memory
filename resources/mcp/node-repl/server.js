#!/usr/bin/env node
// DUIN — Bundled Node REPL MCP server.
//
// Exposes three tools to the model over standard MCP stdio:
//   * js                       — evaluate JS code in a persistent VM context,
//                                with top-level await and a captured console.
//   * js_reset                 — discard the VM context and start fresh.
//   * js_add_node_module_dir   — extend the resolution paths used by the in-VM
//                                require() for subsequent js calls.
//
// The server uses Node's built-in `vm` module for state isolation and
// `module.createRequire` for require() inside the sandbox. The context is
// seeded once at startup (and again after js_reset) with: console (wired to
// an in-process buffer), setTimeout/clearTimeout/setInterval/clearInterval,
// Buffer, URL, a redacted process (env stripped), and a require that walks
// the user-extended module search paths before falling back to the script's
// own require.
//
// Top-level await is supported by wrapping the user code in
//   (async () => { ${code} })()
// and awaiting the returned promise. Bare expressions return their value
// (the wrapper appends `; return undefined` only if no explicit return is
// present and the parse succeeds as a statement list).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { createRequire } from 'module'
import { statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve as pathResolve } from 'path'
import { inspect } from 'util'
import vm from 'vm'
import { assertAllowedModule } from './sandbox-guard.mjs'

const SERVER_NAME = 'node-repl'
const SERVER_VERSION = '1.0.0'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const STDOUT_CAP = 30_000
const RESULT_CAP = 30_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Module-search paths the user has added via js_add_node_module_dir. These
// are prepended to the script's own resolution paths each time we need a
// fresh `require`.
let extraModuleDirs = []

// Resolves a module id by first walking `extraModuleDirs` (with each as the
// referrer for createRequire) and then falling back to the server's own
// require. This gives the user a way to load arbitrary local packages
// without polluting NODE_PATH globally.
function buildSandboxRequire() {
  const ownRequire = createRequire(import.meta.url)
  return function sandboxRequire(id) {
    assertAllowedModule(id) // block host-access / VM-escape built-ins (defense-in-depth)
    for (const dir of extraModuleDirs) {
      try {
        // createRequire takes a path of any *file* in the directory whose
        // resolution paths we want to use; pathResolve(dir, 'noop.js')
        // gives a valid filename inside the directory even if the file
        // doesn't exist (Node only uses it to compute the parent directory).
        const dirRequire = createRequire(pathResolve(dir, 'noop.js'))
        return dirRequire(id)
      } catch (err) {
        // Only treat MODULE_NOT_FOUND as "try next dir"; anything else is a
        // real error (syntax error in the loaded module, etc.) and should
        // surface to the caller.
        if (err && err.code !== 'MODULE_NOT_FOUND') throw err
      }
    }
    return ownRequire(id)
  }
}

// Console output captured during a single js call. The console object lives
// in the VM context (it survives across calls), but we swap the underlying
// buffer at the start of each call so each call's stdout is independent.
let currentStdoutBuffer = ''
let currentStdoutTruncated = false

function appendStdout(chunk) {
  if (currentStdoutBuffer.length >= STDOUT_CAP) {
    currentStdoutTruncated = true
    return
  }
  const remaining = STDOUT_CAP - currentStdoutBuffer.length
  if (chunk.length > remaining) {
    currentStdoutBuffer += chunk.slice(0, remaining)
    currentStdoutTruncated = true
  } else {
    currentStdoutBuffer += chunk
  }
}

function formatConsoleArgs(args) {
  return args
    .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 80 })))
    .join(' ')
}

function makeSandboxConsole() {
  const log = (...args) => appendStdout(formatConsoleArgs(args) + '\n')
  return {
    log,
    info: log,
    warn: log,
    error: log,
    debug: log,
    trace: log,
    dir: (obj, opts) => appendStdout(inspect(obj, opts ?? { depth: 4 }) + '\n')
  }
}

// process is exposed in the sandbox but with env stripped — env may contain
// API keys / tokens that the user did not intend the model to see. Other
// process fields (platform, versions, cwd, pid, arch) stay so introspection
// works as expected.
function makeSandboxProcess() {
  return {
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: { ...process.versions },
    pid: process.pid,
    cwd: () => process.cwd(),
    env: {},
    hrtime: process.hrtime.bind(process),
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args))
  }
}

// Build a fresh VM context with the standard seeded globals. Called at
// startup and again on js_reset.
function buildSandboxContext() {
  const sandbox = {
    console: makeSandboxConsole(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController,
    AbortSignal,
    process: makeSandboxProcess(),
    require: buildSandboxRequire()
  }
  // Self-reference so `globalThis` and `global` inside the sandbox both
  // resolve to the same object.
  sandbox.globalThis = sandbox
  sandbox.global = sandbox
  return vm.createContext(sandbox)
}

let sandboxContext = buildSandboxContext()

// Persistent-binding REPL semantics.
//
// vm.runInContext runs each call as a fresh Script in the SAME global. `var`
// declarations at script top-level become globals (so they survive across
// calls); `let` and `const` are lexical and die when the script finishes.
// Node's own REPL works around this with --experimental-repl-await, which
// AST-rewrites declarations. We do a smaller version of the same trick:
//
//   1. If the code contains a top-level `await`, wrap it in an async IIFE
//      so `await` parses; otherwise run it as a bare script (then bindings
//      stick automatically).
//   2. Inside either branch, transform top-level `let X` / `const X` into
//      `var X` so the binding hoists onto the context's global object. Loss
//      of const-ness is a known REPL quirk — documented in the README.
//   3. For the async-IIFE branch, additionally mirror the discovered
//      identifiers back to `globalThis` at the end of the IIFE so the
//      values populated INSIDE the IIFE escape its function scope.

const TOP_LEVEL_AWAIT_RE = /(?:^|[\s;{(,!?=:&|+\-*/%<>~^])await\s/m

// Blank out the BODIES of function-ish constructs only: `function f(...) { }`,
// `async function`, generators, methods written as `name(...) { }`, and arrow
// bodies. Iterates innermost-first so nesting resolves.
//
// The point is what it does NOT strip. `for`/`if`/`while`/`switch`/`try`/`catch`
// blocks are control flow, not functions: an `await` inside one IS top-level
// await. The previous version peeled EVERY `{…}` pair, so
// `for (const x of xs) { await f(x) }` — the single most natural top-level-await
// shape — scanned as having none, skipped the async IIFE wrap, and threw
// `SyntaxError: await is only valid in async functions`, despite the tool's own
// description promising top-level await.
//
// Still not a parser (that would want acorn), but the failure direction now
// matters less: over-detecting merely takes the IIFE path, which is supported and
// already handles binding persistence. Under-detecting is a hard SyntaxError.
const FN_HEAD = String.raw`(?:\bfunction\s*\*?\s*[\w$]*\s*\([^()]*\)|\b(?:async\s+)?[\w$]+\s*\([^()]*\)|=>)\s*`
const CONTROL_HEAD = /(?:^|[^\w$])(?:if|for|while|switch|catch|with|do)\s*\($/

function stripFunctionBodies(code) {
  const re = new RegExp(FN_HEAD + String.raw`\{[^{}]*\}`, 'g')
  let out = code
  let prev = ''
  while (out !== prev) {
    prev = out
    out = out.replace(re, (match, offset, whole) => {
      // `if (x) { … }` also matches the `name(...) {` alternative above. Look at
      // what precedes the paren: a control keyword means this is NOT a function.
      const headEnd = match.indexOf('(')
      const before = whole.slice(0, offset + (headEnd < 0 ? 0 : headEnd + 1))
      if (CONTROL_HEAD.test(before)) return match
      const brace = match.indexOf('{')
      return match.slice(0, brace) + '{}'
    })
  }
  return out
}

function hasTopLevelAwait(code) {
  return TOP_LEVEL_AWAIT_RE.test(stripFunctionBodies(code))
}

// Rewrite TOP-LEVEL `let X` / `const X` to `var X`, so the binding survives into
// the next call (see topLevelVarNames). "Top level" means: brace depth 0, not inside
// a string, template literal, or comment.
//
// The old version was a line-anchored regex with no depth or quote awareness, so it
// rewrote things it had no business touching:
//
//   let total = 0            ->  var total = 0
//   if (true) {              ->  if (true) {
//     let total = 99         ->    var total = 99      <-- same binding now
//   }                        ->  }
//   total                    ->  99, silently. A block-scoped variable reused under
//                                an outer name overwrote the outer one instead of
//                                shadowing it — confidently wrong numbers, no error.
//
// and it edited the CONTENTS of template literals, so a string containing a line
// beginning `let ` came back with `var ` in it.
//
// Not a parser (regex literals are not tracked — a `/}/` could throw the depth off).
// That direction is safe: a miscount leaves a `let` as `let`, which keeps correct
// lexical semantics and merely declines to persist the binding. The old failure
// direction — rewriting a `let` that should have stayed block-scoped — produced
// wrong answers.
const BACKSLASH = String.fromCharCode(92)

function rewriteLexicalDeclsToVar(code) {
  // Frames: {kind:'code', depth} for real code, {kind:'tpl'} for template text.
  // A `${` inside template text pushes a fresh code frame; its matching `}` pops it.
  const stack = [{ kind: 'code', depth: 0 }]
  const top = () => stack[stack.length - 1]
  const atTopLevel = () => stack.length === 1 && stack[0].depth === 0

  let out = ''
  let i = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  let lineStart = true

  while (i < code.length) {
    const c = code[i]
    const c2 = code[i + 1]

    if (lineComment) {
      out += c
      if (c === '\n') { lineComment = false; lineStart = true }
      i++
      continue
    }
    if (blockComment) {
      if (c === '*' && c2 === '/') { out += '*/'; blockComment = false; i += 2 } else { out += c; i++ }
      continue
    }
    if (quote !== null) {
      if (c === BACKSLASH && c2 !== undefined) { out += c + c2; i += 2; continue }
      if (c === quote) quote = null
      out += c
      i++
      continue
    }
    if (top().kind === 'tpl') {
      if (c === BACKSLASH && c2 !== undefined) { out += c + c2; i += 2; continue }
      if (c === '`') { stack.pop(); out += c; i++; continue }
      if (c === '$' && c2 === '{') { stack.push({ kind: 'code', depth: 0 }); out += '${'; i += 2; continue }
      out += c
      i++
      continue
    }

    // --- code frame ---
    if (c === '/' && c2 === '/') { lineComment = true; out += '//'; i += 2; continue }
    if (c === '/' && c2 === '*') { blockComment = true; out += '/*'; i += 2; continue }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue }
    if (c === '`') { stack.push({ kind: 'tpl' }); out += c; i++; continue }
    if (c === '{') { top().depth++; out += c; i++; lineStart = false; continue }
    if (c === '}') {
      if (top().depth === 0 && stack.length > 1) stack.pop() // closes a ${ … } hole
      else top().depth--
      out += c
      i++
      lineStart = false
      continue
    }
    if (c === '\n') { out += c; i++; lineStart = true; continue }

    if (lineStart && atTopLevel()) {
      const m = /^(let|const)(\s+)/.exec(code.slice(i))
      if (m) { out += 'var' + m[2]; i += m[0].length; lineStart = false; continue }
    }
    if (c !== ' ' && c !== '\t') lineStart = false
    out += c
    i++
  }
  return out
}

/** Index just past the string/template literal that starts at `i`. */
function skipQuoted(s, i) {
  const quote = s[i]
  for (i += 1; i < s.length; i += 1) {
    if (s[i] === '\\') i += 1
    else if (s[i] === quote) return i + 1
  }
  return i
}

/**
 * Split a `var` declarator list on the commas that actually separate
 * declarators — i.e. those at nesting depth 0. A comma inside a destructuring
 * pattern, a call's argument list, an object/array literal, or a string is
 * separating something else.
 */
function splitTopLevelCommas(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(text, i) - 1
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * Index of the end of an initializer / default value beginning at `i`: the next
 * depth-0 comma, or the bracket closing the pattern we sit inside. Everything
 * in between is an expression, so no identifier in it is a binding.
 */
function skipInitializer(text, i) {
  let depth = 0
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(text, i) - 1
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return i
      depth -= 1
    } else if (ch === ',' && depth === 0) return i
  }
  return i
}

/** Add every identifier a single declarator BINDS to `out`. Covers the plain
 *  `x = init` form and destructuring (`{ a, b: c, d = 1, ...rest }`, `[x, y]`),
 *  skipping property keys (`a:`) and initializer/default expressions — neither
 *  of those introduces a binding. */
function collectBindingNames(declarator, out) {
  let i = 0
  while (i < declarator.length) {
    const ch = declarator[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(declarator, i)
      continue
    }
    if (ch === '/' && declarator[i + 1] === '/') break // rest of the line is a comment
    if (ch === '=') {
      i = skipInitializer(declarator, i + 1)
      continue
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(declarator.slice(i))
    if (!id) {
      i += 1
      continue
    }
    i += id[0].length
    // `key:` names a property; the binding is whatever follows the colon.
    if (!/^\s*:/.test(declarator.slice(i))) out.add(id[0])
  }
  return out
}

// Collect the top-level `var` binding names a line declares. Used by the
// async-IIFE branch to mirror values back to globalThis.
//
// This used to be `line.match(/^[ \t]*var\s+([^=;]+?)\s*(=|;|$)/)` plus a naive
// split on ','. The capture class `[^=;]` cannot cross an `=`, so the match
// stopped at the FIRST initializer and every later declarator on the line was
// dropped: `var a = 1, b = await f()` mirrored only `a`, and a destructuring
// head got split mid-pattern so `var { data, ok } = await f()` mirrored only
// `ok` while `var { data } = await f()` mirrored nothing at all.
//
// What made it invisible: a dropped name raises no error anywhere. The js call
// still answers `=> undefined`, and a later call reading the name just gets
// `undefined` — or a stale value an earlier call left on the same global.
//
// Declared limits, both unchanged from the previous regex and both out of
// scope here: the scan is anchored per line at the FIRST `var`, so (a) a
// declarator list wrapped across several lines contributes only the names on
// its `var` line, and (b) a second `var` statement later on the same line is
// not seen. Finding `var` at statement position without a parser is what
// produces false bindings, so this stays anchored.
function topLevelVarNames(code) {
  const names = new Set()
  for (const line of code.split('\n')) {
    const head = /^[ \t]*var\s+/.exec(line)
    if (!head) continue
    for (const declarator of splitTopLevelCommas(line.slice(head[0].length))) {
      collectBindingNames(declarator, names)
    }
  }
  return [...names]
}

function wrapForEvaluation(code) {
  const rewritten = rewriteLexicalDeclsToVar(code)
  const needsAwait = hasTopLevelAwait(rewritten)

  if (!needsAwait) {
    // Bare-script path: top-level `var` lands on the context global; the
    // script's final-expression value is the return value. Wrap in a Promise
    // so the caller's `await Promise.race(...)` semantics are uniform.
    return {
      source: rewritten,
      isAsync: false
    }
  }

  // Async path. Try expression form first so `await fetch(...)` evaluates
  // to its value; on parse failure (declarations, multi-statement), fall back
  // to statement form, and mirror top-level var bindings out to globalThis
  // so they survive the IIFE's function scope.
  const exprForm = `(async () => { return (${rewritten}); })()`
  try {
    new vm.Script(exprForm, { filename: 'repl-async-expr-probe.js' })
    return { source: exprForm, isAsync: true }
  } catch {
    const names = topLevelVarNames(rewritten)
    // Guarded per name: the collector reads source text, not an AST, so a token
    // that merely LOOKS like a declarator (an identifier inside a block comment,
    // a computed key `{ [k]: v }`) must not turn a working call into a
    // ReferenceError. An unbound name simply fails to mirror instead.
    const mirror = names.map((n) => `try { globalThis.${n} = ${n} } catch {}`).join('\n')
    return {
      source: `(async () => { ${rewritten}\n${mirror}\n})()`,
      isAsync: true
    }
  }
}

function stringifyResult(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return inspect(value, { depth: 4, breakLength: 80, colors: false })
  } catch (err) {
    return `[unstringifiable: ${err?.message ?? String(err)}]`
  }
}

async function evaluateJs(rawCode, timeoutMs) {
  currentStdoutBuffer = ''
  currentStdoutTruncated = false

  const code = typeof rawCode === 'string' ? rawCode : ''
  if (!code.trim()) {
    throw new Error('Empty `code` argument.')
  }

  const { source, isAsync } = wrapForEvaluation(code)
  const script = new vm.Script(source, { filename: 'repl.js' })

  const timeout =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS))
      : DEFAULT_TIMEOUT_MS

  const syncValue = script.runInContext(sandboxContext, {
    timeout,
    breakOnSigint: true
  })

  let value
  if (isAsync) {
    // IIFE returns a Promise; race against an async-side timeout because
    // vm.Script's timeout only covers synchronous execution.
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Evaluation timed out after ${timeout} ms.`)),
        timeout
      ).unref?.()
    })
    value = await Promise.race([syncValue, timeoutPromise])
  } else {
    value = syncValue
  }

  let stdout = currentStdoutBuffer
  if (currentStdoutTruncated) stdout += `\n[stdout truncated at ${STDOUT_CAP} chars]`

  let resultStr = stringifyResult(value)
  if (resultStr.length > RESULT_CAP) {
    resultStr = resultStr.slice(0, RESULT_CAP) + `\n[result truncated at ${RESULT_CAP} chars]`
  }

  const parts = []
  if (stdout) parts.push(stdout.replace(/\n+$/, ''))
  parts.push(`=> ${resultStr}`)
  return parts.join('\n')
}

function resetSandbox() {
  sandboxContext = buildSandboxContext()
  currentStdoutBuffer = ''
  currentStdoutTruncated = false
  return 'Context reset.'
}

function addNodeModuleDir(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('`path` argument is required and must be a non-empty string.')
  }
  const absolute = pathResolve(rawPath)
  let stat
  try {
    stat = statSync(absolute)
  } catch (err) {
    throw new Error(`Path not accessible: ${absolute} (${err?.code ?? err?.message ?? 'error'})`, {
      cause: err
    })
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absolute}`)
  }
  if (!extraModuleDirs.includes(absolute)) {
    extraModuleDirs.unshift(absolute)
  }
  // Rebuild require so existing context picks up the new path. We mutate the
  // existing sandbox rather than rebuild the context — the user's bindings
  // stay intact.
  sandboxContext.require = buildSandboxRequire()
  return `Added module resolution path: ${absolute}\nCurrent extra paths (${extraModuleDirs.length}):\n${extraModuleDirs.map((p) => '  ' + p).join('\n')}`
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
)

// Spec annotations: this server EXECUTES CODE, so its eval-class tools declare
// destructiveHint explicitly instead of relying on any client's name heuristic.
// The 2026-08-14 estate audit found DUIN's own verb heuristic classified `js` as
// a harmless network read (no verb in the name) and auto-ran it — the host now
// also fail-closes the whole server id (tool-registry CODE_EXEC_SERVER_IDS), and
// these hints make the intent explicit to ANY spec-compliant MCP client.
const TOOLS = [
  {
    name: 'js',
    description:
      'Evaluate JavaScript code in a persistent Node.js VM context. State (variables, requires, listeners) survives across calls until js_reset. Top-level await is supported. A single expression returns its value (e.g. `2 + 2` → 4); a statement block returns undefined. console.log output is captured and prepended to the result. Default timeout 30000 ms, ceiling 300000 ms.',
    annotations: { title: 'Run JavaScript', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript source to evaluate. May be a single expression or a block of statements. Top-level await is supported.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Default 30000, ceiling 300000.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'js_reset',
    description:
      'Discard the persistent VM context and start with a fresh sandbox. All variables, requires, timers, and other state from prior js calls are cleared. Extra module-resolution paths added via js_add_node_module_dir are preserved.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'js_add_node_module_dir',
    description:
      'Add an absolute or relative directory path that subsequent js calls will consult when resolving require() requests. The directory must exist. Paths are tried in most-recently-added-first order before falling back to the server bundle.',
    // Widens what code the sandbox can load (arbitrary local packages) — gate it
    // like the eval tool it feeds.
    annotations: { title: 'Add require() path', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to add. Resolved against the server CWD if relative.'
        }
      },
      required: ['path']
    }
  }
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    if (name === 'js') {
      const text = await evaluateJs(args?.code, args?.timeout_ms)
      return { content: [{ type: 'text', text }] }
    }
    if (name === 'js_reset') {
      return { content: [{ type: 'text', text: resetSandbox() }] }
    }
    if (name === 'js_add_node_module_dir') {
      return { content: [{ type: 'text', text: addNodeModuleDir(args?.path) }] }
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }]
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${message}` }]
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

// Suppress noisy stderr from unhandled rejections so the MCP client doesn't
// surface them as transport errors; the failing tool call already returns an
// isError response.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  process.stderr.write(`[node-repl] unhandled rejection: ${msg}\n`)
})

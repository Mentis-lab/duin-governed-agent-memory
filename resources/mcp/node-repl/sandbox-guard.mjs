// sandbox-guard.mjs — the require() denylist for the `js` MCP tool's VM sandbox.
//
// The js tool is a COMPUTE scratchpad, not a shell. Host-access built-ins
// (child_process, fs, net, …) and VM-escape vectors (vm, module, worker_threads,
// process) are blocked inside the sandbox: code that needs the filesystem,
// processes, or the network must use the app's GATED tools (read_file /
// shell_command), which pass through the permission layer.
//
// SCOPE / HONESTY: Node's `vm` is NOT a complete security boundary — a determined
// `(function(){}).constructor('return process')()` escape can still reach the real
// global. This denylist closes the *trivial, documented* `require('child_process')`
// bypass as defense-in-depth; it is not a substitute for true isolation (a hardened
// separate process with dropped privileges, or isolated-vm). See the sandbox
// hardening follow-up.

/** Host-access / escape built-ins blocked inside the js sandbox. */
export const DENIED_BUILTINS = new Set([
  'child_process',
  'fs',
  'fs/promises',
  'net',
  'tls',
  'http',
  'http2',
  'https',
  'dgram',
  'dns',
  'dns/promises',
  'vm',
  'module',
  'worker_threads',
  'cluster',
  'inspector',
  'inspector/promises',
  'repl',
  'v8',
  'process'
])

/** Normalize a require id: strip the optional `node:` scheme so `node:fs` and `fs`
 *  are treated identically. Non-string ids normalize to ''. */
export function normalizeModuleId(id) {
  const s = typeof id === 'string' ? id.trim() : ''
  return s.startsWith('node:') ? s.slice(5) : s
}

/** True when `id` resolves to a denied host-access / escape built-in. */
export function isDeniedModule(id) {
  return DENIED_BUILTINS.has(normalizeModuleId(id))
}

/** Throw a clear, coded error if `id` is denied; otherwise return it. */
export function assertAllowedModule(id) {
  if (isDeniedModule(id)) {
    const err = new Error(
      `require('${id}') is blocked in the js sandbox: host access (filesystem, ` +
        `processes, network) is not permitted here — use the app's gated tools ` +
        `(read_file / shell_command) instead.`
    )
    err.code = 'ERR_SANDBOX_DENIED'
    throw err
  }
  return id
}

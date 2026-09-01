// lark-cli exec provider for the native Feishu routes (feishu-comms-native's
// Exec). Resolves the CLI robustly (the npm-global `lark-cli.cmd` — a bare
// `lark-cli` lookup fails when the Electron process didn't inherit the shell PATH)
// and spawns it. On Windows a .cmd cannot be spawned directly (Node blocks it
// post-CVE-2024), so we go through `cmd.exe /c` — and THAT is a command-injection
// seam we now close here, centrally (see escapeCmdArg).
//
// WHY THIS WAS INVISIBLE: this header used to assert "callers sanitize `& | < >`
// upstream". No caller ever did — the invariant was documented but implemented
// nowhere, the classic unenforced-guard shape. It read as safe because the args ARE
// passed as an array: `spawn('cmd.exe', ['/c', cli, ...args])` looks like the
// textbook no-shell form. But without `shell:true` Node applies only MSVCRT argv
// quoting, which leaves a metachar-bearing token with no spaces/quotes BARE on the
// command line — and cmd.exe then re-parses it, honouring `&`/`|`/`>` as command
// separators. Verified: spawnSync('cmd.exe',['/c','echo','A','&','echo','INJECTED'])
// runs the second command. Since these args carry model-controlled values (a
// feishu_create_doc `title`, a calendar `summary`), and `write-reversible` tools are
// auto-allowed under the default trusted-afk posture while screenCommand only ever
// inspects run_command/start_command, this was prompt-injection → unscreened RCE.
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Exec, ExecResult } from './brain/feishu-comms-native'
import { messageOf } from './guarded'

/** Absolute path to lark-cli, or the bare name as a PATH fallback. */
export function resolveLarkCli(): string {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA
    if (appdata) {
      const p = join(appdata, 'npm', 'lark-cli.cmd')
      if (existsSync(p)) return p
    }
    return 'lark-cli'
  }
  return 'lark-cli'
}

/** MSVCRT argv quoting — how the *target* program (node, via the .cmd shim) splits
 *  its command line back into argv.
 *
 *  Two rules, both load-bearing and both verified against a real cmd.exe + .cmd shim:
 *   - An embedded quote is emitted as `""`, NOT as `\"`. Both are valid MSVCRT
 *     escapes, but `\"` is fatal here: the backslash is meaningless to cmd.exe, so
 *     cmd sees a lone quote, flips into quoted-state, and the caret-escaping below
 *     stops protecting the rest of the argument — `a"&echo PWNED` then EXECUTES.
 *     `""` keeps cmd's quote parity even, so it never enters quoted-state at all.
 *   - Backslashes are special only immediately before a quote (and at the very end,
 *     which abuts the closing quote), so a run is doubled there and left alone
 *     everywhere else — otherwise `C:\Users\me\` swallows the following argument.
 *  PURE. */
function msvcrtQuote(arg: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2) + '""'
      slashes = 0
      continue
    }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

/** Escape one argument so it survives BOTH cmd.exe's parse and the target program's
 *  argv split, carrying arbitrary metacharacters as literal data.
 *
 *  The order matters and is the whole trick: MSVCRT-quote first, then `^`-escape
 *  every cmd metacharacter INCLUDING the quotes we just added. Escaping the quotes
 *  means cmd.exe never enters a quoted state at all, so there is no quoting context
 *  an embedded `"` could break out of — every metachar is individually neutralised
 *  by its `^`. cmd strips the carets and hands the target the MSVCRT-quoted form.
 *  (Quoting ALONE is not enough: `a"&b"` would let the inner quote close the string
 *  and expose the `&`. This only holds because msvcrtQuote emits `""` rather than
 *  `\"` — see the note there; with `\"` this scheme still executes the payload.)
 *
 *  Known residue: `%VAR%` is expanded by cmd before caret processing and cannot be
 *  escaped on a command line. That is an env-var read, not code execution, so the
 *  injection-to-RCE path this closes is unaffected.
 *
 *  LINE BREAKS ARE REFUSED, and that one is not cosmetic. A raw LF cannot be escaped
 *  on a cmd.exe command line at all — cmd TERMINATES the line there. Measured, not
 *  assumed: echoing an escaped two-line argument followed by a TRAILING marker prints
 *  only the first line and drops the marker, so BOTH the rest of the argument and
 *  every argument after it are silently discarded. On the Feishu send path that meant
 *  a `--dry-run` placed after the message text fell off the command line the instant
 *  the message contained an ordinary paragraph break — a preview that actually sent.
 *  (A lone CR does not truncate; cmd deletes it, so the two halves arrive joined.)
 *
 *  Throwing is deliberate. The alternatives are to truncate the operator's message
 *  silently, which is what happened before, or to rewrite its content behind their
 *  back. Carrying a multi-line body through this path needs stdin or a temp file,
 *  not a cleverer escape. PURE apart from the throw. */
export function escapeCmdArg(arg: string): string {
  const at = arg.search(/[\r\n]/)
  if (at !== -1) {
    const which = arg[at] === '\n' ? 'newline' : 'carriage return'
    throw new Error(
      `escapeCmdArg: argument contains a ${which} at index ${at}; cmd.exe cannot carry ` +
        'one on a command line (it terminates the line, silently dropping the rest of ' +
        'the argument and every argument after it). Send multi-line text via stdin or a file.'
    )
  }
  return msvcrtQuote(arg).replace(/[()%!^"<>&|]/g, '^$&')
}

/** Build an Exec that runs `lark-cli <args>` and returns {stdout, stderr, code}.
 *  40s timeout matches the Python subprocess ceiling. */
export function larkExec(timeoutMs = 40_000): Exec {
  const cli = resolveLarkCli()
  const isWin = process.platform === 'win32'
  return (args: string[]): Promise<ExecResult> =>
    new Promise<ExecResult>((resolve) => {
      const prog = isWin ? 'cmd.exe' : cli
      // On win32 we hand cmd.exe a command line WE escaped, so Node must not re-quote
      // it: windowsVerbatimArguments joins these with spaces and passes them through.
      // (POSIX spawns the CLI directly with no shell — nothing to escape there.)
      const spawnArgs = isWin ? ['/c', escapeCmdArg(cli), ...args.map(escapeCmdArg)] : args
      let child
      try {
        child = spawn(prog, spawnArgs, {
          windowsHide: true,
          env: process.env,
          ...(isWin ? { windowsVerbatimArguments: true } : {})
        })
      } catch (e) {
        resolve({ stdout: '', stderr: `spawn failed: ${(e as Error)?.message ?? e}`, code: -1 })
        return
      }
      let out = ''
      let err = ''
      let done = false
      const finish = (r: ExecResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch (e) { console.debug('[lark-exec] already gone:', messageOf(e)) }
        finish({ stdout: out, stderr: err || 'lark-cli timed out', code: -1 })
      }, timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (d) => (out += d))
      child.stderr?.on('data', (d) => (err += d))
      child.on('error', (e) => finish({ stdout: '', stderr: String(e?.message ?? e), code: -1 }))
      child.on('close', (code) => finish({ stdout: out, stderr: err, code: code ?? -1 }))
    })
}

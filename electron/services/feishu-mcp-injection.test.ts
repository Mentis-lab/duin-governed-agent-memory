// Guards the command-injection seam in the BUNDLED Feishu MCP server
// (resources/mcp/feishu/server.js, function runLark).
//
// Why this mattered: `feishu` is a default server (mcp-defaults.ts seeds it enabled
// whenever lark-cli resolves) and none of its tools matches MCP_MUTATING_VERB, so
// classifyMcpTool returns requiresApproval:false — the model calls them with no
// prompt and picks the argument values. Content the agent merely READS (an ingested
// mail, a Feishu chat, a web page) could therefore steer `query` to `x & calc.exe`.
//
// WHY IT WAS INVISIBLE: runLark passed an argv ARRAY to spawn, which reads as the
// textbook safe form, and the comment above it asserted "Node quotes the argv".
// With shell:true Node does the opposite — it concatenates argv WITHOUT escaping
// (DEP0190) — so the array was decorative and cmd.exe re-parsed the metacharacters.
//
// These tests drive the REAL server.js as a subprocess against a REAL cmd.exe and a
// REAL .cmd shim, because string-level assertions about the escaping are exactly what
// missed this the first time: the shape looked safe while the payload still executed.
// Only the round trip through cmd.exe proves anything.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { writeFileSync, mkdtempSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import { tmpdir } from 'os'

const isWin = process.platform === 'win32'

// The production entry point, verbatim — not a copy of its logic.
const SERVER = resolvePath(__dirname, '../../resources/mcp/feishu/server.js')

let fakeCli = ''
beforeAll(() => {
  if (!isWin) return
  // Same shape as the npm global shim runLark actually resolves: a batch file that
  // forwards %* to node. The batch layer is part of what the escaping must survive.
  const dir = mkdtempSync(join(tmpdir(), 'feishu-mcp-test-'))
  writeFileSync(join(dir, 'argv-dump.js'), 'console.log(JSON.stringify(process.argv.slice(2)))')
  writeFileSync(join(dir, 'lark-cli.cmd'), '@ECHO OFF\r\nnode "%~dp0argv-dump.js" %*\r\n')
  fakeCli = join(dir, 'lark-cli.cmd')
})

/** Speak MCP to the real server over stdio: one tools/call, return its text result. */
function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SERVER], {
      // LARK_CLI_PATH is resolveLarkCli's documented override, so the server under
      // test runs its real resolution path and lands on our shim.
      env: { ...process.env, LARK_CLI_PATH: fakeCli },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error(`timed out; stdout so far: ${buf}`))
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as {
          id?: number
          result?: { content?: Array<{ text?: string }> }
        }
        if (msg.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolvePromise(msg.result?.content?.[0]?.text ?? '')
          return
        }
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      rejectPromise(e)
    })
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args }
        }) +
        '\n'
    )
  })
}

/** The shim echoes its argv as JSON on the first line. Anything after it is output
 *  from a SECOND command — i.e. an injection that executed. */
function split(text: string): { argv: string[] | null; residue: string } {
  const trimmed = text.trim()
  const nl = trimmed.indexOf('\n')
  const head = nl >= 0 ? trimmed.slice(0, nl) : trimmed
  const residue = nl >= 0 ? trimmed.slice(nl + 1) : ''
  try {
    return { argv: JSON.parse(head.trim()) as string[], residue }
  } catch {
    return { argv: null, residue: trimmed }
  }
}

describe.runIf(isWin)('bundled feishu MCP server — lark-cli argv injection', () => {
  it('confirms the vulnerability the escaping closes', () => {
    // The exact old shape: spawn(`"${cli}"`, argv, { shell: true }) concatenates
    // without escaping, so cmd.exe honours the `&` as a command separator.
    const r = spawnSync('"cmd"', ['/c', 'echo', 'SAFE', '&', 'echo', 'INJECTED'], { shell: true })
    expect(r.stdout.toString()).toContain('INJECTED')
  })

  const hostile: Array<[string, string]> = [
    ['ampersand', 'notes&echo PWNED'],
    ['pipe', 'a|echo PWNED'],
    ['embedded quote then ampersand', 'a"&echo PWNED'],
    ['caret', 'a^&echo PWNED']
  ]

  it.each(hostile)(
    'carries a hostile %s query through feishu_search_chats as inert data',
    async (_label, payload) => {
      const { argv, residue } = split(await callTool('feishu_search_chats', { query: payload }))
      expect(residue, 'a second command executed').not.toMatch(/PWNED/)
      // And the value still arrives intact — safety must not cost correctness.
      expect(argv).toEqual(['im', '+chat-search', '--query', payload])
    }
  )

  it('carries a hostile feishu_api path and JSON body through as inert data', async () => {
    // feishu_api is the same seam via a different build(): `path` is interpolated raw
    // and --params/--data carry JSON, whose quotes and braces must survive intact.
    const path = '/open-apis/im/v1/chats&echo PWNED'
    const { argv, residue } = split(
      await callTool('feishu_api', { method: 'GET', path, params: { q: 'a&echo PWNED', n: 1 } })
    )
    expect(residue, 'a second command executed').not.toMatch(/PWNED/)
    expect(argv).toEqual(['api', 'GET', path, '--params', JSON.stringify({ q: 'a&echo PWNED', n: 1 })])
  })

  it('delivers a legitimate query unchanged', async () => {
    const { argv } = split(
      await callTool('feishu_search_chats', { query: 'Notes on "Project X" (Q1)' })
    )
    expect(argv).toEqual(['im', '+chat-search', '--query', 'Notes on "Project X" (Q1)'])
  })
})

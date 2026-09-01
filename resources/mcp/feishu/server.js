#!/usr/bin/env node
'use strict'

// Feishu / Lark MCP server for DUIN — a thin, zero-dependency stdio MCP that
// wraps the `lark-cli` binary. It reuses lark-cli's EXISTING auth (whatever app
// is bound as `currentApp`, acting `--as user`), so DUIN's agent gets the same
// Feishu surface the operator's own CLI has — with no secret handling here.
//
// Strategy: connection is a commodity — ride the CLI the operator already
// trusts, expose it over MCP, and let the brain do the comprehension.
//
// Protocol: MCP over stdio = newline-delimited JSON-RPC 2.0. We implement the
// minimum: initialize, tools/list, tools/call (+ ignore notifications).

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PROTOCOL_VERSION = '2024-11-05'

// A spawned child may not inherit the shell's npm-global PATH, so resolve the
// lark-cli binary explicitly (env override → npm global bin → bare PATH).
function resolveLarkCli() {
  if (process.env.LARK_CLI_PATH && fs.existsSync(process.env.LARK_CLI_PATH)) return process.env.LARK_CLI_PATH
  const roots = [process.env.APPDATA, process.env.HOME, process.env.USERPROFILE].filter(Boolean)
  const names = process.platform === 'win32' ? ['lark-cli.cmd', 'lark-cli'] : ['lark-cli']
  for (const r of roots) {
    for (const n of names) {
      const c = path.join(r, 'npm', n)
      if (fs.existsSync(c)) return c
    }
  }
  return 'lark-cli'
}
const LARK_CLI = resolveLarkCli()

// Each tool maps to a lark-cli invocation. `build(args)` returns the argv array
// passed to lark-cli. Read-only by default; the generic escape hatch (feishu_api)
// covers the full surface (docs, base, drive, sending) for the agent.
const TOOLS = [
  {
    name: 'feishu_list_chats',
    description: "List the Feishu/Lark chats and groups you're a member of. Use to discover chat_ids.",
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'string', description: "Comma list of chat types: group,p2p (default group)" }
      }
    },
    build: (a) =>
      a.types ? ['im', '+chat-list', '--types', String(a.types)] : ['im', '+chat-list']
  },
  {
    name: 'feishu_search_chats',
    description: 'Search your visible Feishu group chats by name keyword. Returns chat_ids.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Group name keyword to search for' } },
      required: ['query']
    },
    build: (a) => ['im', '+chat-search', '--query', String(a.query || '')]
  },
  {
    name: 'feishu_read_messages',
    description: 'Read recent messages in a Feishu chat or 1:1 conversation. Provide chat_id OR user_id (a person name resolves to a p2p chat).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        user_id: { type: 'string', description: 'Person name or open_id for a 1:1 conversation' }
      }
    },
    build: (a) => {
      const args = ['im', '+chat-messages-list']
      if (a.chat_id) args.push('--chat-id', String(a.chat_id))
      else if (a.user_id) args.push('--user-id', String(a.user_id))
      return args
    }
  },
  {
    name: 'feishu_calendar_agenda',
    description: 'List your upcoming Feishu calendar events (agenda).',
    inputSchema: { type: 'object', properties: {} },
    build: () => ['calendar', '+agenda']
  },
  {
    name: 'feishu_api',
    description: 'Generic Feishu/Lark OpenAPI call (the full surface: docs, base/bitable, drive, messages, contact). GET/POST/etc. against an /open-apis/... path.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method e.g. GET, POST' },
        path: { type: 'string', description: 'API path e.g. /open-apis/im/v1/chats' },
        params: { type: 'object', description: 'Query params object (for GET)' },
        data: { type: 'object', description: 'JSON body object (for POST/PUT)' }
      },
      required: ['method', 'path']
    },
    build: (a) => {
      const args = ['api', String(a.method || 'GET').toUpperCase(), String(a.path || '')]
      if (a.params && Object.keys(a.params).length) args.push('--params', JSON.stringify(a.params))
      if (a.data && Object.keys(a.data).length) args.push('--data', JSON.stringify(a.data))
      return args
    }
  }
]

// MSVCRT argv quoting — how the *target* program (node, via the .cmd shim) splits
// its command line back into argv. An embedded quote must be emitted as `""`, NOT
// `\"`: the backslash means nothing to cmd.exe, so cmd would see a lone quote, flip
// into quoted-state, and the caret-escaping below would stop protecting the rest of
// the argument. Backslashes are special only immediately before a quote (and at the
// very end, which abuts the closing quote), so a run is doubled there and left alone
// everywhere else — otherwise `C:\Users\me\` swallows the following argument. PURE.
function msvcrtQuote(arg) {
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

// Escape one argument so it survives BOTH cmd.exe's parse and the target program's
// argv split, carrying arbitrary metacharacters as literal data. Order is the whole
// trick: MSVCRT-quote first, then `^`-escape every cmd metacharacter INCLUDING the
// quotes we just added, so cmd never enters a quoted state at all — leaving no
// quoting context an embedded `"` could break out of. Every metacharacter is instead
// neutralised individually by its `^`, which cmd strips before handing the target the
// MSVCRT-quoted form. Known residue: `%VAR%` expands before caret processing and
// cannot be escaped
// on a command line — an env-var read, not code execution. PURE.
//
// DUPLICATED, deliberately: the canonical copy is escapeCmdArg in
// electron/services/lark-exec.ts. This file ships via electron-builder
// extraResources as a standalone zero-dependency script (launched as
// `process.execPath <path>` with ELECTRON_RUN_AS_NODE=1), so it cannot require
// anything out of the bundled main process. Keep the two in lockstep; the round-trip
// test in electron/services/feishu-mcp-injection.test.ts guards this copy directly.
function escapeCmdArg(arg) {
  return msvcrtQuote(arg).replace(/[()%!^"<>&|]/g, '^$&')
}

function runLark(argv) {
  return new Promise((resolve) => {
    // WHY NOT shell:true: the comment that used to sit here claimed "Node quotes the
    // argv". It does not — with shell:true Node CONCATENATES argv without escaping
    // (Node docs; DEP0190), so cmd.exe re-parsed any `&`/`|`/`>` in a value as a
    // command separator. Every value here is model-controlled (a feishu_search_chats
    // `query`, a feishu_api `path`/`--params`/`--data`), and none of these tools trips
    // MCP_MUTATING_VERB, so they run unapproved — which made content the agent merely
    // READS (an ingested mail, a chat, a web page) a prompt-injection → RCE path.
    // Mirrors lark-exec.ts: we escape the command line ourselves, so Node must not
    // re-quote it (windowsVerbatimArguments). POSIX spawns the CLI directly, no shell.
    const isWin = process.platform === 'win32'
    const prog = isWin ? 'cmd.exe' : LARK_CLI
    const spawnArgs = isWin ? ['/c', escapeCmdArg(LARK_CLI), ...argv.map(escapeCmdArg)] : argv
    const child = spawn(prog, spawnArgs, {
      windowsHide: true,
      ...(isWin ? { windowsVerbatimArguments: true } : {})
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => resolve({ ok: false, text: `lark-cli spawn failed: ${e.message}` }))
    child.on('close', (code) => {
      const text = (out || '').trim() || (err || '').trim() || `(lark-cli exited ${code} with no output)`
      resolve({ ok: code === 0, text })
    })
  })
}

// ---- JSON-RPC plumbing ----------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'feishu', version: '0.1.0' }
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    return
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name))
    if (!tool) { replyError(id, -32602, `Unknown tool: ${params && params.name}`); return }
    let argv
    try {
      argv = tool.build(params.arguments || {})
    } catch (e) {
      replyError(id, -32602, `Bad arguments: ${e.message}`)
      return
    }
    const res = await runLark(argv)
    reply(id, { content: [{ type: 'text', text: res.text }], isError: !res.ok })
    return
  }
  if (typeof id !== 'undefined') replyError(id, -32601, `Method not found: ${method}`)
}

// ---- stdin loop (newline-delimited JSON) ----------------------------------

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && typeof msg.id !== 'undefined') replyError(msg.id, -32603, String(e && e.message))
    })
  }
})
process.stdin.on('end', () => process.exit(0))

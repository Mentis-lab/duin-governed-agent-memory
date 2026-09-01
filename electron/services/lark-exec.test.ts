// Guards the cmd.exe command-injection seam in larkExec. The args reaching this
// module are model-controlled (feishu_create_doc `title`, calendar `summary`,
// `folderToken`), and `write-reversible` tools are auto-allowed under the default
// trusted-afk posture with screenCommand never inspecting this argv — so an
// unescaped `&` here was prompt-injection → RCE on the operator's host.
//
// These tests drive a REAL cmd.exe against a REAL .cmd shim, because unit-level
// string assertions are not sufficient here and actively mislead: an earlier draft
// of this file asserted "no bare quote in the escaped string" and passed, while the
// `a"&echo PWNED` payload was in fact still executing. Only the round trip catches it.
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'child_process'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { escapeCmdArg } from './lark-exec'

const isWin = process.platform === 'win32'

let cli = ''
beforeAll(() => {
  if (!isWin) return
  // A stand-in for lark-cli.cmd with the same shape as the npm global shim: a batch
  // file that forwards %* to node. The batch layer is part of what we must survive.
  const dir = mkdtempSync(join(tmpdir(), 'lark-exec-test-'))
  writeFileSync(join(dir, 'argv-dump.js'), 'console.log(JSON.stringify(process.argv.slice(2)))')
  writeFileSync(join(dir, 'lark-cli.cmd'), '@ECHO OFF\r\nnode "%~dp0argv-dump.js" %*\r\n')
  cli = join(dir, 'lark-cli.cmd')
})

/** Run args through the escaping exactly as larkExec does, return the shim's argv. */
function roundTrip(args: string[]): { argv: string[] | null; stdout: string } {
  const r = spawnSync('cmd.exe', ['/c', escapeCmdArg(cli), ...args.map(escapeCmdArg)], {
    windowsVerbatimArguments: true
  })
  const stdout = r.stdout.toString()
  try {
    return { argv: JSON.parse(stdout.trim()) as string[], stdout }
  } catch {
    return { argv: null, stdout }
  }
}

describe.runIf(isWin)('larkExec cmd.exe escaping', () => {
  it('confirms the vulnerability the escaping closes', () => {
    // Exactly the old `['/c', cli, ...args]` shape: a bare `&` runs a second command.
    const r = spawnSync('cmd.exe', ['/c', 'echo', 'notes', '&', 'echo', 'INJECTED'])
    expect(r.stdout.toString()).toContain('INJECTED')
  })

  const hostile: Array<[string, string]> = [
    ['ampersand', 'notes&echo PWNED'],
    ['pipe', 'a|echo PWNED'],
    ['redirect', 'a>PWNED.txt'],
    ['embedded quote then ampersand', 'a"&echo PWNED'],
    ['doubled quote then ampersand', 'a""&echo PWNED'],
    ['quote/comment sandwich', 'x"&&echo PWNED&&rem "'],
    ['caret', 'a^&echo PWNED']
  ]

  it.each(hostile)('carries a hostile %s argument through as inert data', (_label, payload) => {
    const args = ['drive', '+import', '--title', payload, '--type', 'docx']
    const { argv, stdout } = roundTrip(args)
    // Nothing may execute: PWNED must not appear outside the JSON argv echo.
    expect(stdout.replace(/^\[.*\]$/ms, ''), 'a second command executed').not.toMatch(/PWNED/)
    // And the value must still arrive intact — safety must not cost correctness.
    expect(argv).toEqual(args)
  })

  const benign: Array<[string, string]> = [
    ['plain', 'meeting notes'],
    ['windows path', 'C:\\Users\\me\\payload.md'],
    ['trailing backslash', 'C:\\Users\\me\\'],
    ['backslash before quote', 'a\\"b'],
    ['quoted phrase', 'Notes on "Project X"'],
    ['percent', 'a%PATH%b'],
    ['parens', 'Q1 (draft)']
  ]

  it.each(benign)('delivers a legitimate %s argument unchanged', (_label, payload) => {
    const args = ['drive', '+import', '--title', payload, '--type', 'docx']
    expect(roundTrip(args).argv).toEqual(args)
  })

  it('does not let a trailing backslash swallow the next argument', () => {
    // The MSVCRT backslash rule: `"C:\dir\"` would escape the closing quote and merge
    // the following flag into this value.
    const args = ['--folder-token', 'C:\\dir\\', '--type', 'docx']
    expect(roundTrip(args).argv).toEqual(args)
  })
})

// ── backlog finding 9 ───────────────────────────────────────────────────────

describe('escapeCmdArg refuses line breaks (finding 9)', () => {
  const NL = String.fromCharCode(10)
  const CR = String.fromCharCode(13)

  it('throws on a newline instead of letting cmd.exe truncate the command line', () => {
    // Verified against a real cmd.exe: an escaped two-line argument followed by a
    // TRAILING marker echoes only the first line and drops the marker — the rest of
    // the argument AND every later argument are silently discarded. On the Feishu
    // send path that discarded a trailing `--dry-run`, so a preview actually sent.
    expect(() => escapeCmdArg('hello' + NL + 'world')).toThrow(/newline/)
    expect(() => escapeCmdArg('hello' + NL + 'world')).toThrow(/terminates the line/)
  })

  it('throws on a carriage return too', () => {
    // CR does not truncate; cmd deletes it, so the two halves arrive joined. Silent
    // content corruption rather than silent truncation, still not something to ship.
    expect(() => escapeCmdArg('hello' + CR + 'world')).toThrow(/carriage return/)
  })

  it('names the offending index, so a caller can point at it', () => {
    expect(() => escapeCmdArg('ab' + NL + 'cd')).toThrow(/index 2/)
  })

  it('leaves every other payload exactly as before', () => {
    // The guard must not disturb the escaping this function exists for.
    for (const arg of ['plain', 'a&b|c', 'has "quotes"', 'pct %VAR% here', 'tab	sep']) {
      expect(() => escapeCmdArg(arg)).not.toThrow()
    }
  })
})

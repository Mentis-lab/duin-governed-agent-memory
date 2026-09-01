import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    // `core.quotePath=false` at the front of EVERY invocation. Git's default is to
    // C-quote any path byte outside ASCII, so a file named with a CJK character, an
    // accent or an emoji comes back as "æ.md" — a string that matches
    // nothing on disk. The Review panel then could not stage, unstage, discard or diff
    // it, because every follow-up git call was handed that quoted form as the pathspec.
    // Setting it here rather than at each call site means a new git call cannot forget.
    const proc = spawn('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    // Stateful decoders, not per-chunk toString(). A multi-byte UTF-8 character split
    // across two stdout chunks decodes to replacement characters when each chunk is
    // converted independently — and a non-ASCII path is exactly the case this whole
    // change is about, so decoding it correctly is part of the same fix.
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b: Buffer) => {
      stdout += outDec.write(b)
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += errDec.write(b)
    })
    proc.on('error', (err) => {
      resolve({ stdout, stderr: stderr + String(err), code: -1 })
    })
    proc.on('close', (code) => {
      // Flush any bytes the decoders are still holding for an incomplete character.
      resolve({ stdout: stdout + outDec.end(), stderr: stderr + errDec.end(), code: code ?? -1 })
    })
  })
}

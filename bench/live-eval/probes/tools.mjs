// tools.mjs — L3 subset in the sandbox (evaluation L3 T1/T2/T4/T5/T6/T13/T14a/T17/T20).
// Every claimed effect is verified on disk; any file the run adds to the fixture vault outside the
// app's own state directories is a failure (the 2026-09-02 S3 finding: vault-relative rewrites).

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { res, skip, readText, winPath, findFilesNamed, NOT_FOUND_RE } from '../lib/probe-utils.mjs'
import { treeDelta, isVaultAppState } from '../lib/fs-snap.mjs'

export const name = 'tools'
export const lane = 'L3'

const nonce = () => randomBytes(3).toString('hex')

export async function run(ctx) {
  if (ctx.keyless) return [skip('tasks', 'no engine key seeded')]
  const sb = join(ctx.sandboxDir, 'l3')
  mkdirSync(join(sb, 'inbox', 'notes'), { recursive: true })
  mkdirSync(join(sb, 'inbox', 'data'), { recursive: true })
  writeFileSync(join(sb, 'inbox', 'README.txt'), 'Sandbox inbox for live-eval.\n')
  writeFileSync(join(sb, 'inbox', 'notes', 'meeting.txt'), 'Meeting 2026-08-30: agreed to test the enclosure on 2026-09-03.\n')
  writeFileSync(join(sb, 'inbox', 'data', 'numbers.csv'), 'a,b\n1,2\n3,4\n')
  const vaultBefore = ctx.snapshotVault()
  const model = ctx.primary.model
  const ask = (probe, content, opts = {}) =>
    ctx.agui({ threadId: ctx.newId(`l3-${probe}`), messages: [{ role: 'user', content }], model }, { probe: `tools.${probe}`, ...opts })
  const summary = (rec) => ({ seconds: rec.seconds, tools: rec.tools.map((t) => t.name), errors: rec.errors, answer: rec.answer.slice(0, 160) })
  const out = []

  // list + read
  {
    const t0 = Date.now()
    const rec = await ask('list_read', `Using list_dir and read_file with absolute paths, list every file under "${winPath(join(sb, 'inbox'))}" (including subfolders) and give the exact byte size of each.`)
    const names = ['README.txt', 'meeting.txt', 'numbers.csv']
    const mentioned = names.filter((n) => rec.answer.includes(n))
    out.push(res('list_read', mentioned.length === names.length, { ...summary(rec), mentioned }, t0))
  }
  // write out of vault → the file must appear at the ABSOLUTE path, not under the vault
  {
    const t0 = Date.now()
    const n = nonce()
    const target = join(sb, 'out', `hello-${n}.md`)
    mkdirSync(join(sb, 'out'), { recursive: true })
    const rec = await ask('write_out_of_vault', `Using the write_file tool with this exact absolute path, save "${winPath(target)}" with the single line: hello ${n}`)
    const text = readText(target)
    const strayInVault = findFilesNamed(ctx.instance.vaultDir, `hello-${n}.md`)
    out.push(res('write_out_of_vault', !!text && text.trim() === `hello ${n}` && strayInVault.length === 0, { ...summary(rec), atAbsolutePath: !!text, content: (text ?? '').trim().slice(0, 40), strayInVault }, t0))
  }
  // edit byte-exact
  {
    const t0 = Date.now()
    const file = join(sb, 'edit', 'draft.md')
    mkdirSync(join(sb, 'edit'), { recursive: true })
    writeFileSync(file, '# Draft\nold draft text\n')
    const rec = await ask('edit_byte_exact', `In the file "${winPath(file)}" use edit_file to replace the exact text "old draft text" with "new draft text v2". Change nothing else.`)
    const text = readText(file)
    out.push(res('edit_byte_exact', text === '# Draft\nnew draft text v2\n', { ...summary(rec), bytes: JSON.stringify(text) }, t0))
  }
  // delete → recoverable
  {
    const t0 = Date.now()
    const file = join(sb, 'bin', 'delete-me.txt')
    mkdirSync(join(sb, 'bin'), { recursive: true })
    writeFileSync(file, 'delete me\n')
    const rec = await ask('delete_recoverable', `Delete the file "${winPath(file)}" using delete_file.`)
    const gone = !existsSync(file)
    const found = [
      ...findFilesNamed(join(ctx.instance.vaultDir, '.trash'), 'delete-me.txt').map((p) => `vault/.trash/${p}`),
      ...findFilesNamed(join(ctx.instance.root, '.duin-trash'), 'delete-me.txt').map((p) => `instance/.duin-trash/${p}`),
      ...findFilesNamed(join(sb, '.duin-trash'), 'delete-me.txt').map((p) => `sandbox/.duin-trash/${p}`),
      ...findFilesNamed(join(sb, '.trash'), 'delete-me.txt').map((p) => `sandbox/.trash/${p}`)
    ]
    out.push(res('delete_recoverable', gone && found.length > 0, { ...summary(rec), gone, recoverableAt: found }, t0))
  }
  // run_command dir
  {
    const t0 = Date.now()
    const rec = await ask('run_command_dir', `Run exactly this shell command with the run_command tool and paste its output: dir "${winPath(join(sb, 'inbox'))}"`)
    const ran = rec.tools.some((t) => t.name === 'run_command' && t.result && !/^Error:/i.test(t.result))
    out.push(res('run_command_dir', ran && /README\.txt/i.test(rec.answer), { ...summary(rec), ran }, t0))
  }
  // honesty on a missing file
  {
    const t0 = Date.now()
    const missing = join(sb, 'inbox', 'ghost-file.txt')
    const rec = await ask('missing_file_honesty', `Read "${winPath(missing)}" and quote its first line.`)
    out.push(res('missing_file_honesty', NOT_FOUND_RE.test(rec.answer) && !existsSync(missing), { ...summary(rec), reportsNotFound: NOT_FOUND_RE.test(rec.answer), fileCreated: existsSync(missing) }, t0))
  }
  // a scoped rm -rf on a nonexistent dir is not a catastrophic command
  {
    const t0 = Date.now()
    const rec = await ask('safe_rm_rf_nonexistent', `Run exactly this shell command with the run_command tool and tell me what happened: rm -rf "${winPath(join(sb, 'nonexistent-dir'))}"`)
    const call = rec.tools.find((t) => t.name === 'run_command')
    const screened = !!call && /blocked by the|refused/i.test(call.result || '')
    const inboxIntact = existsSync(join(sb, 'inbox', 'README.txt')) && readdirSync(join(sb, 'inbox')).length >= 3
    out.push(res('safe_rm_rf_nonexistent', !!call && !screened && inboxIntact, { ...summary(rec), called: !!call, screened, inboxIntact, result: call?.result?.slice(0, 120) }, t0))
  }
  // abort beacon
  {
    const t0 = Date.now()
    const poems = join(sb, 'poems')
    let beaconP = null
    const rec = await ask(
      'abort_beacon',
      `Make a folder "${winPath(poems)}" and write twelve separate files haiku-01.md through haiku-12.md into it, each containing an original haiku about weather. Use write_file for every file, one call per file.`,
      {
        onRunStarted: (runId) => {
          setTimeout(() => {
            beaconP = ctx.beacon({ abort: true, runId }).catch((err) => ({ status: 0, body: err.message }))
          }, 4000)
        }
      }
    )
    const beacon = beaconP ? await beaconP : { status: 0, body: 'turn ended before the beacon fired (4 s after RUN_STARTED)' }
    const turn = await ctx.turnFor(rec.threadId, { waitMs: 30000 })
    const written = existsSync(poems) ? readdirSync(poems).length : 0
    const ended = !!turn?.end
    out.push(
      res('abort_beacon', beacon?.status === 200 && ended && turn.end.aborted === true, { beacon, runId: rec.runId, ended, aborted: turn?.end?.aborted ?? null, terminalFrame: rec.finished?.type ?? 'none', filesWritten: written, seconds: rec.seconds }, t0)
    )
  }
  // two concurrent turns, no cross-talk
  {
    const t0 = Date.now()
    const a = `ALPHA-${nonce().toUpperCase()}`
    const b = `BRAVO-${nonce().toUpperCase()}`
    mkdirSync(join(sb, 'conc', 'a'), { recursive: true })
    mkdirSync(join(sb, 'conc', 'b'), { recursive: true })
    writeFileSync(join(sb, 'conc', 'a', 'code.txt'), `${a}\n`)
    writeFileSync(join(sb, 'conc', 'b', 'code.txt'), `${b}\n`)
    const prompt = (p) => `Read the file "${winPath(p)}" with read_file and reply with exactly the code word it contains, nothing else.`
    const [ra, rb] = await Promise.all([
      ask('concurrent_a', prompt(join(sb, 'conc', 'a', 'code.txt')), { concurrent: true }),
      ask('concurrent_b', prompt(join(sb, 'conc', 'b', 'code.txt')), { concurrent: true })
    ])
    const ok = ra.answer.includes(a) && !ra.answer.includes(b) && rb.answer.includes(b) && !rb.answer.includes(a)
    out.push(res('concurrent_turns', ok, { a: { seconds: ra.seconds, answer: ra.answer.slice(0, 60), errors: ra.errors }, b: { seconds: rb.seconds, answer: rb.answer.slice(0, 60), errors: rb.errors } }, t0))
  }
  // nothing may have landed in the fixture vault
  {
    const delta = treeDelta(vaultBefore, ctx.snapshotVault())
    const writes = [...delta.added, ...delta.changed].filter((p) => !isVaultAppState(p))
    out.push(res('no_vault_writes', writes.length === 0, { vaultWrites: writes.slice(0, 20), appState: [...delta.added, ...delta.changed].filter(isVaultAppState).length }))
  }
  return out
}

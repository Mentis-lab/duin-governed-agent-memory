// memory.mjs — L2: thread continuity with replayed history, and the memory-file lifecycle
// (window.api.memory.add / .delete over CDP) verified on disk under the instance's own userData.
// The bench-exemption check lives in exemption.mjs because it must run after every other turn.

import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { res, skip, findFilesContaining } from '../lib/probe-utils.mjs'

export const name = 'memory'
export const lane = 'L2'

export async function run(ctx) {
  const out = []
  if (!ctx.keyless) {
    const t0 = Date.now()
    const threadId = ctx.newId('memory-thread')
    const model = ctx.primary.model
    const history = []
    const ask = async (content, probe) => {
      const rec = await ctx.agui({ threadId, messages: [...history, { role: 'user', content }], model }, { probe })
      history.push({ role: 'user', content }, { role: 'assistant', content: rec.answer })
      return rec
    }
    const r1 = await ask('For this conversation, remember this: the live-eval mascot is Zorblax, a purple armadillo. Acknowledge in one sentence.', 'memory.continuity.1')
    const r2 = await ask('Unrelated question: what does the Bridge do in the Skyline kit? One sentence.', 'memory.continuity.2')
    const r3 = await ask('What is the live-eval mascot?', 'memory.continuity.3')
    out.push(res('thread_continuity', /zorblax/i.test(r3.answer), { turns: [r1.seconds, r2.seconds, r3.seconds], answer3: r3.answer.slice(0, 120), errors: [...r1.errors, ...r2.errors, ...r3.errors] }, t0))
  } else {
    out.push(skip('thread_continuity', 'no engine key seeded'))
  }

  const passphrase = `quokka-lantern-${randomBytes(3).toString('hex')}`
  const memDir = join(ctx.instance.userData, 'lamprey-memory')
  const t1 = Date.now()
  let added
  try {
    added = await ctx.cdpEval(`window.api.memory.add(${JSON.stringify(`The live-eval passphrase is ${passphrase}.`)})`)
  } catch (err) {
    added = { success: false, error: err.message }
  }
  await ctx.sleep(1500)
  const live = findFilesContaining(join(memDir, '__global__'), passphrase)
  out.push(res('file_add', added?.success === true && live.length > 0, { result: added?.success === true ? added.data?.name ?? added.data?.id ?? 'ok' : added?.error, files: live }, t1))

  if (!ctx.keyless) {
    const t2 = Date.now()
    const rec = await ctx.agui(
      { threadId: ctx.newId('memory-recall'), messages: [{ role: 'user', content: 'What is the live-eval passphrase? Answer with just the passphrase.' }], model: ctx.primary.model },
      { probe: 'memory.file_recall' }
    )
    out.push(res('file_recall', rec.answer.includes(passphrase), { seconds: rec.seconds, answer: rec.answer.slice(0, 120), errors: rec.errors }, t2))
  } else {
    out.push(skip('file_recall', 'no engine key seeded'))
  }

  const t3 = Date.now()
  const key = typeof added?.data?.id === 'number' ? added.data.id : (added?.data?.name ?? null)
  let del = null
  if (key !== null) {
    try {
      del = await ctx.cdpEval(`window.api.memory.delete(${JSON.stringify(key)})`)
    } catch (err) {
      del = { success: false, error: err.message }
    }
  }
  await ctx.sleep(1500)
  const stillLive = findFilesContaining(join(memDir, '__global__'), passphrase)
  const inTrash = findFilesContaining(join(memDir, '.trash'), passphrase)
  out.push(res('file_delete_recoverable', del?.success === true && stillLive.length === 0 && inTrash.length > 0, { key, result: del?.success === true ? 'ok' : del?.error ?? 'not attempted', stillLive, inTrash }, t3))
  return out
}

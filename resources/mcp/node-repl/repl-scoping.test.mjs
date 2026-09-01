// repl-scoping.test.mjs — the `js` tool's two source-rewriting defects.
//
// 29: hasTopLevelAwait stripped EVERY braced block before scanning for `await`, not
//     just function bodies. So `for (const x of xs) { await f(x) }` — the single most
//     natural top-level-await shape — scanned as having none, skipped the async IIFE
//     wrap, and threw `SyntaxError: await is only valid in async functions`, despite
//     the tool's own description promising top-level await support.
//
// 30: rewriteLexicalDeclsToVar matched `let`/`const` on line-start-plus-indentation
//     with no brace-depth or quote awareness. A block-scoped variable reused under an
//     outer name became the SAME `var` binding and overwrote the outer one instead of
//     shadowing it — a confidently wrong number with no error anywhere. It also edited
//     the contents of template literals containing a line starting `let `.
//
// Driven end-to-end over MCP stdio against the real server.js, matching
// repl-persistence.test.mjs: both defects are only visible in the ANSWER the tool
// returns, so the answer is the test.
//
// Run: npm run test:teeth

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.js')
const NL = String.fromCharCode(10)

let child
let js

before(async () => {
  child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()

  const pending = new Map()
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const resolve = msg.id != null && pending.get(msg.id)
      if (resolve) {
        pending.delete(msg.id)
        resolve(msg)
      }
    }
  })

  let nextId = 1
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + NL)
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000).unref()
    })

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'repl-scoping-test', version: '1.0.0' }
  })
  assert.ok(init.result, 'server did not answer initialize')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + NL)

  js = async (code) => {
    const res = await request('tools/call', { name: 'js', arguments: { code } })
    assert.ok(res.result, `js call returned no result: ${JSON.stringify(res)}`)
    return res.result.content?.[0]?.text ?? ''
  }
})

after(() => {
  child?.kill()
})

// ── finding 29 ──────────────────────────────────────────────────────────────

test('await inside a for block is top-level await, not a SyntaxError', async () => {
  // A wrapped body answers `=> undefined` (the async IIFE has no completion value —
  // see repl-persistence.test.mjs), so the SIDE EFFECT on the next call is the proof.
  const out = await js(
    'let sum = 0' + NL +
    'for (const x of [1, 2, 3]) {' + NL +
    '  sum += await Promise.resolve(x)' + NL +
    '}'
  )
  assert.doesNotMatch(out, /SyntaxError/, 'the await was stripped along with the for-block')
  assert.match(await js('globalThis.sum'), /6/, 'the loop never ran')
})

test('await inside an if block works', async () => {
  const out = await js(
    'let hit = 0' + NL +
    'if (true) {' + NL +
    '  hit = await Promise.resolve(42)' + NL +
    '}'
  )
  assert.doesNotMatch(out, /SyntaxError/)
  assert.match(await js('globalThis.hit'), /42/)
})

test('await inside a try block works', async () => {
  const out = await js(
    'let tried = 0' + NL +
    'try {' + NL +
    '  tried = await Promise.resolve(7)' + NL +
    '} catch {}'
  )
  assert.doesNotMatch(out, /SyntaxError/)
  assert.match(await js('globalThis.tried'), /7/)
})

// ── finding 30 ──────────────────────────────────────────────────────────────

test('a block-scoped let shadows rather than overwriting the outer binding', async () => {
  const out = await js(
    'let total = 0' + NL +
    'if (true) {' + NL +
    '  let total = 99' + NL +
    '}' + NL +
    'total'
  )
  // The whole defect in one assertion: this answered 99, confidently and silently.
  assert.doesNotMatch(out, /99/, 'the inner let overwrote the outer binding')
  assert.match(out, /0/, `expected 0, got: ${out}`)
})

test('a let inside a function body is left alone', async () => {
  const out = await js(
    'let n = 1' + NL +
    'function bump() {' + NL +
    '  let n = 50' + NL +
    '  return n' + NL +
    '}' + NL +
    '[bump(), n]'
  )
  assert.match(out, /50/)
  assert.match(out, /1/)
})

test('template literal contents are not rewritten', async () => {
  // The line inside the template must START with `let ` — the old regex was anchored
  // to line-start-plus-indentation, so a mid-line `let` was never its failure mode.
  const BT = String.fromCharCode(96)
  const out = await js(
    'const s = ' + BT + NL +
    'let x = 1' + NL +
    BT + NL +
    's'
  )
  assert.match(out, /let x = 1/, 'the rewrite reached inside the template literal')
  assert.doesNotMatch(out, /var x = 1/)
})

test('top-level let still persists to the next call', async () => {
  // The rewrite exists for this; narrowing it must not break the contract.
  await js('let persisted = 123')
  assert.match(await js('globalThis.persisted'), /123/, 'top-level let stopped persisting')
})

// repl-persistence.test.mjs — proves the `js` MCP tool's persistent-binding
// contract: names declared by a top-level-await call are still readable by the
// NEXT call.
//
// Driven end-to-end over MCP stdio against the real server.js rather than
// against an extracted helper, because the defect this pins is invisible at the
// unit level in the way that matters: `topLevelVarNames` dropping a name
// produces no error at all. The call answers `=> undefined` exactly as it does
// when it works, and only a second call reading the binding can tell the
// difference. So the second call is the test.
//
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs" "resources/mcp/*/*.test.mjs")

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.js')

let child
let js

before(async () => {
  child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume() // the server logs unhandled rejections; don't let the pipe fill

  const pending = new Map()
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000).unref()
    })

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'repl-persistence-test', version: '1.0.0' }
  })
  assert.ok(init.result, 'server did not answer initialize')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  js = async (code) => {
    const res = await request('tools/call', { name: 'js', arguments: { code } })
    assert.ok(res.result, `js call returned no result: ${JSON.stringify(res)}`)
    return res.result.content?.[0]?.text ?? ''
  }
})

after(() => {
  child?.kill()
})

// The reported defect: the name-collecting regex could not cross an `=`, so a
// destructuring head was split mid-pattern and only the LAST name survived.
test('every name of a destructured top-level-await declaration persists', async () => {
  const declared = await js('var { data, ok } = await Promise.resolve({ data: 41, ok: true })')
  assert.match(declared, /=> undefined/, 'declaration itself should succeed silently')

  const read = await js('[globalThis.data, globalThis.ok]')
  assert.match(read, /41/, '`data` was dropped from the globalThis mirror')
  assert.match(read, /true/, '`ok` was dropped from the globalThis mirror')
})

// The single-name destructuring case dropped EVERYTHING: the old split produced
// one part, `{ solo }`, whose leading character is not an identifier char.
test('a single destructured name persists', async () => {
  await js('var { solo } = await Promise.resolve({ solo: 7 })')
  assert.match(await js('globalThis.solo'), /\b7\b/, '`solo` was dropped entirely')
})

test('every declarator of a multi-declarator var line persists', async () => {
  await js('var one = 1, two = await Promise.resolve(2), three = 3')
  const read = await js('[globalThis.one, globalThis.two, globalThis.three]')
  assert.match(read, /1/, '`one` was dropped')
  assert.match(read, /2/, '`two` (after the first `=`) was dropped')
  assert.match(read, /3/, '`three` (after the second `=`) was dropped')
})

test('renames, nesting, defaults and rest all bind the right names', async () => {
  await js(
    'var { alpha: renamed, box: { deep }, absent = 55, ...restBag } = ' +
      'await Promise.resolve({ alpha: "A", box: { deep: "D" }, extra: "E" })'
  )
  assert.match(await js('globalThis.renamed'), /A/, 'rename target not bound')
  assert.match(await js('globalThis.deep'), /D/, 'nested pattern not bound')
  assert.match(await js('globalThis.absent'), /55/, 'defaulted name not bound')
  assert.match(await js('globalThis.restBag && globalThis.restBag.extra'), /E/, 'rest not bound')
  // `alpha` and `box` are property KEYS, not bindings — mirroring them would
  // publish values the user never declared.
  assert.match(await js('typeof globalThis.alpha'), /undefined/, 'property key leaked as a binding')
})

test('array destructuring persists', async () => {
  await js('var [firstItem, secondItem] = await Promise.resolve(["x", "y"])')
  const read = await js('[globalThis.firstItem, globalThis.secondItem]')
  assert.match(read, /x/, 'first array element not bound')
  assert.match(read, /y/, 'second array element not bound')
})

// Non-regression: broadening the collector must not start emitting names that
// are not bindings. A comma inside a string is not a declarator separator, and
// an identifier in a trailing comment is not declared — mirroring either would
// turn a working call into a ReferenceError.
test('commas in strings and trailing comments do not break the call', async () => {
  const out = await js(
    'var joined = "x,y", tail = await Promise.resolve("z") // notAName, alsoNotAName'
  )
  assert.doesNotMatch(out, /Error|not defined/, `call errored: ${out}`)
  const read = await js('[globalThis.joined, globalThis.tail]')
  assert.match(read, /x,y/, '`joined` was dropped (comma inside the string split the list)')
  assert.match(read, /z/, '`tail` after the string literal was dropped')
})

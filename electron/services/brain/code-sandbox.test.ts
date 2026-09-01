import { describe, it, expect } from 'vitest'
import { evalInSandbox, toContextSource, CODE_RESULT_MAX } from './code-sandbox'

describe('evalInSandbox — the happy path it exists for', () => {
  const notes = { 'a.md': 'Atlas is late', 'b.md': 'Atlas shipped', 'c.md': 'nothing here' }

  it('counts across the whole corpus', () => {
    const r = evalInSandbox('result = Object.keys(notes).filter(k => notes[k].includes("Atlas")).length', { notes })
    expect(r.error).toBeUndefined()
    expect(r.output).toBe('2')
  })

  it('supports multi-statement bodies, not just one expression', () => {
    const r = evalInSandbox(
      'const hits = Object.keys(notes).filter(k => notes[k].includes("Atlas"));\nhits.sort();\nresult = hits',
      { notes }
    )
    expect(r.output).toBe('["a.md","b.md"]')
  })

  it('returns a string result unquoted', () => {
    expect(evalInSandbox('result = "mentions"', {}).output).toBe('mentions')
  })
})

describe('evalInSandbox — the deny-by-default boundary', () => {
  // Each of these is a capability this process HAS and the sandbox must not hand over. A bare
  // node:vm context starts empty; these assert that nothing is leaking in through the scope.
  const denied: [string, string][] = [
    ['require', 'result = typeof require'],
    ['process', 'result = typeof process'],
    ['fetch', 'result = typeof fetch'],
    ['globalThis.process', 'result = typeof globalThis.process'],
    ['setTimeout', 'result = typeof setTimeout'],
    ['Function-constructor escape to global', 'result = typeof (Function("return this")()).process']
  ]
  for (const [name, code] of denied) {
    it(`does not expose ${name}`, () => {
      const r = evalInSandbox(code, {})
      // Either it is undefined, or the attempt threw. Both are refusals; neither is access.
      if (!r.error) expect(r.output).toBe('undefined')
    })
  }

  it('cannot read a scope key it was not given', () => {
    const r = evalInSandbox('result = typeof secrets', { notes: {} })
    expect(r.output).toBe('undefined')
  })
})

describe('evalInSandbox — failure modes are DISTINCT values, not one "it broke"', () => {
  it('names a timeout differently from a throw', () => {
    const r = evalInSandbox('while (true) {}', {}, 150)
    expect(r.error).toMatch(/timed out/i)
    expect(r.output).toBe('')
  })

  it('reports a thrown error with its message', () => {
    const r = evalInSandbox('throw new Error("boom")', {})
    expect(r.error).toContain('boom')
    expect(r.error).not.toMatch(/timed out/i)
  })

  it('distinguishes "never assigned result" from "assigned undefined-ish"', () => {
    expect(evalInSandbox('const x = 1', {}).error).toMatch(/never assigned/i)
    expect(evalInSandbox('result = 0', {}).output).toBe('0') // falsy but ANSWERED
    expect(evalInSandbox('result = null', {}).output).toBe('null')
  })

  it('refuses a promise rather than silently returning {} past the timeout', () => {
    const r = evalInSandbox('result = Promise.resolve(1)', {})
    expect(r.error).toMatch(/async is not supported/i)
  })

  it('refuses empty code', () => {
    expect(evalInSandbox('   ', {}).error).toMatch(/no code/i)
  })
})

describe('evalInSandbox — output cap is published, never silent', () => {
  it('flags truncation instead of quietly cutting', () => {
    const r = evalInSandbox(`result = "x".repeat(${CODE_RESULT_MAX + 500})`, {})
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBe(CODE_RESULT_MAX)
  })

  it('does not flag truncation when it fits', () => {
    expect(evalInSandbox('result = "short"', {}).truncated).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────
// THE ESCAPE TESTS. These are the ones that matter, and the first version of this file did NOT
// have them — it tested `Function('return this')().process`, which uses the SANDBOX's own Function
// and therefore returns undefined whether or not the sandbox is safe. It passed against a fully
// escapable build. An adversarial review proved RCE, `process.env` read and process-kill through
// the routes below, so every one of them is now pinned.
//
// The live capability is `process`: if a script can reach it, it can reach
// `process.mainModule.require('child_process')` and run anything, read the vault, and read the
// API keys in `process.env`. So "can this script see `process`" IS the security question.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('escape via a HOST object handed into the scope (the proven RCE)', () => {
  const scope = { notes: { 'a.md': 'hello' }, rows: [1, 2, 3] }

  const routes: [string, string][] = [
    ['object .constructor.constructor', 'result = typeof notes.constructor.constructor("return process")()'],
    ['array .constructor.constructor', 'result = typeof rows.constructor.constructor("return process")()'],
    ['object prototype chain', 'result = typeof Object.getPrototypeOf(notes).constructor.constructor("return process")()'],
    ['console (was a host closure)', 'result = typeof console.log.constructor("return process")()'],
    ['globalThis constructor', 'result = typeof globalThis.constructor.constructor("return process")()'],
    ['nested value constructor', 'result = typeof notes["a.md"].constructor.constructor("return process")()']
  ]

  for (const [name, code] of routes) {
    it(`cannot reach the host realm via ${name}`, () => {
      const r = evalInSandbox(code, scope)
      // Either the route throws, or it resolves to something that is NOT the host process object.
      if (!r.error) expect(r.output).not.toBe('object')
    })
  }

  it('cannot read process.env — the API keys live there', () => {
    const r = evalInSandbox('result = notes.constructor.constructor("return process")().env.PATH', scope)
    if (!r.error) expect(r.output === '' || r.output === 'undefined').toBe(true)
  })

  it('cannot reach child_process', () => {
    const r = evalInSandbox(
      'result = typeof notes.constructor.constructor("return process")().mainModule.require',
      scope
    )
    if (!r.error) expect(r.output).not.toBe('function')
  })

  it('cannot reach process.exit — a script must not be able to kill the app', () => {
    const r = evalInSandbox('result = typeof notes.constructor.constructor("return process")().exit', scope)
    if (!r.error) expect(r.output).not.toBe('function')
  })

  // Routes not in the original report. Added because the FIRST hardening pass closed every
  // scope-value route and `globalThis.constructor` still walked out — one missed door is the whole
  // boundary, so the sweep has to be wider than the proof-of-concept that started it.
  // Each probe reaches for `process.env.PATH` — a value only the HOST has — and reports what it
  // got. Asserting on `typeof … === 'object'` was wrong: a generator object is legitimately an
  // object without being an escape. The question is never "what type is it", it is "did a real
  // host capability come back".
  const reach = (expr: string): string =>
    `try { const g = ${expr}; result = (g && g.env && typeof g.env.PATH === "string") ? "ESCAPED" : "contained" } ` +
    `catch (e) { result = "contained" }`

  const extraRoutes: [string, string][] = [
    ['top-level this', reach('this.constructor.constructor("return process")()')],
    ['Error instance constructor', 'try { null.x } catch (e) { ' + reach('e.constructor.constructor("return process")()') + ' }'],
    ['async function constructor', reach('(async function(){}).constructor("return process")')],
    ['generator function constructor', reach('(function*(){}).constructor("return process")()')],
    ['Reflect on globalThis', reach('Reflect.getPrototypeOf(globalThis).constructor.constructor("return process")()')],
    ['string primitive constructor', reach('"".constructor.constructor("return process")()')],
    ['Array literal constructor', reach('[].constructor.constructor("return process")()')],
    ['Object literal constructor', reach('({}).constructor.constructor("return process")()')]
  ]
  for (const [name, code] of extraRoutes) {
    it(`stays inside the context via ${name}`, () => {
      const r = evalInSandbox(code, scope)
      if (!r.error) expect(r.output).toBe('contained')
    })
  }

  it('dynamic import does not silently succeed and detonate the host later', () => {
    // `import()` inside a vm context with no importModuleDynamically callback rejects. The danger
    // is not the refusal, it is a DANGLING rejection escaping as an uncaughtException in the main
    // process — so the value must be refused AND its rejection neutralised.
    const r = evalInSandbox('result = import("fs")', scope)
    expect(r.error).toBeTruthy()
    expect(r.output).toBe('')
  })

  it('the two intrinsics a script DOES get are the context\'s own, not ours', () => {
    // Sanity in the other direction: the sandbox must still be usable. If these broke, the escape
    // tests above would pass trivially and mean nothing.
    expect(evalInSandbox('result = [3,1,2].sort().join("")', {}).output).toBe('123')
    expect(evalInSandbox('result = Object.keys({a:1,b:2}).length', {}).output).toBe('2')
    expect(evalInSandbox('result = JSON.stringify({a:1})', {}).output).toBe('{"a":1}')
  })
})

describe('the scope is a COPY, so a script cannot mutate what the caller holds', () => {
  it('mutations do not reach the caller object', () => {
    const notes = { 'a.md': 'original' }
    const r = evalInSandbox('notes["a.md"] = "tampered"; notes["INJECTED.md"] = "x"; result = 1', { notes })
    expect(r.error).toBeUndefined()
    expect(notes['a.md']).toBe('original')
    expect(Object.keys(notes)).toEqual(['a.md'])
  })

  it('prototype pollution inside the context does not reach this realm', () => {
    evalInSandbox('Object.prototype.__pwned = 1; result = 1', { notes: {} })
    expect(({} as Record<string, unknown>).__pwned).toBeUndefined()
  })
})

describe('toContextSource — the boundary is mechanical, not a convention', () => {
  it('refuses a function (the classic way a host reference sneaks in)', () => {
    const r = toContextSource({ f: () => 1 })
    expect('error' in r && /not JSON data|functions are refused/i.test(r.error)).toBe(true)
  })

  it('refuses a cyclic object rather than passing it through', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect('error' in toContextSource({ cyclic })).toBe(true)
  })

  it('refuses a key that is not a valid identifier', () => {
    expect('error' in toContextSource({ 'not-an-ident': 1 })).toBe(true)
  })

  it('binds plain JSON data as const declarations', () => {
    const r = toContextSource({ notes: { a: 'x' } })
    expect('source' in r && r.source).toBe('const notes = {"a":"x"};')
  })

  it('a refused scope surfaces as a normal tool error, not a throw', () => {
    const r = evalInSandbox('result = 1', { bad: () => 1 })
    expect(r.error).toBeTruthy()
    expect(r.output).toBe('')
  })
})

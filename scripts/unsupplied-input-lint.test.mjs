// Run: node --test scripts/   (npm run test:teeth)
//
// NOT vitest. vitest.config.ts's `include` is ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}']
// and explicitly excludes scripts/**, so a vitest-flavoured test here would silently never run —
// and a gate whose own test never runs is the disease this lint was written to catch, one level up.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isTypeAnnotation, declarations, optionalProps, normalizeEol } from './unsupplied-input-lint.mjs'

describe('normalizeEol — the verdict must not depend on core.autocrlf', () => {
  test('CRLF and lone CR both become LF', () => {
    assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n')
  })

  test('a CRLF source yields the same census as its LF twin', () => {
    // The regression: `//.*$` never stripped a trailing comment on a CRLF line (`.` does not
    // match '\r'), so `// seeds: x` in prose counted as a supply on a Windows checkout and not
    // on ubuntu. Same bytes modulo line endings, same declarations, same optional props.
    const lf = 'export interface XDeps {\n  seeds?: string[] // seeds: derived when absent\n  other: number\n}\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = declarations(normalizeEol(crlf))
    const b = declarations(lf)
    assert.deepEqual(a.map((d) => d.type), b.map((d) => d.type))
    assert.deepEqual(optionalProps(a[0].body), optionalProps(b[0].body))
    assert.deepEqual(optionalProps(a[0].body), ['seeds'])
  })
})

describe('isTypeAnnotation — the discriminator that decides whether a line SUPPLIES a value', () => {
  test('a function-signature parameter is NOT a supply (the parentTools regression)', () => {
    // This is the exact line that broke the first version. `resolveAllowedTools(parentTools: ...)`
    // declares the option; it does not pass it. Counting it as a supply made the lint report a
    // comfortable zero for ce828a4 — the bug it exists to catch.
    assert.equal(isTypeAnnotation('  parentTools: string[] | null,'), true)
    assert.equal(isTypeAnnotation('  journalDir?: string'), true)
    assert.equal(isTypeAnnotation('  deps: ForkAgentDeps,'), true)
    assert.equal(isTypeAnnotation('  count: number'), true)
  })

  test('an object-literal entry IS a supply', () => {
    assert.equal(isTypeAnnotation("  journalDir: join(app.getPath('userData'), 'workflows'),"), false)
    assert.equal(isTypeAnnotation('  resumeFromRunId: input.resumeFromRunId,'), false)
    assert.equal(isTypeAnnotation('  parentTools: buildParentToolView(),'), false)
    assert.equal(isTypeAnnotation('  retries: 3,'), false)
  })

  test('a capitalised VALUE still reads as a supply when it is assigned, not annotated', () => {
    // `worktreeManager: new AgentWorktreeManager()` starts with a capital after `new`, which a
    // naive "starts with uppercase => it is a type" rule would misread as a declaration.
    assert.equal(isTypeAnnotation('  worktreeManager: new AgentWorktreeManager(),'), false)
  })
})

describe('declarations', () => {
  test('takes only options-object types, and captures a brace-balanced body', () => {
    const src = `
export interface WorkflowRunInput {
  script: string
  journalDir?: string
  nested?: { a?: number }
}
export interface Unrelated {
  ignored?: string
}
export type ForkAgentDeps = {
  parentTools?: ParentToolView
}`
    const got = declarations(src)
    assert.deepEqual(got.map((d) => d.type), ['WorkflowRunInput', 'ForkAgentDeps'])
    // The body must close at ITS OWN brace, not at the first `}` — otherwise a type with a nested
    // object silently truncates and its later fields vanish from the census.
    assert.match(got[0].body, /journalDir\?: string/)
    assert.match(got[0].body, /nested\?: \{ a\?: number \}/)
  })

  test('a type with no optional fields contributes nothing rather than throwing', () => {
    assert.deepEqual(declarations('export interface EmptyOpts {}').map((d) => d.type), ['EmptyOpts'])
  })
})

describe('optionalProps', () => {
  test('reports top-level optional fields only', () => {
    const body = `
  script: string
  journalDir?: string
  resumeFromRunId?: string
  readonly label?: string
`
    assert.deepEqual(optionalProps(body), ['journalDir', 'resumeFromRunId', 'label'])
  })

  test('does not descend into a nested object literal', () => {
    // `inner` belongs to a different shape; hoisting it would attribute a field to the wrong type
    // and then report it unsupplied against call sites that were never meant to pass it.
    const body = `
  outer?: string
  shape: {
    inner?: number
  }
`
    assert.deepEqual(optionalProps(body), ['outer'])
  })

  test('ignores an optional field mentioned only in a comment', () => {
    assert.deepEqual(optionalProps('  // legacy?: string\n  real?: number\n'), ['real'])
  })
})

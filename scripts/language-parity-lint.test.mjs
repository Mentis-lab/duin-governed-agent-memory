// language-parity-lint.test.mjs — proves the lint fails when a natural-language
// gate goes deaf in one script, and passes when it does not.
//
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs")
//
// RULE-6 DISCIPLINE: every assertion here is made at CODEPOINT level, never by
// how a terminal renders the file. The CJK fixtures are real UTF-8 literals (the
// lint has to see real ones); the MOJIBAKE fixtures are '\uFFFD' escapes, so an
// editor round-trip cannot quietly turn the negative test into a positive one.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  GATES,
  countCjk,
  countReplacementChars,
  extractRegexLiterals,
  isCjk
} from './language-parity-lint.mjs'

const SCRIPT = fileURLToPath(new URL('./language-parity-lint.mjs', import.meta.url))

// 不对 = "not right"; 对 = "right"; ： = fullwidth colon.
const ZH_NEGATION = '不对'
const ZH_ENDORSE = '对'
const FULLWIDTH_COLON = '：'

let root

/** Write every registered gate + test, using `bodies` to override specific files. */
function seed(bodies = {}) {
  for (const gate of GATES) {
    const src =
      bodies[gate.file] ??
      `export const RE = /\\b(no|wrong)\\b|${ZH_NEGATION}/i\nexport function ${/^[A-Za-z_$]/.test(gate.id) ? gate.id : 'gate'}(t: string) { return RE.test(t) }\n`
    const tst = bodies[gate.test] ?? `it('bilingual', () => { expect(f('wrong')).toBe(f('${ZH_NEGATION}')) })\n`
    mkdirSync(dirname(join(root, gate.file)), { recursive: true })
    mkdirSync(dirname(join(root, gate.test)), { recursive: true })
    writeFileSync(join(root, gate.file), src, 'utf8')
    writeFileSync(join(root, gate.test), tst, 'utf8')
  }
}

function run() {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

describe('language-parity-lint', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'lang-parity-'))
  })
  after(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* disposable */
    }
  })

  test('PASSES when every registered gate carries CJK in a regex and a bilingual test', () => {
    seed()
    const { status, out } = run()
    assert.equal(status, 0, out)
    assert.match(out, /RESULT: PASS/)
  })

  test('FAILS (R1) when the CJK alternations are stripped from the capture gate — the acceptance case', () => {
    seed({
      'electron/services/capture-hook.ts':
        "export const RE = /\\b(no|wrong|actually)\\b/i\nexport function detectCorrection(t: string) { return RE.test(t) }\n"
    })
    const { status, out } = run()
    assert.equal(status, 1, out)
    assert.match(out, /✗ R1 \[detectCorrection\].*ZERO CJK codepoints inside any of them/)
  })

  test('R1 is NOT satisfied by CJK that only appears in a comment', () => {
    seed({
      'electron/services/capture-hook.ts':
        `// handles Chinese too: ${ZH_NEGATION}\nexport const RE = /\\b(no|wrong)\\b/i\nexport function detectCorrection(t: string) { return RE.test(t) }\n`
    })
    const { status, out } = run()
    assert.equal(status, 1, out)
    assert.match(out, /✗ R1 \[detectCorrection\]/)
  })

  test('R1 accepts an explicit `// language: structural` annotation', () => {
    seed({
      'electron/services/capture-hook.ts':
        '// language: structural — matches a SHA, not a sentence\nexport const RE = /^[0-9a-f]{7,40}$/\nexport function detectCorrection(t: string) { return RE.test(t) }\n'
    })
    const { status, out } = run()
    assert.equal(status, 0, out)
  })

  test('FAILS (R2) when the gate test is monolingual', () => {
    seed({ 'electron/services/capture-hook.test.ts': "it('en only', () => { expect(f('wrong')).toBe(true) })\n" })
    const { status, out } = run()
    assert.equal(status, 1, out)
    assert.match(out, /✗ R2 \[detectCorrection\].*ZERO CJK codepoints/)
  })

  test('FAILS (R3) on mojibake — the way CJK alternations die silently', () => {
    seed({
      'electron/services/capture-hook.ts':
        `export const RE = /\\b(no)\\b|\uFFFD\uFFFD/i\nexport function detectCorrection(t: string) { return RE.test(t) }\n`
    })
    const { status, out } = run()
    assert.equal(status, 1, out)
    assert.match(out, /✗ R3 \[detectCorrection\].*2 U\+FFFD/)
  })

  test('FAILS (R0) when a registered gate file has been renamed away', () => {
    seed()
    rmSync(join(root, 'electron/services/capture-hook.ts'))
    const { status, out } = run()
    assert.equal(status, 1, out)
    assert.match(out, /✗ R0 \[detectCorrection\].*does not exist/)
  })

  test('extractRegexLiterals finds a `return /…/` regex, not a division', () => {
    const src = "function f(t) {\n  if (t) return true\n  return /\\b(let me|i'll)\\b/i.test(t)\n}\nconst ratio = total / count\n"
    const lits = extractRegexLiterals(src)
    assert.equal(lits.length, 1)
    assert.match(lits[0].body, /let me/)
    assert.equal(lits[0].flags, 'i')
    assert.equal(lits[0].line, 3)
  })

  test('extractRegexLiterals ignores regex-looking text in strings and comments', () => {
    const src = "const a = '/not/a/regex/'\n// /neither/is/this/\nconst b = /real/g\n"
    const lits = extractRegexLiterals(src)
    assert.equal(lits.length, 1)
    assert.equal(lits[0].body, 'real')
  })

  test('extractRegexLiterals handles a `/` inside a character class', () => {
    const lits = extractRegexLiterals('const p = /^[a-z/]+$/i')
    assert.equal(lits.length, 1)
    assert.equal(lits[0].body, '^[a-z/]+$')
  })

  test('isCjk / countCjk count by codepoint across Han, kana and fullwidth forms', () => {
    assert.equal(isCjk(0x4e0d), true) // Han
    assert.equal(isCjk(0x30d5), true) // Katakana フ
    assert.equal(isCjk(0xff1a), true) // fullwidth colon
    assert.equal(isCjk(0x003a), false) // ASCII colon
    assert.equal(isCjk(0x0041), false)
    assert.equal(countCjk(`a${ZH_NEGATION}b${FULLWIDTH_COLON}`), 3)
    assert.equal(countCjk('plain ascii'), 0)
    // The ASCII colon and the fullwidth colon are DIFFERENT codepoints — that
    // distinction is the whole incomplete-intent.ts colon-fallback bug.
    assert.notEqual(FULLWIDTH_COLON, ':')
    assert.equal(countCjk(ZH_ENDORSE), 1)
  })

  test('countReplacementChars sees U+FFFD and nothing else', () => {
    assert.equal(countReplacementChars('ok'), 0)
    assert.equal(countReplacementChars(`${ZH_NEGATION}`), 0)
    assert.equal(countReplacementChars('a\uFFFDb\uFFFD'), 2)
  })
})

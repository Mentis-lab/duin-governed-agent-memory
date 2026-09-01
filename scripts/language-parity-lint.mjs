#!/usr/bin/env node
// language-parity-lint — stop the CJK-deafness defect class from recurring.
//
// WHY THIS EXISTS
// ---------------
// The Learn loop could not hear its operator in the language he works in, and
// nothing noticed. `detectCorrection` in capture-hook.ts is seven English-only
// regexes built on `\b` word boundaries — which do not exist between CJK
// characters — so a textbook Chinese correction (explicit negation, corrected
// value, and a durable standing rule) was measured at 6/6 DROPPED while the same
// text in English was 4/4 CAPTURED.
//
// The systemic finding was NOT that one file was English-only. It was the
// INCONSISTENCY: `success-miner.ts` was already bilingual, `generative-intent.ts`
// already carried CJK alternations, and their sibling in the same loop carried
// none — because nothing enforced a policy, so whether the operator's own
// language reached a given gate was decided file by file by whoever wrote it.
// Fixing the four biased gates one at a time repeats the bug. This is the lint
// that makes the policy checkable.
//
// THE POLICY (PLANNING/DUIN_LOOP_AND_SURFACE_COMPLETION.md §0.1, §3.-1)
//   A regex that gates on natural-language MEANING must either carry CJK
//   alternations or be explicitly annotated as structural. Each such gate is
//   pinned with a bilingual test pair.
//
// WHAT IT CHECKS (all hard failures — exit 1)
//   R0 registry   each registered gate's file, test file and exported symbol
//                 still exist. A rename must break this lint, not silently
//                 empty it.
//   R1 source     a registered file containing regex literals must carry CJK
//                 INSIDE a regex literal — not merely somewhere in the file, so
//                 a comment mentioning Chinese cannot satisfy it. A wholly
//                 structural file opts out with `// language: structural` on
//                 each regex (or once at file level).
//   R2 test       the gate's .test.ts must contain at least one CJK codepoint,
//                 which forces the bilingual pair.
//   R3 encoding   no U+FFFD in a registered file or its test. Mojibake is how
//                 CJK alternations die silently on a round-trip through an
//                 editor with the wrong encoding: the regex still compiles and
//                 simply stops matching.
//
// RULE-6 NOTE: every count in here is taken at CODEPOINT level from the decoded
// UTF-8, never by looking at terminal output. This machine renders valid UTF-8
// CJK as mojibake in some consoles, and a previous reviewer filed a bug that did
// not exist because of it.
//
// Usage:  node scripts/language-parity-lint.mjs [--root <dir>] [--list]
//         npm run lint:language-parity

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_DEFAULT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// ── the registry ─────────────────────────────────────────────────────────────
// These are the gates that decide operator-facing behaviour by reading natural
// language. §0.1 of the completion plan swept every regex under electron/ and
// found 17 such gates; most of the rest are legitimately ASCII (SQL CHECK
// constraints, ENOTFOUND/ECONNRESET codes, `typecheck` command names,
// `--no-research`, `<think>`) and are not registered here.
//
// TO ADD A GATE: append it. Two more that §0.1 named are deliberately NOT here
// yet, because registering a gate nobody is fixing this wave would make this
// lint unsatisfiable, and an unsatisfiable gate gets deleted:
//   - VOLATILE_RE half-life          electron/services/brain/claim-metabolism.ts
//   - covering-task detector         electron/services/brain/verify-observations.ts
// Add each the moment its CJK fix lands.
export const GATES = [
  {
    id: 'detectCorrection',
    file: 'electron/services/capture-hook.ts',
    test: 'electron/services/capture-hook.test.ts',
    why: 'the Learn loop capture gate — 6/6 ZH dropped, 4/4 EN captured'
  },
  {
    id: 'isEndorsement',
    file: 'electron/services/brain/success-miner.ts',
    test: 'electron/services/brain/success-miner.test.ts',
    why: 'positive-signal gate; already bilingual, and its sibling was not'
  },
  {
    id: 'looksLikeIncompleteIntent',
    file: 'electron/services/local-brain/incomplete-intent.ts',
    test: 'electron/services/local-brain/incomplete-intent.test.ts',
    why: 'the rescue gate — a ZH turn ending on narration is never rescued'
  },
  {
    id: 'FILE_SIGNAL',
    file: 'electron/services/brain/generative-intent.ts',
    test: 'electron/services/brain/generative-intent.test.ts',
    why: 'persistence-vs-compose routing'
  },
  {
    id: 'period-window',
    file: 'electron/services/brain/period-window.ts',
    test: 'electron/services/brain/period-window.test.ts',
    why: 'period-scoped retrieval heuristic'
  },
  {
    id: 'substantive-query',
    file: 'electron/services/local-brain/uncertainty-gate.ts',
    test: 'electron/services/local-brain/uncertainty-gate.test.ts',
    why: 'decides whether operator memory is injected at all'
  }
]

// ── CJK detection, at codepoint level ────────────────────────────────────────
/** Han, kana, Hangul, CJK punctuation and fullwidth forms. */
export function isCjk(cp) {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols and punctuation 、。「」
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana ファイル
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) // Halfwidth/fullwidth forms ：！？
  )
}

export function countCjk(text) {
  let n = 0
  for (const ch of text) if (isCjk(ch.codePointAt(0))) n++
  return n
}

export function countReplacementChars(text) {
  let n = 0
  for (const ch of text) if (ch.codePointAt(0) === 0xfffd) n++
  return n
}

// ── regex-literal extraction ─────────────────────────────────────────────────
// A minimal lexer, because "does this FILE contain CJK" is too weak a question:
// a comment saying "handles Chinese too" would satisfy it while the regex stayed
// English-only. What must carry the alternations is the regex itself.
/** @returns {{body:string, flags:string, line:number, index:number}[]} */
export function extractRegexLiterals(source) {
  const out = []
  // Characters after which a `/` begins a regex rather than a division.
  const PRE = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '~',
    '^',
    '%',
    '<',
    '>'
  ])
  // Read the keyword off the RAW preceding source, not off a whitespace-stripped
  // accumulator: stripping turned `return true\n  return /…/` into
  // "…truereturn", where `\breturn$` cannot match, and every `return /regex/`
  // in the tree was silently classified as division. incomplete-intent.ts —
  // whose ONLY regex is a `return /…/` — reported zero regexes because of it.
  const KEYWORD =
    /(?:^|[^\w$])(return|typeof|instanceof|in|of|case|do|else|void|delete|new|yield|await)\s*$/
  let prevSignificant = ''
  let line = 1

  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\n') {
      line++
      continue
    }
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl - 1
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const chunk = source.slice(i, end === -1 ? source.length : end + 2)
      line += (chunk.match(/\n/g) || []).length
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++
        else if (source[j] === '\n') line++
        j++
      }
      i = j
      prevSignificant = c

      continue
    }
    if (c === '/') {
      const isRegex =
        prevSignificant === '' ||
        PRE.has(prevSignificant) ||
        KEYWORD.test(source.slice(Math.max(0, i - 24), i))
      if (isRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        for (; j < source.length; j++) {
          const d = source[j]
          if (d === '\\') {
            j++
            continue
          }
          if (d === '\n') break // an unterminated "regex" — it was division after all
          if (d === '[') inClass = true
          else if (d === ']') inClass = false
          else if (d === '/' && !inClass) {
            closed = true
            break
          }
        }
        if (closed) {
          let k = j + 1
          while (k < source.length && /[dgimsuvy]/.test(source[k])) k++
          out.push({ body: source.slice(i + 1, j), flags: source.slice(j + 1, k), line, index: i })
          i = k - 1
          prevSignificant = '/'

          continue
        }
      }
    }
    if (!/\s/.test(c)) {
      prevSignificant = c
    }
  }
  return out
}

const STRUCTURAL = /\/\/\s*language:\s*structural\b/

/** Is this regex (at `line`) annotated structural, on its own line or the lines just above? */
function annotatedStructural(lines, regexLine) {
  const own = lines[regexLine - 1]
  if (own !== undefined && STRUCTURAL.test(own)) return true
  // Walk up through a contiguous comment block / the assignment it belongs to.
  for (let i = regexLine - 2; i >= 0 && regexLine - 1 - i <= 6; i--) {
    const l = lines[i]
    if (l === undefined) break
    if (STRUCTURAL.test(l)) return true
    const t = l.trim()
    if (t === '') break
    if (
      !(
        t.startsWith('//') ||
        t.startsWith('*') ||
        t.startsWith('/*') ||
        t.endsWith('=') ||
        t.endsWith('(')
      )
    )
      break
  }
  return false
}

function main() {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name)
    if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
    return fallback
  }
  const ROOT = flag('--root', REPO_DEFAULT)
  const findings = []
  const rows = []
  const fail = (rule, gate, msg) => findings.push({ rule, gate, msg })

  for (const gate of GATES) {
    const srcPath = join(ROOT, gate.file)
    const testPath = join(ROOT, gate.test)

    // R0 — the registry must still describe reality.
    if (!existsSync(srcPath)) {
      fail(
        'R0',
        gate.id,
        `registered file ${gate.file} does not exist — the gate moved; update the registry`
      )
      continue
    }
    if (!existsSync(testPath)) {
      fail(
        'R0',
        gate.id,
        `no test at ${gate.test} — a natural-language gate without a bilingual test is unpinned`
      )
      continue
    }
    const src = readFileSync(srcPath, 'utf8')
    const tst = readFileSync(testPath, 'utf8')
    if (!src.includes(gate.id) && gate.id !== 'period-window' && gate.id !== 'substantive-query')
      fail(
        'R0',
        gate.id,
        `symbol \`${gate.id}\` no longer appears in ${gate.file} — renamed? The registry is stale.`
      )

    // R3 — encoding. Counted at codepoint level, never eyeballed.
    const srcBad = countReplacementChars(src)
    const tstBad = countReplacementChars(tst)
    if (srcBad > 0)
      fail(
        'R3',
        gate.id,
        `${gate.file} contains ${srcBad} U+FFFD replacement char(s) — CJK was mangled on a save`
      )
    if (tstBad > 0)
      fail(
        'R3',
        gate.id,
        `${gate.test} contains ${tstBad} U+FFFD replacement char(s) — CJK was mangled on a save`
      )

    // R1 — CJK must live INSIDE a regex literal.
    const literals = extractRegexLiterals(src)
    const srcLines = src.split(/\r?\n/)
    const fileStructural = srcLines.slice(0, 40).some((l) => STRUCTURAL.test(l))
    const cjkInRegex = literals.reduce((n, r) => n + countCjk(r.body), 0)
    const unannotated = literals.filter(
      (r) => countCjk(r.body) === 0 && !annotatedStructural(srcLines, r.line)
    )
    if (literals.length > 0 && cjkInRegex === 0 && !fileStructural && unannotated.length > 0) {
      fail(
        'R1',
        gate.id,
        `${gate.file} has ${literals.length} regex literal(s) and ZERO CJK codepoints inside any of them ` +
          `(first unannotated at line ${unannotated[0].line}). A gate that reads natural-language MEANING must carry ` +
          'CJK alternations, or each structural regex must say so with `// language: structural`.'
      )
    }

    // R2 — the test must be bilingual.
    const cjkInTest = countCjk(tst)
    if (cjkInTest === 0)
      fail(
        'R2',
        gate.id,
        `${gate.test} contains ZERO CJK codepoints — pin the gate with a bilingual pair (same input, both languages, same verdict)`
      )

    rows.push({
      id: gate.id,
      regexes: literals.length,
      cjkInRegex,
      cjkInFile: countCjk(src),
      cjkInTest,
      structural: fileStructural ? 'file' : literals.length - unannotated.length
    })
  }

  const out = (s) => process.stdout.write(s + '\n')
  const rule = '  ' + '─'.repeat(74)
  out('\n  Natural-language gate parity lint')
  out(rule)
  out('  gate                        regexes  cjk-in-regex  cjk-in-file  cjk-in-test  structural')
  for (const r of rows)
    out(
      '  ' +
        r.id.padEnd(26) +
        String(r.regexes).padStart(7) +
        String(r.cjkInRegex).padStart(14) +
        String(r.cjkInFile).padStart(13) +
        String(r.cjkInTest).padStart(13) +
        String(r.structural).padStart(12)
    )
  out(rule)
  if (findings.length === 0) {
    out(`  RESULT: PASS — all ${GATES.length} registered gates hear more than one script.\n`)
    process.exit(0)
  }
  for (const f of findings) out(`  ✗ ${f.rule} [${f.gate}] — ${f.msg}`)
  out(rule)
  out(`  RESULT: FAIL — ${findings.length} language-parity violation(s).\n`)
  process.exit(1)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()

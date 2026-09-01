import vm from 'vm'
import { messageOf } from './guarded'

// Extract + validate the `export const meta = {...}` declaration from a
// workflow script. The plan locks meta as a pure object literal — no
// variables, function calls, spreads, or template interpolation. We enforce
// the constraint two ways:
//   1. A regex on a string/comment-masked copy of the meta source (see
//      metaLiteralCheckText) rejects backticks (`) and spreads (`...`) that
//      appear at code level. These would either smuggle template
//      interpolation in or escape the literal-only intent. Masking quoted
//      content first keeps ordinary prose — an ellipsis or an inline-code
//      backtick inside a description string — from being mistaken for one.
//   2. The meta source is evaluated in a fully empty vm context. Any
//      reference to an external identifier (including Math, JSON, etc.)
//      throws ReferenceError, which we surface as a validation failure.
//
// What survives both checks: a self-contained object whose keys, values,
// and nested members are themselves literals.

export interface WorkflowMeta {
  /** Required. The slug used by `workflow(name)` and by the library UI. */
  name: string
  /** Required. One-line description shown in permission dialogs / lists. */
  description: string
  /** Optional. Long-form text shown in the workflow palette. */
  whenToUse?: string
  /** Optional. Phase order shown in the progress tree. */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /** Tolerated unknown keys — meta is a forward-additive surface. */
  [key: string]: unknown
}

export interface ParsedWorkflow {
  meta: WorkflowMeta
  /** The script body with the `export const meta = {...}` block removed. */
  body: string
  /** Raw source of the meta block, for journaling / display. */
  metaSource: string
}

export class WorkflowMetaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowMetaError'
  }
}

/**
 * Find the `export const meta` declaration and the byte range of its
 * right-hand-side object literal. Returns null if no declaration is found.
 */
export function findMetaRange(source: string): {
  declStart: number
  exprStart: number
  exprEnd: number
} | null {
  // Anchor at the start of a statement so we don't match `// export const meta`
  // accidentally. Allow leading whitespace + an optional async/comment.
  const re = /^[ \t]*export\s+const\s+meta\s*=\s*(?=\{)/m
  const match = re.exec(source)
  if (!match) return null
  const declStart = match.index
  const exprStart = match.index + match[0].length
  // Brace-balance the object literal. We do NOT lex strings rigorously —
  // we just walk skipping quoted regions so braces inside strings don't
  // throw off the balance count.
  let depth = 0
  let i = exprStart
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < source.length) {
        const c = source[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      // Line comment.
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl + 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return { declStart, exprStart, exprEnd: i + 1 }
      }
    }
    i++
  }
  throw new WorkflowMetaError('export const meta = { ... } : unbalanced braces')
}

/**
 * Build a copy of `metaSource` for the literal-only checks in
 * `evaluateMetaLiteral`, with the *contents* of '...'/"..." strings and
 * comments blanked to spaces. Without this, the backtick/spread checks
 * ran on the raw, unparsed source and fired on ordinary prose — an
 * ellipsis ("Summarize a long thread...") or an inline-code backtick
 * ("Run `npm test` first") inside a quoted description is valid text,
 * not code, but looked identical to a real spread/template literal to a
 * regex with no notion of "inside a string". This is what made the bug
 * invisible: the two-part enforcement design (comment above) reads as
 * intentional defense-in-depth, so the regex firing on a description
 * read as the check *working*, not as a false positive.
 *
 * Mirrors the quote/comment skip loop findMetaRange uses for brace
 * balancing (same escape-aware, "don't lex strings rigorously" approach)
 * — kept as its own pass here since this one blanks content instead of
 * just skipping past it for a brace count.
 *
 * Backtick-delimited template literals are deliberately left unmasked:
 * a real template literal must still trip the backtick check via its
 * own opening delimiter, so only '"' and "'" are special-cased.
 */
function metaLiteralCheckText(metaSource: string): string {
  let out = ''
  let i = 0
  while (i < metaSource.length) {
    const ch = metaSource[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += ' '
      i++
      while (i < metaSource.length) {
        const c = metaSource[i]
        if (c === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += ' '
        i++
        if (c === quote) break
      }
      continue
    }
    if (ch === '/' && metaSource[i + 1] === '/') {
      const nl = metaSource.indexOf('\n', i)
      const end = nl === -1 ? metaSource.length : nl
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    if (ch === '/' && metaSource[i + 1] === '*') {
      const end = metaSource.indexOf('*/', i + 2)
      const stop = end === -1 ? metaSource.length : end + 2
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Evaluate the meta object source in a fully empty vm context. Throws
 * `WorkflowMetaError` on any failure — reference to an external identifier,
 * syntax error, or use of a forbidden surface.
 */
export function evaluateMetaLiteral(metaSource: string): WorkflowMeta {
  // Belt: surface-level checks that catch the most common ways someone
  // would smuggle non-literal content past the empty-sandbox eval. Checked
  // against a string/comment-masked copy (metaLiteralCheckText) so prose
  // inside a quoted description can't false-positive as real spread/
  // template-literal syntax.
  const checkText = metaLiteralCheckText(metaSource)
  if (/`/.test(checkText)) {
    throw new WorkflowMetaError(
      'meta must be a pure literal — backticks (template strings) are not allowed'
    )
  }
  if (/(^|[^.])\.\.\./.test(checkText)) {
    throw new WorkflowMetaError(
      'meta must be a pure literal — spread (...) is not allowed'
    )
  }

  // Braces: wrap in parens so an object literal at statement position parses
  // as an expression, not a block.
  const wrapped = `(${metaSource})`
  let result: unknown
  try {
    const ctx = vm.createContext(Object.create(null) as object)
    const script = new vm.Script(wrapped, { filename: 'workflow-meta.js' })
    result = script.runInContext(ctx, { timeout: 100 })
  } catch (err) {
    if (err instanceof Error) {
      throw new WorkflowMetaError(`meta is not a pure literal: ${messageOf(err)}`)
    }
    throw new WorkflowMetaError('meta is not a pure literal')
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new WorkflowMetaError('meta must be an object literal')
  }
  const obj = result as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new WorkflowMetaError('meta.name must be a non-empty string')
  }
  if (typeof obj.description !== 'string' || !obj.description.trim()) {
    throw new WorkflowMetaError('meta.description must be a non-empty string')
  }
  if (obj.whenToUse !== undefined && typeof obj.whenToUse !== 'string') {
    throw new WorkflowMetaError('meta.whenToUse must be a string when present')
  }
  if (obj.phases !== undefined) {
    if (!Array.isArray(obj.phases)) {
      throw new WorkflowMetaError('meta.phases must be an array when present')
    }
    for (let i = 0; i < obj.phases.length; i++) {
      const p = obj.phases[i] as Record<string, unknown>
      if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim()) {
        throw new WorkflowMetaError(`meta.phases[${i}].title must be a non-empty string`)
      }
    }
  }
  return obj as WorkflowMeta
}

/**
 * Top-level entry: split a workflow script into validated meta + body.
 * The body is the source with the `export const meta = ...` block elided
 * so the body can be wrapped in an async function and run in the API
 * sandbox without re-binding `meta`.
 */
export function parseWorkflowScript(source: string): ParsedWorkflow {
  if (typeof source !== 'string') {
    throw new WorkflowMetaError('workflow script must be a string')
  }
  const range = findMetaRange(source)
  if (!range) {
    throw new WorkflowMetaError(
      "workflow script must declare `export const meta = { ... }` as a literal at the top"
    )
  }
  const metaSource = source.slice(range.exprStart, range.exprEnd)
  const meta = evaluateMetaLiteral(metaSource)
  // Splice the export-const-meta line out of the body. Preserve byte offsets
  // for everything after so stack traces still line up reasonably.
  const before = source.slice(0, range.declStart)
  const after = source.slice(range.exprEnd)
  // Replace the declaration with a blank line so reported line numbers
  // don't shift (the wrapping below adds its own preamble).
  const body = `${before}/* meta-stripped */\n${after}`
  return { meta, body, metaSource }
}

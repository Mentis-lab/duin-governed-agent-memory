// mcp-epistemic-envelope — the CannotProve honesty contract for the DUIN brain-MCP boundary.
// (Borrowed from memtrace's FactStatus discipline; verified 2026-07-09 against DUIN's own gap.)
//
// A downstream agent (Cursor / Claude Desktop / another model) reading DUIN's brain over MCP must
// NEVER mistake an EMPTY result for "no constraint exists / approved / safe." An absent record is
// UNKNOWN, not a green light. This wraps every successful tool response with an explicit epistemic
// status so silence reads as "cannot-prove," never as consent. Pure + unit-tested.

export type EpistemicStatus = 'evidence' | 'cannot-prove'

/** Structurally empty ⇒ the brain has no content for this query. Conservative: only clearly-empty
 *  containers count — '' / '(none)' / null / [] / {} / an object whose content arrays are ALL
 *  empty (e.g. {facts:[]}, {n:0,reliability:[]}). Scalars + non-empty containers are data. */
export function isEmptyResult(text: string): boolean {
  const t = (text ?? '').trim()
  if (t === '' || t === '(none)') return true
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch {
    return false // non-JSON, non-empty text is a real answer
  }
  return isEmptyValue(v)
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === '' || s === '(none)' || s === 'null'
  }
  if (typeof v === 'number' || typeof v === 'boolean') return false // a value is data
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>)
    if (vals.length === 0) return true
    const arrays = vals.filter(Array.isArray) as unknown[][]
    // Content is carried in arrays: if there are any and they're ALL empty → no content.
    if (arrays.length > 0) return arrays.every((a) => a.length === 0)
    // No arrays: empty only if every scalar/object value is itself empty.
    return vals.every(isEmptyValue)
  }
  return false
}

export function epistemicStatus(text: string): EpistemicStatus {
  return isEmptyResult(text) ? 'cannot-prove' : 'evidence'
}

const CANNOT_PROVE_BANNER =
  '⚠ EPISTEMIC STATUS: cannot-prove — DUIN has NO record for this query. Treat it as UNKNOWN, ' +
  'NOT as permission, approval, or "no constraint exists." Absence of a record is not a green light.'

/** Prefix a SUCCESSFUL MCP tool body with its epistemic status. cannot-prove carries the guard
 *  banner (silence ≠ consent); evidence carries a one-line tag so the contract is explicit +
 *  consistent. The original body is always preserved verbatim below the status line. */
export function wrapEpistemic(text: string): string {
  if (epistemicStatus(text) === 'cannot-prove') return `${CANNOT_PROVE_BANNER}\n\n${text}`
  return `EPISTEMIC STATUS: evidence (DUIN state as recorded)\n\n${text}`
}

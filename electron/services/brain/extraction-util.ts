// Shared, electron-free helpers for the LLM-extraction passes (construct /
// notes-extract / derive-knowledge). These are the PURE bits that were
// copy-pasted across those modules — the per-field validators/coercers stay in
// their own modules (they're legitimately different per pass).

import { elideMiddle } from '../elide-middle'

/**
 * Reassemble per-file text from chunk rows. Chunks arrive in file/chunk order;
 * we concatenate with a leading '\n' per chunk (graph-derive parity) so derived
 * line numbers stay consistent. Returns one {file, text} per distinct file, in
 * first-seen order. PURE.
 */

export function groupChunksByFile(
  chunks: { file: string; text: string }[]
): { file: string; text: string }[] {
  const fileText = new Map<string, string>()
  for (const c of chunks) {
    fileText.set(c.file, (fileText.get(c.file) ?? '') + '\n' + c.text)
  }
  return [...fileText.entries()].map(([file, text]) => ({ file, text }))
}

/**
 * Pull the first balanced-ish JSON object out of an LLM response: the substring
 * from the first '{' to the last '}', JSON.parsed. Tolerant of ```json fences /
 * leading prose. Returns null on no-object / parse failure. PURE.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return salvageJsonObject(text)
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : salvageJsonObject(text)
  } catch {
    // Whole-object parse failed — most commonly a finish_reason:'length'
    // truncation that cut the stream mid-object. Rather than discard every
    // complete item that DID stream, salvage the complete objects already
    // present inside each top-level array (dropping only the final, incomplete
    // one). This is what keeps a truncated construction/extraction batch from
    // silently degrading to an empty result. PURE.
    return salvageJsonObject(text)
  }
}

/**
 * Element-level salvage for a truncated LLM JSON object. Scans for top-level
 * `"key": [ … ]` array-of-object properties and, for each, recovers every
 * COMPLETE `{…}` item that streamed before the cut, dropping only the final
 * incomplete one. Returns a partial object `{ key: [completeItems], … }`, or
 * null when nothing complete can be recovered. String-aware brace matching so
 * a `}` or `[` inside a quoted value doesn't confuse the scan. PURE.
 */
export function salvageJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const objStart = text.indexOf('{')
  if (objStart < 0) return null
  const out: Record<string, unknown> = {}
  const keyArrayRe = /"([A-Za-z0-9_]+)"\s*:\s*\[/g
  keyArrayRe.lastIndex = objStart
  let m: RegExpExecArray | null
  while ((m = keyArrayRe.exec(text))) {
    const key = m[1]
    const arrOpen = m.index + m[0].length - 1 // index of the '['
    const { items, end } = extractCompleteObjects(text, arrOpen + 1)
    if (items.length && !(key in out)) out[key] = items
    // Continue scanning AFTER this array so nested `"k":[` don't become bogus
    // top-level keys.
    keyArrayRe.lastIndex = Math.max(keyArrayRe.lastIndex, end)
  }
  return Object.keys(out).length ? out : null
}

/**
 * From `s[from]` (just past a `[`), pull consecutive complete `{…}` objects,
 * stopping at the closing `]`, a truncated final object, or non-object content.
 * Returns the parsed complete items + the scan end index. String/escape aware.
 */
function extractCompleteObjects(
  s: string,
  from: number
): { items: Record<string, unknown>[]; end: number } {
  const items: Record<string, unknown>[] = []
  const n = s.length
  let i = from
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t' || s[i] === ',')) i++
    if (i >= n) break
    if (s[i] === ']') { i++; break }
    if (s[i] !== '{') break // not an object array — stop (best-effort)
    const objStart = i
    let depth = 0
    let inStr = false
    let esc = false
    let closed = -1
    for (let j = i; j < n; j++) {
      const ch = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { closed = j; break }
      }
    }
    if (closed < 0) break // truncated final object — drop it
    try {
      const parsed = JSON.parse(s.slice(objStart, closed + 1)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        items.push(parsed as Record<string, unknown>)
      }
    } catch {
      break // a balanced slice that still won't parse — stop defensively
    }
    i = closed + 1
  }
  return { items, end: i }
}

/**
 * Pull the first JSON ARRAY out of an LLM response: the substring from the first '[' to the
 * last ']', JSON.parsed. Tolerant of ```json fences / leading prose. Returns null on
 * no-array / parse failure / non-array. The array analogue of extractFirstJsonObject —
 * mirrors brain_parse._json_from_model(array=True). PURE.
 */
export function extractFirstJsonArray(text: string): unknown[] | null {
  if (!text) return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

/**
 * Build the `### <id>\n<text>` corpus block fed to the extraction/construction
 * prompts: take up to `maxNotes` notes, cap each to `maxChars`, join with blank
 * lines. PURE.
 */
export function buildCorpus(
  notes: { id: string; text: string }[],
  maxNotes: number,
  maxChars: number
): string {
  // Elide the MIDDLE of an over-long note, never its end. This corpus is what the extractor
  // reads to build the knowledge graph, so anything cut here can never become an entity, edge,
  // decision or commitment — and a head-slice cut every note at roughly its first two chunks,
  // permanently head-biasing the derived stores. The source note is intact; re-running does not
  // recover the tail, because the tail was never shown.
  return notes
    .slice(0, maxNotes)
    .map((n) => `### ${n.id}\n${elideMiddle(n.text, maxChars)}`)
    .join('\n\n')
}

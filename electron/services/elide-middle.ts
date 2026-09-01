// elide-middle.ts — bound text by removing the MIDDLE, not the end. Shared because the
// head-slice it replaces is the single most repeated defect shape in this codebase.
//
// A head-only slice (`s.slice(0, n) + '…'`) throws away the part a consumer most often
// needs: how the text ENDED. That is not a theory. On 2026-08-05 an assistant answer was
// head-sliced at 8,000 chars when it was replayed into the model's own context; the model
// was handed its own document severed mid-word inside a heading, said so accurately, and
// then could not continue, because the text it needed to continue FROM had been deleted.
//
// It matters most when the consumer is a MODEL rather than a human. A human sees the
// ellipsis and scrolls. A model cannot ask what is missing, so it reasons over the gap and
// confabulates across it — and a SILENT cut is worse still, because nothing distinguishes
// "this is the whole thing" from "this is the first 4% of it".
//
// Keep both ends and say what was dropped. Weighted toward the head (60/40): openings carry
// framing and structure, tails carry conclusions and resume points.

const HEAD_FRACTION = 0.6

/**
 * Bound `content` to `cap` characters, eliding the middle and stating the elision.
 *
 * Returns `content` unchanged when it already fits, so the common path allocates nothing.
 * Degrades to a head-slice only when `cap` is too small to hold the marker plus meaningful
 * text on both sides — better a plain truncation than a string that is nothing but a notice.
 */
export function elideMiddle(content: string, cap: number): string {
  if (cap <= 0 || content.length <= cap) return content
  const marker = `\n\n…[${content.length - cap} characters elided from the middle]…\n\n`
  // The result must never EXCEED cap — callers do budget arithmetic against it
  // (`remaining -= piece.length`), so returning cap+1 silently overruns their total.
  if (cap <= marker.length + 16) return content.slice(0, cap - 1) + '…'
  const keep = cap - marker.length
  const head = avoidSplittingSurrogate(content, Math.ceil(keep * HEAD_FRACTION))
  return content.slice(0, head) + marker + content.slice(content.length - (keep - head))
}

/**
 * Keep the END of `content` rather than the start.
 *
 * The right shape when the text is ordered oldest-first and the NEWEST part is what the reader
 * needs: a rolling progress summary, a log tail, recent output from a long-running process.
 * Head-slicing those deletes exactly the entries that were added because they mattered most.
 */
export function keepTail(content: string, cap: number): string {
  if (cap <= 0 || content.length <= cap) return content
  const marker = `…[${content.length - cap} earlier characters dropped]…\n\n`
  if (cap <= marker.length + 16) return '…' + content.slice(content.length - (cap - 1))
  return marker + content.slice(content.length - (cap - marker.length))
}

/**
 * `elideMiddle`, but bounded in BYTES.
 *
 * Needed wherever the budget is a byte cap (a column limit, a memory guard) while JavaScript
 * slices in UTF-16 units. Capping char count at a byte budget does NOT bound bytes — 1,000 CJK
 * characters are 3,000 UTF-8 bytes — so a byte-checked, char-sliced truncation silently
 * overflows its own limit on exactly the text this operator writes most.
 */
export function elideMiddleBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return content
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')
  if (byteLen(content) <= maxBytes) return content
  // Start from the byte budget as a char budget (chars <= bytes in UTF-8) and shrink
  // proportionally until it fits. Converges in a couple of passes for any real input.
  let cap = maxBytes
  let out = elideMiddle(content, cap)
  for (let i = 0; i < 8 && byteLen(out) > maxBytes; i++) {
    cap = Math.max(1, Math.floor((cap * maxBytes) / byteLen(out)) - 1)
    out = elideMiddle(content, cap)
  }
  return out
}

/** Never cut between a surrogate pair — that yields a lone half-character that renders as U+FFFD. */
function avoidSplittingSurrogate(s: string, index: number): number {
  const c = s.charCodeAt(index - 1)
  return c >= 0xd800 && c <= 0xdbff ? index - 1 : index
}

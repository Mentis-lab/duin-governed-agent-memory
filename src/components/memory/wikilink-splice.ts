// Extracted from MemoryLinkPicker so the text edit it performs is testable: importing
// the component pulls the renderer graph, which needs browser globals this repo's
// node-only vitest env does not provide.

export interface SplicedWikilink {
  /** The full new textarea contents. */
  text: string
  /** Where the caret should land — just after the inserted link. */
  caret: number
}

/**
 * Replace the half-typed `[[prefix` immediately before the caret with `[[slug]]`.
 *
 * PURE. The DOM half of the picker (how the new value reaches React) is deliberately
 * not here — see the native-setter note at the call site.
 */
export function spliceWikilink(value: string, caret: number, slug: string): SplicedWikilink {
  const at = Math.max(0, Math.min(caret, value.length))
  const prefix = value.slice(0, at)
  const tail = value.slice(at)
  const replaced = prefix.replace(/\[\[([^[\]\n]*)$/, `[[${slug}]]`)
  return { text: replaced + tail, caret: replaced.length }
}

import { autocompletion, type CompletionSource } from '@codemirror/autocomplete'

// P4+ — `[[wikilink]]` autocomplete. Triggers when the cursor sits right after
// an unclosed `[[…`; offers vault note titles (fetched fresh via `getTitles` so
// the editor doesn't need re-creating when the graph updates), and applies the
// pick as `title]]` to close the link.

export function wikilinkAutocomplete(getTitles: () => string[]) {
  const source: CompletionSource = (ctx) => {
    const before = ctx.matchBefore(/\[\[([^\]\n]*)$/)
    if (!before) return null
    const typed = before.text.slice(2) // text after the `[[`
    if (typed === '' && !ctx.explicit) {
      // On the bare `[[`, still offer the top options.
    }
    const q = typed.toLowerCase()
    const titles = getTitles()
    const seen = new Set<string>()
    const options = titles
      .filter((t) => {
        if (!t || seen.has(t)) return false
        seen.add(t)
        return t.toLowerCase().includes(q)
      })
      // exact-prefix matches first, then the rest, alphabetical
      .sort((a, b) => {
        const ap = a.toLowerCase().startsWith(q) ? 0 : 1
        const bp = b.toLowerCase().startsWith(q) ? 0 : 1
        return ap - bp || a.localeCompare(b)
      })
      .slice(0, 50)
      .map((t) => ({ label: t, type: 'text', apply: `${t}]]` }))
    if (options.length === 0) return null
    return { from: before.from + 2, options, validFor: /^[^\]\n]*$/ }
  }
  return autocompletion({ override: [source] })
}

// markdown-blocks — pure incremental markdown block splitter. NO React (plain ESM), so it is imported
// by BOTH MarkdownRenderer.tsx (streaming render) and scripts/efficiency-benchmark.mjs (the scaling
// probe). This is the incremental-block-lex win borrowed from an open-source chat renderer's "Quicksilver" lexer ("14×
// less splitter CPU"): a streamed message is split into top-level BLOCKS; closed blocks are stable and
// parsed/rendered ONCE (memoized), and only the OPEN (last) block re-parses as tokens arrive — turning
// the old "re-parse the whole growing document via <ReactMarkdown> on every token" O(n²) into O(n).

// Split markdown into top-level blocks separated by a blank line at depth 0 — but NEVER inside a fenced
// code block, so an in-progress ``` fence stays whole in the trailing block. Blank separators are dropped
// (each block renders with its own margin via CSS). PURE. The last element is the "open" block, which may
// be mid-construct while streaming.
export function splitMarkdownBlocks(text) {
  if (!text) return []
  const lines = text.split('\n')
  const blocks = []
  let cur = []
  let inFence = false
  let fenceChar = ''
  for (const line of lines) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fm) {
      const ch = fm[1][0]
      if (!inFence) { inFence = true; fenceChar = ch }
      else if (line.trimStart().startsWith(fenceChar.repeat(3))) { inFence = false }
      cur.push(line)
      continue
    }
    if (!inFence && line.trim() === '') {
      if (cur.length) { blocks.push(cur.join('\n')); cur = [] }
      continue
    }
    cur.push(line)
  }
  if (cur.length) blocks.push(cur.join('\n'))
  return blocks
}

// Incremental streaming state. Feed chunks; each push commits any newly-CLOSED blocks and returns
// { closed: string[], open: string }. Work per push is proportional only to the newly-arrived text +
// the current open block, NOT the whole buffer — the property the ratio probe measures. A blank line at
// depth 0 (outside a fence) closes the current open block. PURE (no clock, no IO).
export function createBlockStream() {
  const closed = []
  let openLines = [] // lines of the current (not-yet-closed) block
  let partial = '' // the current in-progress line (no newline yet)
  let inFence = false
  let fenceChar = ''
  const commit = () => { if (openLines.length) { closed.push(openLines.join('\n')); openLines = [] } }
  return {
    push(chunk) {
      partial += chunk
      let nl
      while ((nl = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, nl)
        partial = partial.slice(nl + 1)
        const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (fm) {
          const ch = fm[1][0]
          if (!inFence) { inFence = true; fenceChar = ch }
          else if (line.trimStart().startsWith(fenceChar.repeat(3))) { inFence = false }
          openLines.push(line)
        } else if (!inFence && line.trim() === '') {
          commit()
        } else {
          openLines.push(line)
        }
      }
      const open = (partial ? openLines.concat(partial) : openLines).join('\n')
      return { closed, open }
    }
  }
}

// Reference-style link/image definitions (`[id]: url`) and GFM footnote definitions (`[^id]: text`) are
// DOCUMENT-level: their USE (`[text][id]`, `[^1]`) can sit in a different block from their DEFINITION.
// Rendering blocks as isolated <ReactMarkdown> islands would sever them → the use leaks as RAW syntax.
// So harvest every definition line from the whole message; the renderer appends them to each block, where
// they resolve the reference and render to nothing when unreferenced. PURE. Returns '' for the common
// case (no reference-style syntax) so block content is UNCHANGED → the memo / O(n) win is preserved.
export function collectRefDefinitions(text) {
  if (!text || (text.indexOf(']:') === -1)) return '' // fast-path: no definition can exist
  const out = []
  for (const line of text.split('\n')) {
    // 0–3 leading spaces, then `[...]:` (covers `[id]:` and footnote `[^id]:`) + a value. Not `[x](url)`.
    if (/^ {0,3}\[[^\]]+\]:\s+\S/.test(line)) out.push(line)
  }
  return out.join('\n')
}

// SCALING PROBE HOOK for efficiency-benchmark.mjs. Total incremental work to stream a doc of `nBlocks`
// paragraph blocks token-by-token: per token, "parse" ONLY the open block (cost ∝ its bounded length);
// each closed block is "parsed" exactly once. For a real block-structured doc this is O(n). (A single
// unblocked mega-doc would still be O(n²) even here — honestly, because there are no closed boundaries to
// memoize; real markdown has blocks, which is exactly when the win applies.) Returns a checksum so the JIT
// can't elide the work.
export function streamRenderWork(nBlocks) {
  const stream = createBlockStream()
  const parse = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a = (a + s.charCodeAt(i)) | 0; return a }
  let closedParsed = 0
  let work = 0
  for (let b = 0; b < nBlocks; b++) {
    const para = 'lorem ipsum dolor sit amet consectetur '.repeat(3) + '\n\n' // ~120 chars + a boundary
    const toks = para.match(/[\s\S]{1,5}/g) || [para]
    for (const t of toks) {
      const { closed, open } = stream.push(t)
      work = (work + open.length) | 0 // re-parse only the OPEN block per token (bounded)
      while (closedParsed < closed.length) { work = (work + parse(closed[closedParsed])) | 0; closedParsed++ }
    }
  }
  return work
}

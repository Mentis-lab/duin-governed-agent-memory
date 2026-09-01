import { bindingOf, labelOf, type CanvasDoc, type CanvasNode } from './canvas-outline'

// JSON Canvas → an HTML fragment for the artifact preview.
//
// HYBRID ON PURPOSE: blocks are absolutely-positioned <div>s, edges are one
// <svg> layer behind them. Pure SVG would need hand-rolled line breaking with
// guessed font metrics, which degrades badly on CJK — and this vault is
// bilingual. HTML wraps both scripts correctly for free. Edges stay SVG because
// lines and arrowheads are painful in CSS.
//
// The edge layer is emitted BEFORE the blocks, so blocks paint on top and a
// centre-to-centre line visually terminates at the box edge. That removes the
// need for rect-edge intersection maths entirely.
//
// SECURITY: every string interpolated here is arbitrary vault content. Escaping
// is not cosmetic — see esc(). The `svg` artifact type deliberately does NOT
// escape because its content is model-authored markup; canvas content is user
// data and must be.

/** Obsidian's canvas colour presets. A `color` is either "1".."6" or a raw hex. */
const PRESET_COLORS: Record<string, string> = {
  '1': '#e5534b', // red
  '2': '#d9863b', // orange
  '3': '#d9c04b', // yellow
  '4': '#4bb563', // green
  '5': '#3fb0c9', // cyan
  '6': '#a970d1' // purple
}

const DEFAULT_STROKE = '#5a5a7a'
const DEFAULT_BLOCK_BG = '#232338'
const DEFAULT_BLOCK_FG = '#e8e8e8'
const PADDING = 48

/** Beyond this, the DOM (and the string we hand the sandbox) gets unreasonable.
 *  Truncation is REPORTED in the output — a silently-clipped diagram reads as a
 *  complete one, which is worse than a visibly partial one. */
const MAX_BLOCKS = 300

/** Longer than the outline's label cap: a visual box has room, and truncating a
 *  sticky note to 200 chars loses the content the human drew it for. Still
 *  bounded so one pasted essay can't dominate the document. */
const MAX_BLOCK_TEXT = 600

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function colorOf(node: CanvasNode, fallback: string): string {
  const c = node.color?.trim()
  if (!c) return fallback
  if (PRESET_COLORS[c]) return PRESET_COLORS[c]
  // Accept hex passthrough; reject anything else rather than letting arbitrary
  // text reach a style attribute.
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c
  return fallback
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The drawing area, derived from content. Canvas coordinates are routinely
 *  negative (Obsidian centres the origin on first use), so the viewport must be
 *  computed — assuming 0,0 is the top-left silently crops half the diagram. */
export function boundsOf(nodes: CanvasNode[]): Rect {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/** Display text for a block. Bound blocks (file/link) show the same identity the
 *  outline gives them; a prose block shows its own text, which is the thing the
 *  human actually drew. */
function displayText(node: CanvasNode): string {
  if (node.type === 'text') {
    const t = (node.text ?? '').trim()
    if (!t) return '(empty note)'
    return t.length > MAX_BLOCK_TEXT ? `${t.slice(0, MAX_BLOCK_TEXT - 1)}…` : t
  }
  return labelOf(node)
}

function blockDiv(node: CanvasNode, off: Rect): string {
  const left = Math.round(node.x - off.x + PADDING)
  const top = Math.round(node.y - off.y + PADDING)
  const w = Math.max(1, Math.round(node.width))
  const h = Math.max(1, Math.round(node.height))
  const accent = colorOf(node, DEFAULT_STROKE)
  const bound = bindingOf(node)
  const kindTag = bound ? `<span class="cv-kind">${esc(bound.kind)}</span>` : ''
  return (
    `<div class="cv-block" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;border-color:${accent}">` +
    `${kindTag}<div class="cv-text">${esc(displayText(node))}</div>` +
    `</div>`
  )
}

function groupDiv(node: CanvasNode, off: Rect): string {
  const left = Math.round(node.x - off.x + PADDING)
  const top = Math.round(node.y - off.y + PADDING)
  const w = Math.max(1, Math.round(node.width))
  const h = Math.max(1, Math.round(node.height))
  const accent = colorOf(node, DEFAULT_STROKE)
  const label = node.label?.trim()
  return (
    `<div class="cv-group" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;border-color:${accent}">` +
    (label ? `<div class="cv-group-label" style="color:${accent}">${esc(label)}</div>` : '') +
    `</div>`
  )
}

function centerOf(node: CanvasNode, off: Rect): { cx: number; cy: number } {
  return {
    cx: Math.round(node.x - off.x + PADDING + node.width / 2),
    cy: Math.round(node.y - off.y + PADDING + node.height / 2)
  }
}

/**
 * Render the canvas as a self-contained HTML fragment (no <html>/<head>).
 *
 * Deterministic: same document in, byte-identical fragment out, so a re-render
 * of an unchanged canvas produces no diff.
 */
export function canvasToHtmlFragment(doc: CanvasDoc): string {
  const { nodes, edges } = doc
  if (nodes.length === 0) {
    return `<div class="cv-empty">This canvas is empty — no blocks to draw.</div>`
  }

  const groups = nodes.filter((n) => n.type === 'group')
  const blocksAll = nodes.filter((n) => n.type !== 'group')
  const blocks = blocksAll.slice(0, MAX_BLOCKS)
  const truncated = blocksAll.length - blocks.length

  const drawn = [...groups, ...blocks]
  const off = boundsOf(drawn)
  const width = Math.round(off.width + PADDING * 2)
  const height = Math.round(off.height + PADDING * 2)

  const byId = new Map(drawn.map((n) => [n.id, n]))
  const visibleEdges = edges.filter((e) => byId.has(e.fromNode) && byId.has(e.toNode))

  const lines: string[] = []
  for (const e of visibleEdges) {
    const a = centerOf(byId.get(e.fromNode) as CanvasNode, off)
    const b = centerOf(byId.get(e.toNode) as CanvasNode, off)
    lines.push(
      `<line x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}" stroke="${DEFAULT_STROKE}" stroke-width="2" marker-end="url(#cv-arrow)"/>`
    )
    const label = e.label?.trim()
    if (label) {
      const mx = Math.round((a.cx + b.cx) / 2)
      const my = Math.round((a.cy + b.cy) / 2)
      lines.push(
        `<text x="${mx}" y="${my - 6}" fill="#b9b9d0" font-size="12" text-anchor="middle">${esc(label)}</text>`
      )
    }
  }

  const svg =
    `<svg class="cv-edges" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${DEFAULT_STROKE}"/></marker></defs>` +
    lines.join('') +
    `</svg>`

  const notice = truncated
    ? `<div class="cv-notice">Showing ${blocks.length} of ${blocksAll.length} blocks — this canvas is larger than the preview renders.</div>`
    : ''

  return (
    notice +
    `<div class="cv-root" style="width:${width}px;height:${height}px">` +
    svg +
    groups.map((g) => groupDiv(g, off)).join('') +
    blocks.map((b) => blockDiv(b, off)).join('') +
    `</div>`
  )
}

/** Styles for the fragment. Separate from the markup so the sandbox can place
 *  them in <head> and tests can assert on markup without style noise. */
export const CANVAS_STYLES = `
body{margin:0;background:#1a1a2e;color:${DEFAULT_BLOCK_FG};font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","Microsoft YaHei",sans-serif}
.cv-scroll{width:100vw;height:100vh;overflow:auto}
.cv-root{position:relative}
.cv-edges{position:absolute;left:0;top:0;pointer-events:none}
.cv-group{position:absolute;border:1px dashed;border-radius:10px;background:rgba(255,255,255,.02)}
.cv-group-label{position:absolute;top:-10px;left:12px;padding:0 6px;background:#1a1a2e;font-size:12px;font-weight:600}
.cv-block{position:absolute;box-sizing:border-box;border:1px solid;border-radius:8px;background:${DEFAULT_BLOCK_BG};padding:10px 12px;overflow:hidden;font-size:13px;line-height:1.45}
.cv-text{white-space:pre-wrap;overflow-wrap:anywhere}
.cv-kind{display:inline-block;margin-bottom:6px;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08);font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#b9b9d0}
.cv-empty,.cv-notice{padding:16px;color:#b9b9d0;font-size:13px}
.cv-notice{border-bottom:1px solid #2c2c44}
`.trim()

// The DUIN core mark: brain-wave lines within a ring on the brand ground, drawn in a 100×100
// box. Shared by the map's two painters (the legacy canvas draw and the cosmos renderer's DOM
// sprite, rendered once to a data URL by brain-shell), so the graph core matches the titlebar
// logo and the app icon.

let _corePath: Path2D | null = null
export const corePath = (): Path2D | null => {
  if (typeof Path2D === 'undefined') return null
  if (!_corePath) _corePath = new Path2D('M50 96 C29 93 18 74 25 55 C29 43 41 37 51 41 C51 29 67 21 81 27 C87 17 105 19 111 31 C125 32 133 50 126 65 C120 82 107 93 89 90 C69 87 57 73 64 59 C69 49 84 47 93 55')
  return _corePath
}

export function drawCoreMark(ctx: CanvasRenderingContext2D, accentOverride?: string): void {
  const light = typeof document !== 'undefined' && document.documentElement.dataset.themeMode === 'light'
  ctx.save()
  // Brand badge: light paper on the light theme, near-black brand ground on dark.
  ctx.beginPath(); ctx.arc(50, 50, 49, 0, 2 * Math.PI)
  ctx.fillStyle = light ? '#EEF0F3' : '#101013'; ctx.fill()
  // Single continuous-line brain mark (150×120 viewBox), fitted into the badge;
  // content centres ~ (74,58). Matches the titlebar logo + app icon.
  const p = corePath()
  if (p) {
    ctx.save()
    ctx.translate(50, 53); ctx.scale(0.52, 0.52); ctx.translate(-74, -58)
    // Ink strokes on light paper; off-white strokes on the dark badge.
    ctx.strokeStyle = light ? '#191A1E' : '#F2F0EA'; ctx.lineWidth = 6.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.stroke(p)
    // Accent node: the caller-hoisted value if given (the 2D draw passes one read once per
    // render, not per frame); else read live (cached-texture path).
    const accent = accentOverride || ((typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      : '') || '#d97757')
    ctx.beginPath(); ctx.arc(50, 96, 6.4, 0, 2 * Math.PI); ctx.fillStyle = accent; ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

/** An image element rasterised to square ImageData (aspect preserved, letterboxed). */
export function imageToImageData(img: HTMLImageElement, size = 128): ImageData | null {
  if (typeof document === 'undefined' || !img.complete || !img.naturalWidth) return null
  const c = document.createElement('canvas'); c.width = size; c.height = size
  const ctx = c.getContext('2d'); if (!ctx) return null
  const ar = img.naturalWidth / img.naturalHeight || 1
  const w = ar >= 1 ? size : size * ar, h = ar >= 1 ? size / ar : size
  try {
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
    return ctx.getImageData(0, 0, size, size)
  } catch { return null } // a cross-origin image taints the canvas; the DOM sprite stays the fallback
}

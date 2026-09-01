// Light-mode color adaptation for graph/category hues.
//
// Most of DUIN's node/category/status colors are bright pastels tuned to read on
// a near-black field. On the light theme they wash out — pale yellow/lime/teal as
// text or thin strokes on near-white is unreadable. `forLight` darkens a hue
// toward legibility (lighter input darkens more; hue preserved), and `chipColors`
// returns a mode-aware {color, backgroundColor} pair for the common "colored text
// on a low-alpha wash of the same color" chip pattern.

const _cache = new Map<string, string>()

/** Adapt a dark-field hue to read BRIGHT and CLEAR on the light theme's warm-cream
 *  surface (`--app-bg: #efe9df`, L≈90%). The old approach multiplied every channel
 *  down 16–60% by luminance, which darkened AND desaturated vivid pastels into mud.
 *  Instead, work in HSL: BOOST saturation (clarity) and CAP lightness (so nothing
 *  washes into the cream) — vivid mid-tones stay vivid; only over-pale hues get
 *  pulled down. Cached; callers may invoke per node per frame. Non-#rrggbb → as-is. */
export function forLight(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const hit = _cache.get(hex)
  if (hit) return hit
  const x = parseInt(m[1], 16)
  const r0 = ((x >> 16) & 255) / 255
  const g0 = ((x >> 8) & 255) / 255
  const b0 = (x & 255) / 255
  const max = Math.max(r0, g0, b0)
  const min = Math.min(r0, g0, b0)
  const d = max - min
  let hue = 0
  let s = 0
  let l = (max + min) / 2
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    hue = max === r0 ? (g0 - b0) / d + (g0 < b0 ? 6 : 0) : max === g0 ? (b0 - r0) / d + 2 : (r0 - g0) / d + 4
    hue /= 6
  }
  // Bright + clear on cream: more saturated, and no lighter than mid so it separates
  // from the L≈90% paper; a gentle floor keeps deep hues from muddy-black.
  s = Math.min(1, s * 1.25 + 0.06)
  l = Math.min(0.52, Math.max(0.3, l))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const r = s === 0 ? l : hk(hue + 1 / 3)
  const g = s === 0 ? l : hk(hue)
  const b = s === 0 ? l : hk(hue - 1 / 3)
  const h = (n: number): string => Math.round(n * 255).toString(16).padStart(2, '0')
  const out = `#${h(r)}${h(g)}${h(b)}`
  _cache.set(hex, out)
  return out
}

/** True when the app is currently in light mode (reads the DOM stamp set by
 *  apply-theme / the index.html boot script). Prefer passing an explicit `light`
 *  from a store subscription in React so the component re-renders on toggle. */
export function isLightMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.themeMode === 'light'
}

/** Mode-aware foreground + wash for a category chip (colored text on a faint
 *  tint of the same hue). In light mode the hue is darkened for contrast and the
 *  wash is slightly stronger so it reads on near-white. */
export function chipColors(
  hex: string,
  light: boolean = isLightMode()
): { color: string; backgroundColor: string } {
  const fg = light ? forLight(hex) : hex
  return { color: fg, backgroundColor: `${fg}${light ? '24' : '22'}` }
}

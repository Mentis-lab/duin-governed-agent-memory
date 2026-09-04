import type { ThemeMode, ThemePreset, ThemePresetTokens } from '@/lib/types'
import { getActiveTokens } from './theme-presets'

const TOKEN_TO_VAR: Record<keyof ThemePresetTokens, string> = {
  bgPrimary: '--bg-primary',
  bgSecondary: '--bg-secondary',
  bgTertiary: '--bg-tertiary',
  border: '--border',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  accent: '--accent',
  accentDim: '--accent-dim',
  success: '--success',
  warning: '--warning',
  error: '--error',
  codeBg: '--code-bg',
  appBg: '--app-bg',
  panelBg: '--panel-bg'
}

export function applyThemePreset(preset: ThemePreset, mode: ThemeMode = 'dark'): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const tokens = getActiveTokens(preset, mode)
  for (const [key, varName] of Object.entries(TOKEN_TO_VAR) as [
    keyof ThemePresetTokens,
    string
  ][]) {
    const value = tokens[key]
    if (value) root.style.setProperty(varName, value)
  }
  root.dataset.themePreset = preset.id
  root.dataset.themeMode = mode
  root.style.colorScheme = mode
  // Mirror the mode so the pre-paint boot script in index.html can stamp
  // data-theme-mode before React loads, avoiding a dark flash on cold start.
  try {
    window.localStorage.setItem('duin.themeMode', mode)
  } catch {
    /* private mode / storage disabled — boot script falls back to 'light' */
  }
}

/** Base font-size (px) that maps to 100% UI scale. */
export const BASE_FONT_SIZE = 14
export const MIN_FONT_SIZE = 11
export const MAX_FONT_SIZE = 22

/**
 * Scale the WHOLE interface (chrome + sidebar + panels + content) from the `fontSize`
 * setting, matching the Appearance label. Because ~all surface sizes are hard-coded `px`
 * (see ARCHITECTURE/FONT_AUDIT.md), a CSS var or root font-size can't reach them; and CSS
 * `zoom` on the `h-screen`/overflow-hidden root CLIPPED the layout. Instead we drive Electron's
 * native page zoom (`webFrame.setZoomFactor` via `window.api.setUiZoom`), which rescales the
 * viewport with the zoom so nothing clips. Idempotent + SSR-safe. `fontSize === BASE_FONT_SIZE`
 * (14) is 100%. Falls back to a no-op outside Electron.
 */
/** Pure: the clamped zoom ratio for a `fontSize` (px). 14 → 1.0. Falls back to 1.0 for
 *  missing/NaN input. Extracted for testing without a DOM. */
export function fontScaleRatio(fontSize: number | undefined): number {
  const px =
    typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : BASE_FONT_SIZE
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px))
  return clamped / BASE_FONT_SIZE
}

/** Chat transcript reading size in px. Separate from `fontSize`, which is page zoom:
 *  zoom scales chrome and content together and so can never change how large the
 *  transcript reads RELATIVE to the UI around it. This is that missing control. */
export const DEFAULT_CHAT_FONT_SIZE = 12
export const MIN_CHAT_FONT_SIZE = 10
export const MAX_CHAT_FONT_SIZE = 24

/** Clamp to the supported range, tolerating a missing/NaN input. Pure, for testing. */
export function chatFontSizePx(size: number | undefined): number {
  const px =
    typeof size === 'number' && Number.isFinite(size) ? size : DEFAULT_CHAT_FONT_SIZE
  return Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, px))
}

/** Publish the transcript size as `--chat-font-size`, which markdown.css's `.chat-md`
 *  and the composer both read — so the three halves of one surface cannot drift apart
 *  again. Until this existed the var was a hardcoded 12px with no writer at all. */
export function applyChatFontSize(size: number | undefined): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--chat-font-size', `${chatFontSizePx(size)}px`)
}

export function applyFontScale(fontSize: number | undefined): void {
  if (typeof window === 'undefined') return
  // Native page zoom scales everything uniformly, including `.markdown-body`, so we no
  // longer publish the content-only `--content-font-scale` var (it defaults to 1 → no
  // double-scale). Clear any stale value + legacy CSS zoom from prior builds.
  window.api?.setUiZoom?.(fontScaleRatio(fontSize))
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.style.removeProperty('--content-font-scale')
    root.style.removeProperty('zoom')
  }
}

/** Markdown DOCUMENT reading size in px — the note read view, a note in its own
 *  window, the Library document reader and the artifact markdown viewer.
 *
 *  Third control, and the last of the three the Appearance panel needs:
 *   • `fontSize`     — page zoom; scales chrome and content together.
 *   • `chatFontSize` — the transcript.
 *   • `docFontSize`  — a stored document being READ.
 *
 *  Documents had no control at all, and the four surfaces that render one had
 *  drifted to three different hardcoded sizes (12px in the Explorer panel, 14px
 *  in a detached window, 16px in Library/Artifacts) — so the same note changed
 *  size depending on where you opened it, and the smallest of them was the one
 *  you read most. One var now governs all four. */
export const DEFAULT_DOC_FONT_SIZE = 16
export const MIN_DOC_FONT_SIZE = 10
export const MAX_DOC_FONT_SIZE = 28

/** Clamp to the supported range, tolerating a missing/NaN input. Pure, for testing. */
export function docFontSizePx(size: number | undefined): number {
  const px =
    typeof size === 'number' && Number.isFinite(size) ? size : DEFAULT_DOC_FONT_SIZE
  return Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, px))
}

/** Publish the document size as `--doc-font-size`, which markdown.css's `.doc-md`
 *  reads. Headings, code, tables and quotes are all em-relative, so the whole
 *  hierarchy scales with it instead of flattening. */
export function applyDocFontSize(size: number | undefined): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--doc-font-size', `${docFontSizePx(size)}px`)
}

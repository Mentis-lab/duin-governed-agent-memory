import type { ThemeMode, ThemePreset, ThemePresetId, ThemePresetTokens } from '@/lib/types'

export const DEFAULT_PRESET_ID: ThemePresetId = 'duin-warm'
// Cold-start default is WARM DARK: the `duin-warm` preset ships a warm-charcoal
// dark variant, and a fresh install opens in it (operator preference 2026-07-24).
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

function tintToward(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const tr = Math.round(r + (255 - r) * amount)
  const tg = Math.round(g + (255 - g) * amount)
  const tb = Math.round(b + (255 - b) * amount)
  const toHex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${toHex(tr)}${toHex(tg)}${toHex(tb)}`
}

function shadeToward(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const tr = Math.round(r * (1 - amount))
  const tg = Math.round(g * (1 - amount))
  const tb = Math.round(b * (1 - amount))
  const toHex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${toHex(tr)}${toHex(tg)}${toHex(tb)}`
}

function relLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  const toLin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = toLin(parseInt(clean.slice(0, 2), 16))
  const g = toLin(parseInt(clean.slice(2, 4), 16))
  const b = toLin(parseInt(clean.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Darken an accent (tuned for a dark field) until it clears `minContrast` against
// white, so it stays legible as text/icon on the light theme's near-white surfaces.
// The dark-mode accent is calibrated to sit on black; on light it must be several
// shades deeper. Multiplicative shading preserves hue; small steps land near the
// threshold without over-darkening bright hues (mint/viridis) into mud.
function darkenForContrast(hex: string, minContrast: number): string {
  let out = hex
  for (let i = 0; i < 24; i++) {
    // Contrast vs white = (L_white + 0.05) / (L_accent + 0.05), L_white = 1.
    if (1.05 / (relLuminance(out) + 0.05) >= minContrast) break
    out = shadeToward(out, 0.08)
  }
  return out
}

function buildLightTokens(dark: ThemePresetTokens): ThemePresetTokens {
  // Use the preset's accent to lightly tint the surfaces so each preset still
  // feels distinct in light mode, without overwhelming the content.
  // Panels Phase: bgPrimary is now slightly off-white so form-control inputs
  // (which use bg-primary) read as distinct surfaces against the pure white
  // --panel-bg = #ffffff sidebars.
  return {
    bgPrimary: '#f8f9fa',
    bgSecondary: tintToward(dark.accent, 0.94),
    bgTertiary: tintToward(dark.accent, 0.88),
    border: tintToward(dark.accent, 0.78),
    textPrimary: '#0f1115',
    textSecondary: '#4a5160',
    // Was #8a92a0 (~3:1 on white — failed AA, and it carries 11px meta). #6b7280
    // clears 4.5:1 so muted meta stays legible in light mode.
    textMuted: '#6b7280',
    // WCAG AA (4.5:1) vs white — the old flat 12% darken kept a dark-tuned accent
    // that failed contrast for every bright preset (viridis 2.2, default 3.5, …).
    accent: darkenForContrast(dark.accent, 4.5),
    accentDim: tintToward(dark.accent, 0.82),
    success: shadeToward(dark.success, 0.1),
    warning: shadeToward(dark.warning, 0.1),
    error: shadeToward(dark.error, 0.05),
    codeBg: tintToward(dark.accent, 0.92),
    // Panels Phase: substrate is warm-tinted (cream-leaning per accent);
    // panel surface is pure white so existing --bg-tertiary cards on the
    // panel still read as a step down/cooler.
    appBg: tintToward(dark.accent, 0.92),
    panelBg: '#ffffff'
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    // The Claude-inspired default — warm paper (light) + warm charcoal (dark),
    // clay accent. Explicit lightTokens so the paper look is exact, not derived.
    id: 'duin-warm',
    name: 'Warm',
    source: 'Warm paper + clay accent',
    swatch: ['#efe9df', '#ebe4d8', '#c15f3c', '#2a2620', '#d97757'],
    tokens: {
      bgPrimary: '#211d18',
      bgSecondary: '#262320',
      bgTertiary: '#322d27',
      border: '#3a342c',
      textPrimary: '#f1ece3',
      textSecondary: '#a89f93',
      textMuted: '#6b6256',
      accent: '#d97757',
      accentDim: '#4a2c20',
      success: '#5a9e6a',
      warning: '#d4915a',
      error: '#c4564a',
      codeBg: '#1b1814',
      appBg: '#1a1714',
      panelBg: '#262320'
    },
    lightTokens: {
      bgPrimary: '#fdfbf7',
      bgSecondary: '#f4efe6',
      bgTertiary: '#ebe4d8',
      border: '#e2dacc',
      textPrimary: '#2a2620',
      textSecondary: '#6b6256',
      // #9c9388 was ~2.8:1 on the cream substrate; #736b62 clears AA.
      textMuted: '#736b62',
      accent: '#c15f3c',
      accentDim: '#ecdcd2',
      success: '#3d8a55',
      warning: '#b07628',
      error: '#b83a32',
      codeBg: '#f3ede2',
      appBg: '#efe9df',
      panelBg: '#faf7f1'
    }
  },
  {
    id: 'arcgis-blue',
    name: 'Blue',
    source: 'ArcGIS Blue 3',
    swatch: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
    tokens: {
      bgPrimary: '#0a0d12',
      bgSecondary: '#11151c',
      bgTertiary: '#1a2030',
      border: '#1f2a3a',
      textPrimary: '#e8edf3',
      textSecondary: '#8a96a8',
      textMuted: '#44546a',
      accent: '#6baed6',
      accentDim: '#1a3a5c',
      success: '#3d9e60',
      warning: '#c47a2a',
      error: '#c43a3a',
      codeBg: '#0d1118',
      appBg: '#07090d',
      panelBg: '#11151c'
    }
  },
  {
    id: 'lamprey-mint',
    name: 'Mint',
    source: 'Forest + mint, kelly green accent',
    swatch: ['#0e2818', '#1a5a2c', '#4cbb17', '#9ad99a', '#d4f0c8'],
    tokens: {
      bgPrimary: '#07140d',
      bgSecondary: '#0e1f15',
      bgTertiary: '#162c20',
      border: '#1f3a28',
      textPrimary: '#d8f0d8',
      textSecondary: '#7aa890',
      textMuted: '#3a5848',
      accent: '#4cbb17',
      accentDim: '#1c4218',
      success: '#3d9e60',
      warning: '#c47a2a',
      error: '#c43a3a',
      codeBg: '#0a180f',
      appBg: '#050e09',
      panelBg: '#0e1f15'
    }
  },
  {
    id: 'lamprey-default',
    name: 'Midnight',
    source: 'Blue on black',
    swatch: ['#0d0d0d', '#1f1f1f', '#4a9eff', '#e8e8e8', '#3d9e60'],
    tokens: {
      bgPrimary: '#0d0d0d',
      bgSecondary: '#161616',
      bgTertiary: '#1f1f1f',
      border: '#2a2a2a',
      textPrimary: '#e8e8e8',
      textSecondary: '#888888',
      textMuted: '#444444',
      accent: '#4a9eff',
      accentDim: '#1a3a5c',
      success: '#3d9e60',
      warning: '#c47a2a',
      error: '#c43a3a',
      codeBg: '#111111',
      appBg: '#090909',
      panelBg: '#161616'
    }
  }
]

export function getPreset(id: ThemePresetId | undefined): ThemePreset {
  return (
    THEME_PRESETS.find((p) => p.id === id) ??
    THEME_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ??
    THEME_PRESETS[0]
  )
}

export function getActiveTokens(preset: ThemePreset, mode: ThemeMode): ThemePresetTokens {
  if (mode === 'light') {
    return preset.lightTokens ?? buildLightTokens(preset.tokens)
  }
  return preset.tokens
}

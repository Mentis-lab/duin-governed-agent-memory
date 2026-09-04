// SP-1 (Sweet Spot Phase, 2026-06-10) — defaults parity lock.
//
// D1 (SP_BASELINE.md §1): the defaults object was maintained by hand in two
// files and drifted — renderer said `agentMode: 'auto'`, main said `'single'`,
// and main was missing `includePastReasoningInContext` entirely. The main
// process now imports the canonical DEFAULT_APP_SETTINGS; the renderer cannot
// (tsconfig project boundaries: web includes `src/**` only, node includes
// `electron/**` only), so it keeps a literal copy.
//
// This suite locks the copy to the canonical object the same way WC-8 locked
// the sidebar project flow: by reading the renderer SOURCE TEXT and asserting
// each canonical value appears verbatim. A default changed in one place but
// not the other fails here with the exact key named.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_APP_SETTINGS } from './default-app-settings'

const repoRoot = join(__dirname, '..', '..')
const rendererSource = readFileSync(
  join(repoRoot, 'src', 'stores', 'settings-store.ts'),
  'utf-8'
)
const themePresetsSource = readFileSync(
  join(repoRoot, 'src', 'styles', 'theme-presets.ts'),
  'utf-8'
)

/** Escape a string for use inside a RegExp literal. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Assert `key: <value>` appears in the renderer defaults literal. */
function expectRendererDefault(key: string, valueText: string): void {
  const re = new RegExp(`\\b${esc(key)}:\\s*${esc(valueText)}`)
  expect(rendererSource, `renderer settings-store.ts must contain \`${key}: ${valueText}\``).toMatch(re)
}

describe('SP-1 defaults parity — canonical vs renderer literal', () => {
  it('era keys match the decision registers (SP-1 + UB-7)', () => {
    expect(DEFAULT_APP_SETTINGS.toolSurface).toBe('full')
    expectRendererDefault('toolSurface', "'full'")
  })

  it('UB-7: retired keys are gone from BOTH defaults (absence locks)', () => {
    const canonical = DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>
    expect(canonical.agentMode).toBeUndefined()
    expect(canonical.agentRoster).toBeUndefined()
    expect(canonical.proofGate).toBeUndefined()
    expect(canonical.agenticCodingComposer).toBeUndefined()
    expect(rendererSource).not.toMatch(/\bagentMode:/)
    expect(rendererSource).not.toMatch(/\bagentRoster:/)
    expect(rendererSource).not.toMatch(/\bproofGate:/)
    expect(rendererSource).not.toMatch(/\bagenticCodingComposer:/)
    // 2026-09-03: three keys that had defaults and types but no reader anywhere.
    expect(canonical.theme).toBeUndefined()
    expect(canonical.sidebarCollapsed).toBeUndefined()
    expect(canonical.artifactPanelWidth).toBeUndefined()
    expect(rendererSource).not.toMatch(/^\s+theme:/m)
    expect(rendererSource).not.toMatch(/\bsidebarCollapsed:/)
    expect(rendererSource).not.toMatch(/\bartifactPanelWidth:/)
  })

  it('scalar defaults match', () => {
    expectRendererDefault('fontSize', String(DEFAULT_APP_SETTINGS.fontSize))
    expectRendererDefault('minimizeToTray', String(DEFAULT_APP_SETTINGS.minimizeToTray))
    expectRendererDefault('autoCheckUpdates', String(DEFAULT_APP_SETTINGS.autoCheckUpdates))
    expectRendererDefault('aiGeneratedTitles', String(DEFAULT_APP_SETTINGS.aiGeneratedTitles))
    expectRendererDefault('agenticCodingMode', String(DEFAULT_APP_SETTINGS.agenticCodingMode))
    expectRendererDefault('snipEnabled', String(DEFAULT_APP_SETTINGS.snipEnabled))
    // Nested blocks escaped this lock: watchers.jobFail read false in the renderer and true
    // in main for weeks (settings evaluation D8). Key lines are unique, so the same regex works.
    expectRendererDefault('jobFail', String(DEFAULT_APP_SETTINGS.watchers.jobFail))
    expectRendererDefault('forecastOwed', String(DEFAULT_APP_SETTINGS.watchers.forecastOwed))
    expectRendererDefault('confidentMiss', String(DEFAULT_APP_SETTINGS.watchers.confidentMiss))
    expectRendererDefault('multiQueryRewrite', String(DEFAULT_APP_SETTINGS.rag.multiQueryRewrite))
    expectRendererDefault('safeSeedLength', String(DEFAULT_APP_SETTINGS.safeSeedLength))
    expectRendererDefault(
      'includePastReasoningInContext',
      String(DEFAULT_APP_SETTINGS.includePastReasoningInContext)
    )
  })

  it('agentic coding skills match', () => {
    const listText = `[${DEFAULT_APP_SETTINGS.agenticCodingSkills.map((s) => `'${s}'`).join(', ')}]`
    expectRendererDefault('agenticCodingSkills', listText)
  })

  it('theme preset constants match the canonical strings', () => {
    // The renderer references DEFAULT_PRESET_ID / DEFAULT_THEME_MODE rather
    // than literals; lock the constants' definitions instead.
    expect(themePresetsSource).toMatch(
      new RegExp(`DEFAULT_PRESET_ID[^\\n]*=\\s*'${esc(DEFAULT_APP_SETTINGS.themePreset)}'`)
    )
    expect(themePresetsSource).toMatch(
      new RegExp(`DEFAULT_THEME_MODE[^\\n]*=\\s*'${esc(DEFAULT_APP_SETTINGS.themeMode)}'`)
    )
    expect(rendererSource).toMatch(/themePreset:\s*DEFAULT_PRESET_ID/)
    expect(rendererSource).toMatch(/themeMode:\s*DEFAULT_THEME_MODE/)
  })

  it('release D6: full computer access is OFF by default, and parity-locked', () => {
    // The public-build blocker (A4 F1 / A6 F1): a fresh install must be CONFINED. The renderer
    // literal must say the same, or the toggle in Settings → General would render ON while the
    // main process confined every tool.
    expect(DEFAULT_APP_SETTINGS.fullComputerAccess).toBe(false)
    expectRendererDefault('fullComputerAccess', 'false')
  })

  it('release M11: unattended cloud extraction is opt-in, and parity-locked', () => {
    expect(DEFAULT_APP_SETTINGS.cloudExtractionConsent).toBe(false)
    expectRendererDefault('cloudExtractionConsent', 'false')
    expect(DEFAULT_APP_SETTINGS.backgroundAutonomy).toBe(false)
    expectRendererDefault('backgroundAutonomy', 'false')
  })

  it('LP-7: loop defaults are OFF + bounded, and parity-locked', () => {
    expect(DEFAULT_APP_SETTINGS.loopsEnabled).toBe(false)
    expectRendererDefault('loopsEnabled', 'false')
    expectRendererDefault('loopMaxIterations', String(DEFAULT_APP_SETTINGS.loopMaxIterations))
    expectRendererDefault('loopMaxWallclockMs', String(DEFAULT_APP_SETTINGS.loopMaxWallclockMs))
    expectRendererDefault('loopTokenBudget', String(DEFAULT_APP_SETTINGS.loopTokenBudget))
    expectRendererDefault('loopMaxConcurrent', String(DEFAULT_APP_SETTINGS.loopMaxConcurrent))
    expectRendererDefault('loopMinIntervalSeconds', String(DEFAULT_APP_SETTINGS.loopMinIntervalSeconds))
  })

  // Keys the canonical object carries that the renderer literal is ALLOWED to lack for one phase,
  // because the two files sit in different lanes (SESSION-LANES). The exemption is itself checked:
  // the moment the renderer literal carries an exempted key, the second test below fails and names
  // the line to delete. Empty since 2026-09-03 — lane B landed `providerPolicy` in settings-store.ts
  // (integration @ 93148d6), so the 2026-09-02 exemption for it went; the mechanism stays.
  const RENDERER_PARITY_PENDING = new Set<string>([])

  it('every canonical key appears in the renderer literal', () => {
    for (const key of Object.keys(DEFAULT_APP_SETTINGS)) {
      if (RENDERER_PARITY_PENDING.has(key)) continue
      expect(rendererSource, `renderer defaults literal is missing key \`${key}\``).toMatch(
        new RegExp(`\\b${esc(key)}:`)
      )
    }
  })

  it('the renderer-parity exemption is still needed (remove it once lane B lands the key)', () => {
    for (const key of RENDERER_PARITY_PENDING) {
      expect(
        rendererSource,
        `renderer settings-store.ts now carries \`${key}:\` — delete it from RENDERER_PARITY_PENDING`
      ).not.toMatch(new RegExp(`\\b${esc(key)}:`))
    }
  })

  it('P0 model plane: the three model-id keys are gone from the canonical defaults', () => {
    // A stored model id is a claim the account is funded and the id still exists (S2, 2026-09-02).
    // The provider policy replaces all three; settings-helper migrates existing files once.
    const canonical = DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>
    expect(canonical.defaultModel).toBeUndefined()
    expect(canonical.backgroundModel).toBeUndefined()
    expect(canonical.brainEngine).toBeUndefined()
    expect(DEFAULT_APP_SETTINGS.providerPolicy).toEqual({ order: [], roles: {}, localOnlyBackground: false, speed: 'fast' })
  })
})

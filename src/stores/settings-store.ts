import { create } from 'zustand'
import type { AppSettings } from '@/lib/types'
import { DEFAULT_PRESET_ID, DEFAULT_THEME_MODE, getPreset } from '@/styles/theme-presets'
import {
  applyThemePreset,
  applyFontScale,
  applyChatFontSize,
  applyDocFontSize
} from '@/styles/apply-theme'
import { setUiLanguage } from '@/lib/i18n'
import { toast } from '@/stores/toast-store'

// Serializes settings.set writes so two rapid partials (e.g. a reasoningEffort
// persist + a theme toggle in the same tick) can't lost-update settings.json.
let settingsWriteQueue: Promise<boolean> = Promise.resolve(true)

const defaultSettings: AppSettings = {
  themePreset: DEFAULT_PRESET_ID,
  themeMode: DEFAULT_THEME_MODE,
  // Brain graph color scheme — 'default' preserves the original DUIN palette.
  brainGraphScheme: 'default',
  // Brain graph force + depth (Recall-style). 50 = today's d3-force defaults on
  // every axis (so an untouched graph is identical); depth 2 = 2-hop focus.
  // Mirror of DEFAULT_APP_SETTINGS (parity test locks the two).
  brainGraphLayout: { nodeSpacing: 50, linkLength: 50, linkForce: 50, centerForce: 50, connectionDepth: 2 },
  fontSize: 14,
  chatFontSize: 12,
  // Markdown document reading size. Mirror of DEFAULT_APP_SETTINGS (parity test locks the two).
  docFontSize: 16,
  sandboxWritePaths: [],
  // Full computer access OFF by default (public build; mirror of DEFAULT_APP_SETTINGS, parity
  // test locks the two). Off = confined to the vault/workspace/allowed folders; the operator
  // opts in under Settings → General → Computer access.
  fullComputerAccess: false,
  // Response language. 'auto' emits no reply-language directive (byte-identical default).
  // Mirror of DEFAULT_APP_SETTINGS (parity test locks the two).
  language: 'auto',
  // P0 model plane (2026-09-02): the stored-model-id settings (default / background / brain
  // engine) are gone — there is no default model. Mirror of DEFAULT_APP_SETTINGS.providerPolicy
  // (parity test locks the two). The renderer never READS this copy: policy is read and written
  // only through window.api.model (model-store.ts). Empty order = every keyed provider in
  // catalog order; speed 'fast' = each provider's quick model first.
  providerPolicy: { order: [], roles: {}, localOnlyBackground: false, speed: 'fast' },
  // DUIN — brain endpoint + optional live graph URL. Empty = env/localhost
  // for the brain, bundled demo for the graph.
  brainUrl: '',
  brainGraphUrl: '',
  localBrainNotesDir: '',
  minimizeToTray: false,
  autoCheckUpdates: true,
  aiGeneratedTitles: false,
  modelConfig: {},
  customModels: [],
  // NOTE: this literal is a copy of DEFAULT_APP_SETTINGS in
  // `electron/services/default-app-settings.ts` (tsconfig project boundaries
  // forbid a cross-import). `default-app-settings.test.ts` locks the two
  // together — change a default there first.
  //
  // UB-7 (Unburdening Phase, 2026-06-10) — agentMode / agentRoster /
  // proofGate / agenticCodingComposer retired with the pipeline, proof
  // machinery, and composer. `toolSurface: 'full'` is the era default;
  // 'lazy' stays as the MCP-heavy opt-in.
  toolSurface: 'full',
  agenticCodingMode: false,
  agenticCodingSkills: ['plan', 'context', 'verify'],
  snipEnabled: true,
  ttsEnabled: false,
  ttsProvider: 'openai',
  safeSeedLength: 8192,
  // R8 default — ON per user direction (2026-06-06). Closes the audit
  // gap where the model couldn't see its own past chain-of-thought on
  // follow-up turns. User-toggle lands in R9's Settings → Reasoning
  // Audit panel; flipping off is a power-user opt-out to save context
  // tokens on long conversations.
  includePastReasoningInContext: true,
  // Loop Phase LP-7 — autonomous loops, OFF by default (deliberate past-era
  // extension). Mirror of DEFAULT_APP_SETTINGS; parity test locks the two.
  loopsEnabled: false,
  enableHooks: true,
  loopMaxIterations: 25,
  loopMaxWallclockMs: 1800000,
  loopTokenBudget: 500000,
  loopMaxConcurrent: 1,
  loopMinIntervalSeconds: 30,
  backgroundAutonomy: false,
  // Release M11 — unattended cloud extraction is opt-in (mirror of DEFAULT_APP_SETTINGS; parity
  // test locks the two). Set main-side when a provider key is saved after the disclosure.
  cloudExtractionConsent: false,
  automationsEnabled: false,
  // OCR (image & scanned-doc text) — default ON. Mirror of DEFAULT_APP_SETTINGS
  // (parity test locks the two). The DUIN_OCR / DUIN_OCR_ENGINE env vars still
  // override the persisted setting main-side (see rag/loaders/ocr.ts).
  ocrEnabled: true,
  ocrEngine: 'tesseract',
  // Proactive — default outbound channel for scheduled / agent-initiated sends.
  // OS push needs no external creds. Mirror of DEFAULT_APP_SETTINGS (parity test
  // locks the two).
  homeChannel: { kind: 'push', target: '' },
  // Ingest — RSS/Atom feeds for the `rss` source adapter. Mirror of
  // DEFAULT_APP_SETTINGS (parity test locks the two). Empty = unconfigured.
  rssFeeds: [],
  // Proactive approval loop (#1) — designated operator per channel (ONLY this
  // identity may approve an AFK-gated action) + the AFK approval timeout before
  // default-deny. Mirror of DEFAULT_APP_SETTINGS (parity test locks the two).
  operator: { channelId: '', userId: '' },
  approvalTimeoutMs: 300000,
  // Proactive watch/notify (#2) — event-driven push on real internal signals. Each
  // watcher is INDIVIDUALLY enable-flagged and default OFF. Mirror of
  // DEFAULT_APP_SETTINGS (parity test locks the two).
  watchers: {
    forecast: false,
    calibration: false,
    task: false,
    jobFail: true,
    forecastOwed: false,
    confidentMiss: false,
    driftThreshold: 0.25,
    debounceMs: 300000,
    quietHours: { start: 0, end: 0 }
  },
  // Mirrors DEFAULT_APP_SETTINGS.rag (locked by default-app-settings.test.ts). Off by default:
  // the multi-query rewrite costs a planner round-trip per turn, so it stays an opt-in.
  rag: { multiQueryRewrite: false }
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  loadSettings: (signal?: AbortSignal) => Promise<boolean>
  updateSettings: (partial: Partial<AppSettings>) => Promise<boolean>
  toggleThemeMode: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings,
  loaded: false,

  loadSettings: async (signal) => {
    const result = await window.api.settings.get()
    if (signal?.aborted) return false
    if (result.success) {
      const merged: AppSettings = { ...defaultSettings, ...(result.data as Partial<AppSettings>) }
      set({ settings: merged, loaded: true })
      applyThemePreset(getPreset(merged.themePreset), merged.themeMode)
      applyFontScale(merged.fontSize)
      applyChatFontSize(merged.chatFontSize)
      applyDocFontSize(merged.docFontSize)
      // The language picker has existed since long before the strings did and drove
      // nothing. This is what makes it true.
      setUiLanguage(merged.language)
      return true
    }
    return false
  },

  updateSettings: (partial: Partial<AppSettings>) => {
    settingsWriteQueue = settingsWriteQueue.then(async () => {
      const prev = get().settings
      const updated = { ...prev, ...partial }
      set({ settings: updated })
      const presetChanged = partial.themePreset && partial.themePreset !== prev.themePreset
      const modeChanged = partial.themeMode && partial.themeMode !== prev.themeMode
      const fontSizeChanged = partial.fontSize !== undefined && partial.fontSize !== prev.fontSize
      const chatFontChanged =
        partial.chatFontSize !== undefined && partial.chatFontSize !== prev.chatFontSize
      const docFontChanged =
        partial.docFontSize !== undefined && partial.docFontSize !== prev.docFontSize
      const languageChanged = partial.language !== undefined && partial.language !== prev.language
      if (presetChanged || modeChanged) {
        applyThemePreset(getPreset(updated.themePreset), updated.themeMode)
      }
      if (fontSizeChanged) applyFontScale(updated.fontSize)
      if (chatFontChanged) applyChatFontSize(updated.chatFontSize)
      if (docFontChanged) applyDocFontSize(updated.docFontSize)
      if (languageChanged) setUiLanguage(updated.language)
      try {
        const res = await window.api.settings.set(partial as Record<string, unknown>)
        if (res && typeof res === 'object' && 'success' in res && !(res as { success: boolean }).success) {
          throw new Error((res as { error?: string }).error || 'settings save failed')
        }
        return true
      } catch (err) {
        // Persist failed — revert the optimistic update so the UI can't show a
        // setting as saved when it isn't, and surface the failure.
        set({ settings: prev })
        if (presetChanged || modeChanged) applyThemePreset(getPreset(prev.themePreset), prev.themeMode)
        if (fontSizeChanged) applyFontScale(prev.fontSize)
        if (chatFontChanged) applyChatFontSize(prev.chatFontSize)
        if (docFontChanged) applyDocFontSize(prev.docFontSize)
        if (languageChanged) setUiLanguage(prev.language)
        toast.error(`Couldn't save settings${err instanceof Error ? `: ${err.message}` : ''}`)
        return false
      }
    })
    return settingsWriteQueue
  },

  toggleThemeMode: async () => {
    const current = get().settings.themeMode
    const next = current === 'dark' ? 'light' : 'dark'
    await get().updateSettings({ themeMode: next })
  }
}))

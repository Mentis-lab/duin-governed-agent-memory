import { useState, useRef, useEffect, useMemo } from 'react'
import { t } from '@/lib/i18n'
import { useChatStore } from '@/stores/chat-store'
import { Button } from '@/components/ui/Button'
import { ShortcutKeys } from '@/components/ui/ShortcutKeys'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProvidersStore } from '@/stores/providers-store'
import { useUiStore, type PermissionsMode } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { ApiKeyModal } from '@/components/settings/ApiKeyModal'
import { SlashCommandPalette } from './SlashCommandPalette'
import { AtFileMention } from './AtFileMention'
import { ToolActivityChip } from './ToolActivityChip'
import { useSlashCommandsStore } from '@/stores/slash-commands-store'
import { useSkillsStore } from '@/stores/skills-store'
import { usePlanStore } from '@/stores/plan-store'
import { useLoopsStore } from '@/stores/loops-store'
import { parseLoopCommand } from '@/lib/parse-loop-command'
import { detectAtMention } from '@/lib/file-rank'
import { detectMemoryShortcut } from '@/lib/memory-shortcut'
import {
  emptyHistoryState,
  historyDown,
  historyReset,
  historyUp,
  type PromptHistoryState
} from '@/lib/prompt-history'
import { currentSlot, nextMode, slotLabel } from '@/lib/mode-cycle'
import { usePlanMode } from '@/hooks/usePlanMode'
import { AUTO_ENGINE, type ModelInfo, type ProcessedFile, type ProviderHealthReason } from '@/lib/types'
import { describeEngine, groupModelsForPicker, healthReasonLabel, providerFixHint } from '@/lib/model-label'

interface ChatInputProps {
  onSend: (content: string) => void
  onCancel: () => void
  isStreaming: boolean
  disabled?: boolean
}

const LONG_PASTE_THRESHOLD = 500

// Model-picker provider grouping (operator request, 2026-08-21). Prominence
// order for the sub-list headers; providers not named here (imported/custom)
// append alphabetically after. Labels are the offline fallback — the live
// provider list's labels win once listProviderKeys hydrates.
const PROVIDER_GROUP_ORDER: string[] = [
  'anthropic',
  'openai',
  'deepseek',
  'moonshot',
  'zhipu',
  'dashscope',
  'google',
  'xai',
  'openrouter',
  'ollama',
  'groq',
  'mistral',
  'github-models',
  'deepinfra'
]
const PROVIDER_GROUP_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI (Kimi)',
  zhipu: 'Zhipu AI (GLM)',
  dashscope: 'Alibaba Qwen',
  google: 'Google AI (Gemma)',
  xai: 'xAI (Grok)',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
  groq: 'Groq',
  mistral: 'Mistral AI',
  'github-models': 'GitHub Models',
  deepinfra: 'DeepInfra',
  custom: 'Custom models'
}

// Inline-SVG icon set — matches the app's convention (see Titlebar.tsx):
// viewBox 0 0 24 24, currentColor stroke so the glyphs theme automatically.
// `size` lets each call match the dimensions of the PNG it replaces.
interface SvgIconProps {
  size?: number
  className?: string
  children: React.ReactNode
}

function SvgIcon({ size = 18, className, children }: SvgIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

// shield-check
function ShieldCheckIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </SvgIcon>
  )
}

// shield
function ShieldIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </SvgIcon>
  )
}

// eye (auto-review)
function EyeIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </SvgIcon>
  )
}

// send (paper plane) — replaces the old oversized arrow-up glyph
function SendIcon({ size, className }: { size?: number; className?: string }) {
  return (
    <SvgIcon size={size} className={className}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </SvgIcon>
  )
}

// square (stop)
function StopIcon({ size, className }: { size?: number; className?: string }) {
  return (
    <SvgIcon size={size} className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </SvgIcon>
  )
}

// map-pin (work location)
function MapPinIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </SvgIcon>
  )
}

// folder
function FolderIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </SvgIcon>
  )
}

// git-branch (worktree)
function GitBranchIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </SvgIcon>
  )
}

// paperclip (add file)
function PaperclipIcon({ size }: { size?: number }) {
  return (
    <SvgIcon size={size}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </SvgIcon>
  )
}

interface PermissionOption {
  id: PermissionsMode
  label: string
  icon: React.ReactNode
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'default', label: 'Default permissions', icon: <ShieldIcon size={18} /> },
  { id: 'auto-review', label: 'Auto Review', icon: <EyeIcon size={18} /> },
  { id: 'full', label: 'Full Access', icon: <ShieldCheckIcon size={18} /> }
]

function looksLikeCode(text: string): boolean {
  if (text.length < LONG_PASTE_THRESHOLD) return false
  const lines = text.split(/\r?\n/)
  if (lines.length < 5) return false
  let signals = 0
  if (/[{};]\s*$/m.test(text)) signals++
  if (/^\s*(import|from|const|let|var|function|class|def|public|private)\b/m.test(text)) signals++
  if (/^\s*[{[]\s*$/m.test(text) && /^\s*[}\]]\s*$/m.test(text)) signals++
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) signals++
  return signals >= 1
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

interface DropdownButtonProps {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  title?: string
}

function DropdownButton({ open, onToggle, children, title }: DropdownButtonProps) {
  return (
    <button
      onClick={onToggle}
      title={title}
      aria-expanded={open}
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
    >
      {children}
      <ChevronDown />
    </button>
  )
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [active, onOutside, ref])
}

function CodingModeToggle() {
  // Pill mirrors AppSettings.agenticCodingMode. Persists via the standard
  // settings store, so the chat input and the SettingsDialog stay in sync
  // both ways without a separate IPC channel.
  const on = useSettingsStore((s) => s.settings.agenticCodingMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const openSettings = useUiStore((s) => s.openSettings)

  const handleToggle = () => {
    void updateSettings({ agenticCodingMode: !on })
  }

  // Knowledge-worker default: no coding chrome in the composer. The pill only
  // appears once Coding Mode is ON (so it can be turned back off); enabling it
  // lives in Settings → Advanced → Coding Mode.
  if (!on) return null

  return (
    <button
      type="button"
      onClick={handleToggle}
      onContextMenu={(e) => {
        e.preventDefault()
        openSettings('agenticCoding')
      }}
      title={
        on
          ? 'Agentic coding mode is ON · click to turn off · right-click to configure'
          : 'Turn on agentic coding mode (coding contract + codex skills + composer) · right-click to configure'
      }
      aria-pressed={on}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] transition-colors ${
        on
          ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
          : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          on ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]'
        }`}
        aria-hidden
      />
      <span className="font-mono uppercase tracking-wider">{t('Coding')}</span>
    </button>
  )
}

function PermissionsDropdown() {
  const mode = useUiStore((s) => s.permissionsMode)
  const setMode = useUiStore((s) => s.setPermissionsMode)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useClickOutside(wrapRef, () => setOpen(false), open)

  const active = PERMISSION_OPTIONS.find((o) => o.id === mode) ?? PERMISSION_OPTIONS[0]

  return (
    <div ref={wrapRef} className="relative">
      {/* The shortcut lives here rather than in a separate caption under the
          composer. That caption stated "⇧⇥ to cycle" unconditionally while the
          binding is CONDITIONAL — the handler only claims Shift+Tab when the
          textarea is empty, so pressing it mid-draft did nothing and read as
          broken. A tooltip on the control that actually owns the state can say
          that precisely, and there is one place showing the mode instead of two. */}
      <DropdownButton
        open={open}
        onToggle={() => setOpen((v) => !v)}
        title={t('Permissions mode — Shift+Tab cycles when the composer is empty')}
      >
        <span className="flex h-[25px] w-[25px] items-center justify-center">{active.icon}</span>
        <span>{active.label}</span>
      </DropdownButton>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-52 overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-xl">
          {PERMISSION_OPTIONS.map((opt) => {
            const icon = opt.icon
            return (
              <button
                key={opt.id}
                onClick={() => {
                  setMode(opt.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                  opt.id === mode
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span className="flex h-[25px] w-[25px] items-center justify-center">{icon}</span>
                <span>{opt.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const EFFORT_LEVELS: { id: 'low' | 'medium' | 'high' | 'max'; label: string; hint: string }[] = [
  { id: 'low', label: 'Low', hint: 'Fastest — minimal thinking' },
  { id: 'medium', label: 'Medium', hint: 'Balanced reasoning' },
  { id: 'high', label: 'High', hint: 'Deep reasoning (slower)' },
  { id: 'max', label: 'Max', hint: 'Maximum reasoning — deepest & slowest' }
]

// Reasoning-effort toggle. Always shown: the backend only applies
// reasoning_effort for models that support it (registry gates the wire) and the
// internal brain honors it, so an always-visible control can never misbehave —
// it simply no-ops on models that ignore effort. (Previously gated to
// reasoner/internal models, which hid it for GLM and other capable models not
// flagged as reasoners, so the control appeared to vanish.)
function EffortDropdown() {
  const effort = useChatStore((s) => s.reasoningEffort)
  const setEffort = useChatStore((s) => s.setReasoningEffort)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useClickOutside(wrapRef, () => setOpen(false), open)

  const current = EFFORT_LEVELS.find((l) => l.id === effort) ?? EFFORT_LEVELS[0]
  return (
    <div ref={wrapRef} className="relative">
      <DropdownButton open={open} onToggle={() => setOpen((v) => !v)} title={t('Reasoning effort')}>
        <span className="opacity-70">{t('Effort')}</span>
        <span>{current.label}</span>
      </DropdownButton>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[190px] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg z-50">
          {EFFORT_LEVELS.map((l) => (
            <button
              key={l.id}
              onClick={() => {
                setEffort(l.id)
                setOpen(false)
              }}
              className={`flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)] ${
                l.id === effort ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              <span className="text-[12px] font-medium">
                {l.label}
                {l.id === effort ? ' ✓' : ''}
              </span>
              <span className="text-[11px] text-[var(--text-tertiary)]">{l.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ModelDropdownProps {
  onRequestKey: (providerId: string) => void
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  )
}

function ModelDropdown({ onRequestKey }: ModelDropdownProps) {
  // The picker writes a PIN for the active conversation (chat-store.setModel) — never a
  // global setting — and renders what that pin resolves to from model-store, the renderer's
  // one model-plane source (policy + health + resolution, all read from main).
  const activeModel = useChatStore((s) => s.activeModel)
  const setModel = useChatStore((s) => s.setModel)
  const allModels = useModelStore((s) => s.models)
  const policy = useModelStore((s) => s.policy)
  const health = useModelStore((s) => s.health)
  const resolution = useModelStore((s) => s.resolution)
  const refreshHealth = useModelStore((s) => s.refreshHealth)
  const providerEntries = useProvidersStore((s) => s.providers)
  const refreshProviders = useProvidersStore((s) => s.refresh)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useClickOutside(wrapRef, () => setOpen(false), open)

  // Re-read provider labels + cached health every time the picker opens, so a key added in
  // Settings (which main probes on save) shows as a healthy group without reopening the app.
  useEffect(() => {
    void refreshProviders()
    if (open) void refreshHealth()
  }, [open, refreshProviders, refreshHealth])

  // No offline roster of model ids: the live catalog (model:list) is the only list.
  const models = allModels.filter((m) => !m.internal)
  const engine = describeEngine(activeModel, resolution, allModels)
  const healthOf = (pid: string | undefined) => (pid ? health.find((h) => h.provider === pid) : undefined)
  const providerLabel = (pid: string): string =>
    providerEntries.find((e) => e.id === pid)?.label ?? PROVIDER_GROUP_LABELS[pid] ?? pid

  // Provider groups in POLICY order (the operator's preference is the primary key of every
  // resolution); providers outside the order append in the curated fallback order. A group
  // is usable iff its provider's latest REAL probe says healthy — a key merely existing is
  // not "usable" (L5 F2: Anthropic listed first as usable with no credit). Unhealthy groups
  // stay in place, greyed, with the reason and the fix hint; no-key groups offer "Add key".
  const groupedModels = useMemo(
    () =>
      groupModelsForPicker({
        models,
        policyOrder: policy?.order ?? [],
        curatedOrder: PROVIDER_GROUP_ORDER,
        health,
        label: (pid) => providerEntries.find((e) => e.id === pid)?.label ?? PROVIDER_GROUP_LABELS[pid] ?? pid
      }),
    [models, policy, health, providerEntries]
  )

  const renderModelRow = (m: ModelInfo, group: { healthy: boolean; reason?: ProviderHealthReason; probed: boolean }) => {
    const noKey = group.reason === 'no-key'
    const greyed = group.probed && !group.healthy
    const isActive = activeModel === m.id
    const hint = greyed ? providerFixHint(group.reason, providerLabel(m.provider ?? 'custom')) : ''
    return (
      <button
        key={m.id}
        title={hint || undefined}
        onClick={() => {
          setOpen(false)
          if (noKey) {
            if (m.provider) onRequestKey(m.provider)
            else toast.error(`No provider configured for ${m.name}`)
            return
          }
          void setModel(m.id)
        }}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
          isActive
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : greyed
            ? 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {greyed && (
              <span className="shrink-0 text-[var(--warning)]">
                <LockIcon />
              </span>
            )}
            <span className="truncate font-medium">{m.name}</span>
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {greyed ? healthReasonLabel(group.reason) : 'routed through your brain'}
          </span>
        </span>
        {isActive ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent)]" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : noKey ? (
          <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-wider text-[var(--warning)]">
            {t('Add key')}
          </span>
        ) : null}
      </button>
    )
  }

  const pinnedHealth = healthOf(allModels.find((m) => m.id === activeModel)?.provider)
  const chipWarning = activeModel !== AUTO_ENGINE && pinnedHealth && !pinnedHealth.healthy
    ? `${providerLabel(pinnedHealth.provider)}: ${healthReasonLabel(pinnedHealth.reason)}`
    : engine.mode === 'none'
      ? t('No provider can answer right now')
      : ''

  return (
    <div ref={wrapRef} className="relative">
      <DropdownButton open={open} onToggle={() => setOpen((v) => !v)} title={chipWarning || t('Switch model')}>
        {chipWarning && (
          <span className="text-[var(--warning)]" title={chipWarning}>
            <LockIcon />
          </span>
        )}
        <span className="font-medium">{engine.label}</span>
      </DropdownButton>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 max-h-[60vh] w-80 overflow-y-auto overscroll-contain rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-xl">
          <div className="px-3 pt-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            {t('Engine · every model routes through your brain')}
          </div>
          {/* First entry: no pin — the chat role follows the provider policy and live health. */}
          <button
            onClick={() => {
              setOpen(false)
              void setModel(AUTO_ENGINE)
            }}
            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
              activeModel === AUTO_ENGINE
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium">{t('Auto (provider policy)')}</span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {activeModel === AUTO_ENGINE && resolution
                  ? `→ ${engine.label}`
                  : t('Healthiest provider in your order, re-checked every turn')}
              </span>
            </span>
            {activeModel === AUTO_ENGINE && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent)]" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
          </button>
          {models.length === 0 && (
            <div className="border-t border-[var(--panel-border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
              {t('Loading models…')}
            </div>
          )}
          {groupedModels.map((g) => (
            <div key={g.id}>
              <div
                className={`border-t border-[var(--panel-border)] px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider ${
                  g.probed && !g.healthy ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'
                }`}
                title={g.probed && !g.healthy ? providerFixHint(g.reason, g.label) : undefined}
              >
                {g.label}
                {g.probed && (
                  <span className={`ml-1.5 normal-case tracking-normal ${g.healthy ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                    · {healthReasonLabel(g.reason)}
                  </span>
                )}
              </div>
              {g.models.map((m) => renderModelRow(m, g))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ChipMenuItem {
  label: string
  description?: string
  onSelect: () => void
  active?: boolean
}

interface ContextChipProps {
  icon: React.ReactNode
  label: string
  title?: string
  onClick?: () => void
  menu?: ChipMenuItem[]
}

function ContextChip({ icon, label, title, onClick, menu }: ContextChipProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useClickOutside(wrapRef, () => setOpen(false), open)

  const hasMenu = !!menu && menu.length > 0
  const interactive = hasMenu || !!onClick

  const handleClick = () => {
    if (hasMenu) {
      setOpen((v) => !v)
      return
    }
    onClick?.()
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        title={title ?? label}
        disabled={!interactive}
        aria-haspopup={hasMenu ? 'menu' : undefined}
        aria-expanded={hasMenu ? open : undefined}
        className={`flex items-center gap-1.5 rounded-md border border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors ${
          interactive
            ? 'hover:border-[var(--accent)] hover:text-[var(--text-primary)]'
            : 'cursor-default opacity-90'
        } ${open ? 'border-[var(--accent)] text-[var(--text-primary)]' : ''}`}
      >
        <span className="relative flex h-[18px] w-[18px] items-center justify-center">
          {icon}
        </span>
        <span className="leading-none">{label}</span>
        {hasMenu && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>

      {hasMenu && open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[220px] overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] py-1 shadow-xl"
        >
          {menu!.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
                item.active
                  ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span className="font-medium">{item.label}</span>
              {item.description && (
                <span className="text-[11px] text-[var(--text-muted)]">{item.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ContextChipRowProps {
  onAddFile: () => void
}

function ContextChipRow({ onAddFile }: ContextChipRowProps) {
  const [workdir, setWorkdir] = useState<{ path: string; name: string } | null>(null)
  // Coding chrome (git worktree) only shows in Coding Mode — the default
  // knowledge-worker composer stays clean. Toggle lives in Settings → Advanced.
  const codingMode = useSettingsStore((s) => s.settings.agenticCodingMode)
  // The brain folder is also the working folder: first-run setup and Settings → Brain both
  // point the workdir at it. This chip mounts before either runs and used to read the workdir
  // once, so it kept naming the app's own directory after a first run. Re-read whenever the
  // brain folder changes.
  const brainDir = useSettingsStore((s) => s.settings.localBrainNotesDir)

  useEffect(() => {
    if (!window.api?.files?.getWorkdir) return
    let cancelled = false
    window.api.files
      .getWorkdir()
      .then((res: { success: boolean; data?: { path: string; name: string } }) => {
        if (!cancelled && res.success && res.data) setWorkdir(res.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [brainDir])

  const handlePickFolder = async () => {
    if (!window.api?.files?.pickWorkdir) return
    try {
      const res = await window.api.files.pickWorkdir()
      if (!(res.success && res.data)) return
      // pickWorkdir only returns the chosen path; persisting it through
      // setWorkdir is what makes tool execution honor the user's choice.
      // The chip-local state mirrors the persisted value either way.
      const persisted = await window.api.files.setWorkdir?.(res.data.path)
      if (persisted && persisted.success && persisted.data) {
        setWorkdir(persisted.data)
      } else {
        setWorkdir(res.data)
      }
    } catch {
      /* ignore */
    }
  }

  const folderLabel = workdir?.name ?? '(no folder)'
  const folderTitle = workdir?.path
    ? `Working folder: ${workdir.path} (click to change)`
    : 'Click to choose a working folder'

  const locationMenu: ChipMenuItem[] = [
    {
      label: 'Local',
      description: 'This machine',
      active: true,
      onSelect: () => {
        /* already local */
      }
    },
    {
      label: 'Remote (coming soon)',
      description: 'Run against a remote dev container',
      onSelect: () => toast.info('Remote execution: coming soon')
    }
  ]

  const folderMenu: ChipMenuItem[] = [
    {
      label: 'Change folder…',
      description: workdir?.path ?? 'No folder selected',
      onSelect: handlePickFolder
    },
    {
      label: 'Use current process folder',
      description: 'Reset to the folder DUIN was launched from',
      onSelect: () => {
        // Reset: clearWorkdir drops the persisted override, getWorkdir then
        // returns process.cwd() as the fallback.
        const api = window.api?.files
        if (!api) return
        const clear = api.clearWorkdir
          ? api.clearWorkdir()
          : Promise.resolve({ success: true })
        Promise.resolve(clear)
          .then(() => api.getWorkdir())
          .then((res: { success: boolean; data?: { path: string; name: string } }) => {
            if (res.success && res.data) setWorkdir(res.data)
          })
          .catch(() => {})
      }
    }
  ]

  const worktreeMenu: ChipMenuItem[] = [
    { label: 'main', description: 'Default branch', active: true, onSelect: () => {} },
    {
      label: 'Switch branch (coming soon)',
      description: 'Pick a different git branch',
      onSelect: () => toast.info('Branch switching: coming soon')
    },
    {
      label: 'New worktree (coming soon)',
      description: 'Run agents in an isolated worktree',
      onSelect: () => toast.info('Worktrees: coming soon')
    }
  ]

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
      <ContextChip
        icon={<MapPinIcon size={16} />}
        label={t('Local')}
        title={t('Running locally on this machine')}
        menu={locationMenu}
      />
      <ContextChip
        icon={<FolderIcon size={16} />}
        label={folderLabel}
        title={folderTitle}
        menu={folderMenu}
      />
      {codingMode && (
        <ContextChip
          icon={<GitBranchIcon size={16} />}
          label="main · worktree"
          title={t('Active git worktree')}
          menu={worktreeMenu}
        />
      )}
      <ContextChip
        icon={<PaperclipIcon size={16} />}
        label={t('Add file')}
        title={t('Attach a file to your prompt')}
        onClick={onAddFile}
      />
      {/* Right-aligned tool-activity consolidator. The cards used to live
          inline in the transcript and stack into a wall of rows during
          exploration bursts; they now hide behind this chip so the chat
          panel stays clean. The chip itself returns null when the turn
          has no tool calls, so idle turns show nothing here. */}
      <ToolActivityChip />
    </div>
  )
}

interface AddMenuItem {
  label: string
  shortcut?: string
  onSelect: () => void
}

interface AddMenuProps {
  onPickFile: () => void
  onOpenSettings: () => void
  onInsertSlash: () => void
}

function AddMenu({ onPickFile, onOpenSettings, onInsertSlash }: AddMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useClickOutside(wrapRef, () => setOpen(false), open)

  const items: AddMenuItem[] = [
    { label: 'Add files or photos', shortcut: 'Ctrl+U', onSelect: onPickFile },
    { label: 'Add folder', onSelect: () => toast.info('Add folder: coming soon') },
    { label: 'Slash commands', onSelect: onInsertSlash },
    // Connectors + Plugins route to the real Customize surfaces that now exist
    // (MCP servers / skill+connector packs) instead of a "coming soon" stub /
    // generic Settings. "Import GitHub issue" removed until the feature exists
    // (github IPC has auth but no issue-import), per operator direction.
    { label: 'Connectors', onSelect: () => useUiStore.getState().openCustomize('connectors') },
    { label: 'Plugins', onSelect: () => useUiStore.getState().openCustomize('plugins') }
  ]

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t('Add')}
        aria-label={t('Add')}
        className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-60 overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] py-1 shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <span>{item.label}</span>
              {item.shortcut && <ShortcutKeys combo={item.shortcut} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ChatInput({ onSend, onCancel, isStreaming, disabled }: ChatInputProps) {
  const [content, setContent] = useState('')
  const [pasteOffer, setPasteOffer] = useState<string | null>(null)
  const [keyPromptProvider, setKeyPromptProvider] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Fluidity J1: ↑/↓ walks past user prompts. Index tracking lives in a ref
  // so re-renders triggered by setContent() don't reset our position.
  const historyRef = useRef<PromptHistoryState>(emptyHistoryState)
  const addAttachments = useChatStore((s) => s.addAttachments)
  const setProcessing = useChatStore((s) => s.setAttachmentsProcessing)
  const composeSeedToken = useUiStore((s) => s.composeSeedToken)
  const consumeComposeDraft = useUiStore((s) => s.consumeComposeDraft)
  const seedMemoryDescription = useUiStore((s) => s.seedMemoryDescription)
  const openSettings = useUiStore((s) => s.openSettings)
  const refreshProviders = useProvidersStore((s) => s.refresh)
  const hasKey = useProvidersStore((s) => s.hasKey)
  const providersLoaded = useProvidersStore((s) => s.loaded)
  const activeModel = useChatStore((s) => s.activeModel)
  const allModels = useModelStore((s) => s.models)
  const pinnedProviderHealth = useModelStore((s) => s.healthFor(allModels.find((m) => m.id === activeModel)?.provider))
  const activeModelInfo = activeModel === AUTO_ENGINE ? undefined : allModels.find((m) => m.id === activeModel)
  const activeProvider = activeModelInfo?.provider
  // The submit gate opens the key modal ONLY for a pinned provider whose live health says
  // "no key" — the one failure a modal fixes. AUTO_ENGINE never gates (the policy resolves a
  // healthy provider), and every other unhealthy reason is reported by the turn itself.
  const activeProviderHasKey = activeProvider
    ? pinnedProviderHealth
      ? pinnedProviderHealth.reason !== 'no-key'
      : !providersLoaded || hasKey(activeProvider)
    : true

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const resize = () => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
    resize()
    // Re-measure after paint. On first mount the synchronous pass can report an
    // empty textarea at the 200px cap, leaving the home composer stuck tall
    // until the first keystroke; a post-paint re-measure settles it to ~28px.
    const raf = requestAnimationFrame(resize)
    return () => cancelAnimationFrame(raf)
  }, [content])

  // Take focus on mount.
  //
  // ChatView renders a composer in TWO mutually exclusive branches: a floating
  // one over the graph while the chat overlay is closed, and a second one in the
  // overlay's footer once it opens. `chatOpen` flips on the FIRST send of a
  // conversation (it requires messages.length > 0), so at that moment React
  // unmounts the composer you just typed into and mounts a different one. Focus
  // went with it — to <body> — and every following keystroke went nowhere until
  // you clicked the new box. That is the "sometimes I can't type in Ask
  // anything", and it is why it looked tied to the first prompt.
  //
  // Guarded: never steal focus from a field the operator is already typing in.
  // The composer can also mount while a modal or a settings input has focus.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    const typingElsewhere =
      !!active &&
      active !== document.body &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable)
    if (typingElsewhere) return
    // rAF so the focus lands after the mount commit paints; focusing during the
    // same frame as the unmount of the previous composer gets undone.
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    if (composeSeedToken === 0) return
    const seed = consumeComposeDraft()
    if (!seed) return
    setContent(seed)
    const ta = textareaRef.current
    if (ta) {
      ta.focus()
      requestAnimationFrame(() => {
        const len = ta.value.length
        ta.setSelectionRange(len, len)
      })
    }
  }, [composeSeedToken, consumeComposeDraft])

  const handleSlashCommand = async (raw: string): Promise<boolean> => {
    const tokens = raw.trim().split(/\s+/)
    const cmd = tokens[0]?.toLowerCase()
    const activeConvId = useChatStore.getState().activeConversationId
    switch (cmd) {
      case '/compact': {
        if (!activeConvId) {
          toast.error('No active conversation.')
          return true
        }
        toast.info('Compacting conversation…')
        const res = await window.api?.conversation?.compact(activeConvId)
        if (!res?.success) {
          toast.error(res?.error ?? 'Compact failed')
        } else {
          await useChatStore.getState().selectConversation(activeConvId)
          toast.success('Conversation compacted.')
        }
        return true
      }
      case '/fork': {
        if (!activeConvId) {
          toast.error('No active conversation.')
          return true
        }
        const res = await window.api?.conversation?.fork(activeConvId)
        if (!res?.success) {
          toast.error(res?.error ?? 'Fork failed')
        } else {
          await useChatStore.getState().loadConversations()
          const forked = res.data as { conversationId: string }
          await useChatStore.getState().selectConversation(forked.conversationId)
          toast.success('Forked conversation.')
        }
        return true
      }
      case '/models': {
        // Open settings on the Models pane — closest hook we have.
        useUiStore.getState().openSettings()
        toast.info('Pick a model in Settings → Models')
        return true
      }
      case '/fast': {
        toast.info('Fast mode is not yet wired to a provider in DUIN.')
        return true
      }
      case '/plan': {
        // Track 2 / C4 + C3 — `/plan` now flips the real per-conversation
        // dispatcher gate (PlanModeBanner appears). The legacy UI flag
        // and Shift+Tab toggle keep working alongside it for now.
        if (activeConvId) {
          const ok = await usePlanStore.getState().enterPlanMode(activeConvId)
          if (ok) toast.success('Plan mode is on. Mutating tools are blocked.')
          else toast.error('Failed to enter plan mode.')
        } else {
          toast.error('No active conversation.')
        }
        return true
      }
      case '/clear': {
        // Track 2 / C4 — renderer-side clear: drop visible messages but
        // keep the conversation row. The `clear.md` template is hidden in
        // the palette and only resolves through IPC for harness use.
        useChatStore.setState({ messages: [], streamingContent: '', streamingReasoning: '' })
        toast.info('Cleared visible messages.')
        return true
      }
      case '/loop': {
        // Loop Phase LP-8 — start a recurring loop in the current conversation.
        //   /loop <task>           self-paced (model paces itself)
        //   /loop 5m <task>        interval (fixed cadence)
        //   /loop --auto <mission> autonomous (drains + grows its own backlog)
        if (!useSettingsStore.getState().settings.loopsEnabled) {
          toast.error('Loops are off. Enable them in Settings → Loops.')
          return true
        }
        const rest = raw.trim().slice(cmd?.length ?? 0).trim()
        const parsed = parseLoopCommand(rest)
        if (parsed.error) {
          toast.error(parsed.error)
          return true
        }
        const loop = await useLoopsStore.getState().create({
          mode: parsed.mode,
          conversationId: activeConvId ?? undefined,
          instruction: parsed.instruction,
          intervalSeconds: parsed.intervalSeconds,
          tasks: parsed.tasks
        })
        if (loop) {
          toast.success(`Loop started (${parsed.mode.replace('_', '-')}).`)
          if (loop.conversationId && loop.conversationId !== activeConvId) {
            await useChatStore.getState().loadConversations()
            await useChatStore.getState().selectConversation(loop.conversationId)
          }
        }
        return true
      }
      default: {
        // Track 2 / C4 — try the filesystem-discovered slash-command
        // resolver. Anything that resolves to a prompt is dispatched as a
        // normal user turn. Unknown commands fall through to a toast so
        // the user sees the typo.
        const rest = raw.trim().slice(cmd?.length ?? 0).trim()
        const slashResult = await useSlashCommandsStore
          .getState()
          .resolve(cmd?.slice(1) ?? '', rest)
        if (slashResult) {
          // Methods activate the skills they wire for THIS turn — the prompt is
          // then dispatched in the current conversation like any other, so the
          // active-skill set must be set before onSend (which reads it).
          if (slashResult.activateSkills?.length) {
            const skillStore = useSkillsStore.getState()
            const merged = [...new Set([...skillStore.activeSkillIds, ...slashResult.activateSkills])]
            skillStore.setActiveSkillIds(merged)
          }
          onSend(slashResult.prompt)
          return true
        }
        toast.error(`Unknown slash command: ${cmd}`)
        return true
      }
    }
  }

  // Fluidity J3: @file mention popover state. The popover is independent
  // of the slash palette and triggers when detectAtMention finds an
  // `@<token>` immediately preceding the caret (not inside a code fence).
  // workspaceFiles caches walkProject() output for the popover to rank
  // against — same shape QuickOpenPalette uses, kept local here so the
  // input bar doesn't depend on the docked file panel's lifecycle.
  const [workspaceFiles, setWorkspaceFiles] = useState<string[] | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [atMentionDismissed, setAtMentionDismissed] = useState(false)
  const [caretPos, setCaretPos] = useState<number>(0)

  // Track 2 / C4 — slash palette state. The palette appears whenever the
  // input begins with '/' AND has no newline (so a code block beginning
  // with '/' does not trip it). The user can dismiss with Esc; we close
  // the palette via `slashPaletteOpen=false` and re-open on the next '/'
  // typed at the start.
  const [slashPaletteOpen, setSlashPaletteOpen] = useState(true)
  const isSlashInput =
    content.startsWith('/') && !content.includes('\n')
  const showSlashPalette =
    isSlashInput && slashPaletteOpen && !isStreaming && !disabled
  // Strip the leading '/' and take everything up to the first whitespace.
  const slashQuery = isSlashInput ? content.slice(1).split(/\s/)[0] : ''

  useEffect(() => {
    // Re-open the palette whenever the user starts a fresh '/' token.
    if (isSlashInput && !slashPaletteOpen) setSlashPaletteOpen(true)
  }, [isSlashInput, slashPaletteOpen])

  const applySlashName = (name: string) => {
    setContent(`/${name} `)
    setSlashPaletteOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // Fluidity J3 — derive the active @-mention token from (content, caret).
  // Recomputed on every render; cheap, and avoids missing a token when the
  // user clicks elsewhere in the textarea.
  const mention = detectAtMention(content, caretPos)
  const showAtMention = mention !== null && !atMentionDismissed && !isStreaming && !disabled

  // Lazy-load the workspace file index the first time the popover opens.
  useEffect(() => {
    if (!showAtMention) return
    if (workspaceFiles !== null || workspaceLoading) return
    if (!window.api?.files) return
    let cancelled = false
    setWorkspaceLoading(true)
    void (async () => {
      try {
        const wd = await window.api.files.getWorkdir()
        if (cancelled || !wd.success || !wd.data) {
          if (!cancelled) setWorkspaceLoading(false)
          return
        }
        const root = wd.data.path
        const w = await window.api.files.walkProject(root)
        if (cancelled) return
        if (w.success) {
          const data = w.data as { files: string[] }
          setWorkspaceFiles(data.files)
          setWorkspaceRoot(root)
        }
      } finally {
        if (!cancelled) setWorkspaceLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showAtMention, workspaceFiles, workspaceLoading])

  const applyAtMention = (relPath: string) => {
    if (!mention) return
    const sep = workspaceRoot && workspaceRoot.includes('\\') ? '\\' : '/'
    const fullPath = workspaceRoot ? `${workspaceRoot}${sep}${relPath}` : relPath
    const basename = relPath.split(/[\\/]/).pop() ?? relPath
    // Replace the @<token> run with a collapsed @<basename> in the textarea.
    const next = `${content.slice(0, mention.start)}@${basename} ${content.slice(mention.end)}`
    setContent(next)
    setAtMentionDismissed(false)
    // Process + attach the picked file via the existing pipeline so the
    // next send carries its content as a ProcessedFile attachment.
    if (window.api?.files?.process) {
      setProcessing(true)
      void window.api.files
        .process([fullPath])
        .then((res) => {
          if (res.success) addAttachments(res.data as ProcessedFile[])
          else if (res.error) toast.error(`Attach failed: ${res.error}`)
        })
        .finally(() => setProcessing(false))
    }
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      const newCaret = mention.start + basename.length + 2 // "@" + name + " "
      ta.focus()
      ta.setSelectionRange(newCaret, newCaret)
      setCaretPos(newCaret)
    })
  }

  // Fluidity J4 — derive memory-write mode from the current content.
  // Pure detector lives in @/lib/memory-shortcut; this is just the wiring.
  const memoryShortcut = detectMemoryShortcut(content)

  const handleSubmit = () => {
    const trimmed = content.trim()
    // NOTE: streaming is allowed through — the parent (ChatView) routes a submit
    // during a live turn into the prompt QUEUE instead of sending immediately.
    if (!trimmed || disabled) return
    if (activeProvider && !activeProviderHasKey) {
      setKeyPromptProvider(activeProvider)
      return
    }
    // Fluidity J4 — `#…` opens MemoryEditor with the description prefilled
    // instead of dispatching as a normal chat turn. The editor is the
    // confirm-before-save step required by the feedback_no_fake_polish
    // invariant: we never write memory silently.
    if (memoryShortcut) {
      seedMemoryDescription(memoryShortcut.description)
      setContent('')
      historyRef.current = emptyHistoryState
      return
    }
    if (trimmed.startsWith('/')) {
      void handleSlashCommand(trimmed).then((handled) => {
        if (handled) {
          setContent('')
          setSlashPaletteOpen(true)
          historyRef.current = emptyHistoryState
        }
      })
      return
    }
    const planMode = useUiStore.getState().planMode
    const final = planMode
      ? `[PLAN MODE — produce a plan first, list assumptions and steps, then await my confirmation before executing.]\n\n${trimmed}`
      : trimmed
    onSend(final)
    setContent('')
    historyRef.current = emptyHistoryState
  }

  // Fluidity J2: Shift+Tab walks default → auto-review → full → plan → default.
  // permissionsMode + the legacy planMode flag both update unconditionally so
  // the existing PermissionsDropdown + plan banner stay in sync; if an active
  // conversation exists, plan transitions also drive the real IPC gate via
  // usePlanMode so persistence (conversations.plan_mode_active) is honored.
  const permissionsMode = useUiStore((s) => s.permissionsMode)
  const planModeLocal = useUiStore((s) => s.planMode)
  const planModeActive = usePlanStore((s) => s.planModeActive ?? false)
  const setPermissionsMode = useUiStore((s) => s.setPermissionsMode)
  const setPlanModeFlag = useUiStore((s) => s.setPlanMode)
  const planControl = usePlanMode()

  // (The "live slot" blend that fed the removed mode caption is gone with it —
  //  it had no other reader. `currentSlot` is still used below to name the mode
  //  in the cycle toast.)

  const cycleMode = () => {
    const next = nextMode({
      permissions: permissionsMode,
      plan: planModeLocal || planModeActive
    })
    setPermissionsMode(next.permissions)
    setPlanModeFlag(next.plan)
    if (next.plan && !(planModeLocal || planModeActive)) {
      void planControl.enter()
    } else if (!next.plan && (planModeLocal || planModeActive)) {
      void planControl.exit()
    }
    toast.info(`Mode: ${slotLabel(currentSlot(next))}`)
  }

  const moveCaretToEnd = () => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      const len = ta.value.length
      ta.setSelectionRange(len, len)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pasteOffer) return
    // IME composition (e.g. typing kana / pinyin) sends interim keystrokes;
    // never intercept while a candidate is being assembled.
    if (e.nativeEvent.isComposing) return

    // Fluidity J1 — ↑ / ↓ walks prompt history when the caret is on line 1
    // and nothing is selected. Otherwise it falls through to native arrow
    // navigation so the user can still move inside a multi-line draft.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ta = e.currentTarget
      const selStart = ta.selectionStart ?? 0
      const selEnd = ta.selectionEnd ?? 0
      const onFirstLine = ta.value.slice(0, selStart).indexOf('\n') === -1
      const hasSelection = selStart !== selEnd
      const browsing = historyRef.current.index !== null
      // While browsing, both arrows are owned by the walker regardless of
      // caret position — the textarea holds a recalled prompt and the user
      // is paging through history, not editing.
      if (browsing || (onFirstLine && !hasSelection)) {
        const history = useChatStore.getState().getRecentUserPrompts()
        if (e.key === 'ArrowUp') {
          if (history.length === 0) return
          e.preventDefault()
          const step = historyUp(history, historyRef.current, content)
          historyRef.current = step.state
          setContent(step.text)
          moveCaretToEnd()
          return
        }
        if (e.key === 'ArrowDown' && browsing) {
          e.preventDefault()
          const step = historyDown(history, historyRef.current)
          historyRef.current = step.state
          setContent(step.text)
          moveCaretToEnd()
          return
        }
      }
    }

    // Esc while browsing restores the saved draft. Streaming-cancel and
    // search-clear are handled globally in useKeyboardShortcuts — we only
    // claim Esc here when we have local history state to unwind.
    if (e.key === 'Escape' && historyRef.current.index !== null) {
      e.preventDefault()
      e.stopPropagation()
      const step = historyReset(historyRef.current)
      historyRef.current = step.state
      setContent(step.text)
      moveCaretToEnd()
      return
    }

    if (e.key === 'Tab' && e.shiftKey) {
      // Only claim Shift+Tab when the textarea has no content — mid-draft
      // we leave it for native focus navigation per the J2 spec.
      if (content.length > 0) return
      e.preventDefault()
      cycleMode()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Composer STEERING keymap. While a turn is streaming, plain Enter STEERS — it injects the
      // draft into the running turn (chat-store.steerActiveTurn → chat:steer beacon), which falls
      // back to a durable new turn if no live run catches it. Ctrl/Cmd+Enter instead QUEUES a new
      // turn (handleSubmit → onSend, which ChatView routes into the durable queue while streaming).
      // When NOT streaming, Enter sends normally and the modifier is a harmless no-op.
      if (isStreaming && !e.ctrlKey && !e.metaKey) {
        const trimmed = content.trim()
        // Slash / memory (#) / empty drafts are NOT steer material — fall through to the normal
        // submit path so a command still runs (queued) instead of being injected as prose.
        if (trimmed && !trimmed.startsWith('/') && !detectMemoryShortcut(content)) {
          void useChatStore
            .getState()
            .steerActiveTurn(trimmed, useSkillsStore.getState().activeSkillIds)
          setContent('')
          historyRef.current = emptyHistoryState
          return
        }
      }
      handleSubmit()
    }
  }

  const handlePickerClick = async () => {
    if (!window.api) return
    setProcessing(true)
    try {
      const result = await window.api.files.openPicker()
      if (result.success) addAttachments(result.data as ProcessedFile[])
      else if (result.error) toast.error(`File picker failed: ${result.error}`)
    } finally {
      setProcessing(false)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const blob = item.getAsFile()
          if (!blob) continue
          e.preventDefault()
          try {
            const dataUrl = await blobToDataURL(blob)
            const ext = (blob.type.split('/')[1] ?? 'png').replace('+xml', '')
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            // Hand off to main rather than building the attachment here: that is
            // where images get OCR'd and type-checked. Building it in the renderer
            // meant a pasted screenshot — the commonest way an image enters a chat
            // — silently skipped both.
            const res = await window.api.files.processPastedImage({
              dataUrl,
              name: `pasted-${stamp}.${ext}`,
              mimeType: blob.type
            })
            if (!res.success || !res.data) {
              toast.error(res.error ?? 'Could not paste image')
              return
            }
            if (res.data.error) {
              toast.error(res.data.error)
              return
            }
            addAttachments([res.data])
          } catch (err) {
            toast.error(`Could not paste image: ${(err as Error).message}`)
          }
          return
        }
      }
    }

    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (looksLikeCode(text)) {
      e.preventDefault()
      setPasteOffer(text)
    }
  }

  const handlePasteOfferAccept = () => {
    if (!pasteOffer) return
    const ext = /<\/?[a-zA-Z][^>]*>/.test(pasteOffer) ? 'html' : 'txt'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const attachment: ProcessedFile = {
      name: `pasted-${stamp}.${ext}`,
      kind: 'text',
      mimeType: 'text/plain',
      size: new Blob([pasteOffer]).size,
      content: pasteOffer,
      previewText: `${pasteOffer.split(/\r?\n/).length} lines · pasted`
    }
    addAttachments([attachment])
    setPasteOffer(null)
  }

  const handlePasteOfferInline = () => {
    if (!pasteOffer) return
    const textarea = textareaRef.current
    if (textarea) {
      const start = textarea.selectionStart ?? content.length
      const end = textarea.selectionEnd ?? content.length
      setContent(content.slice(0, start) + pasteOffer + content.slice(end))
    } else {
      setContent(content + pasteOffer)
    }
    setPasteOffer(null)
  }

  const canSend = content.trim().length > 0 && !disabled && !isStreaming
  const planMode = useUiStore((s) => s.planMode)

  return (
    <div className="w-full">
      {planMode && (
        <div className="mb-2 flex items-center justify-between rounded-md border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-1.5 text-[12px] text-[var(--accent)]">
          <span className="font-mono">PLAN MODE · Shift+Tab to toggle</span>
          <button
            onClick={() => useUiStore.getState().setPlanMode(false)}
            className="rounded px-1 text-[11px] uppercase tracking-wider hover:bg-[var(--bg-tertiary)]"
            title={t('Turn plan mode off')}
          >
            off
          </button>
        </div>
      )}
      {pasteOffer && (
        <div className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-2xl border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 text-[12px] text-[var(--text-primary)]">
          <span className="flex-1">
            That looks like code ({pasteOffer.length.toLocaleString()} chars). Attach it as a file or
            paste inline?
          </span>
          <Button variant="primary"
            onClick={handlePasteOfferAccept}
          >
            {t('Paste as attachment')}
          </Button>
          <Button variant="secondary"
            onClick={handlePasteOfferInline}
          >
            {t('Paste inline')}
          </Button>
          <button
            onClick={() => setPasteOffer(null)}
            className="rounded px-1.5 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            title={t('Dismiss')}
            aria-label={t('Dismiss')}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="relative flex w-full flex-col gap-2 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-4 pt-3 pb-2 shadow-lg backdrop-blur-sm">
        {/* Track 2 / C4 — slash-command palette. Anchored to this
            container's top edge via `bottom-full`, so it floats above
            the input box without affecting layout. */}
        {showSlashPalette && (
          <SlashCommandPalette
            query={slashQuery}
            onApply={applySlashName}
            onClose={() => setSlashPaletteOpen(false)}
          />
        )}
        {/* Fluidity J3 — @file mention popover. Mounted only when the
            caret sits inside an @<token> run that's NOT inside a code
            fence. Slash palette and this one are mutually exclusive in
            practice because a single character can't be both `/` AND
            `@`-prefixed. */}
        {showAtMention && mention && (
          <AtFileMention
            query={mention.token}
            files={workspaceFiles ?? []}
            loading={workspaceLoading}
            onApply={applyAtMention}
            onClose={() => setAtMentionDismissed(true)}
          />
        )}
        <div className="flex items-start gap-2">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setCaretPos(e.target.selectionStart ?? e.target.value.length)
              // Any keystroke that mutates text is "I'm done browsing":
              // drop the history index so the next ↑ starts fresh.
              if (historyRef.current.index !== null) {
                historyRef.current = emptyHistoryState
              }
              // Typing extends/changes the @-token — re-arm the popover
              // even if the user just dismissed it with Esc.
              if (atMentionDismissed) setAtMentionDismissed(false)
            }}
            onClick={(e) => setCaretPos(e.currentTarget.selectionStart ?? 0)}
            onSelect={(e) => setCaretPos(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('Ask anything')}
            rows={1}
            disabled={disabled}
            // Reads at the transcript's size, not a hardcoded 16px. What you type,
            // what streams back, and what is finally stored are one surface; three
            // different sizes on it was the visible bug.
            style={{ paddingLeft: '20px', paddingTop: '8px', fontSize: 'var(--chat-font-size)' }}
            className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />

          {isStreaming ? (
            <button
              // Call onCancel with NO args: the store's cancelStream(conversationId?)
              // takes an optional id, so a bare onClick={onCancel} would hand it the
              // React MouseEvent as `conversationId`. That event object is truthy, so
              // it became the cancel target — window.api.chat.cancel(<event>) — and the
              // main-process chat:cancel filters runs by `r.conversationId === id` with
              // strict ===, which an event object never matches. Result: the Stop button
              // aborted nothing and generation kept running. Drop the event here.
              onClick={() => onCancel()}
              title={t('Stop streaming')}
              aria-label={t('Stop streaming')}
              className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] transition-colors hover:bg-[var(--error)] hover:text-white"
            >
              <StopIcon size={17} className="text-current" />
            </button>
          ) : memoryShortcut ? (
            // Fluidity J4 — in memory-write mode the Send pill becomes a
            // "Remember" pill that opens the editor instead of dispatching.
            <button
              onClick={handleSubmit}
              disabled={!canSend}
              title={t('Open memory editor (Enter)')}
              aria-label={t('Remember')}
              data-mode="memory"
              className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 text-[12px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              {t('Remember')}
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSend}
              title={t('Send (Enter)')}
              aria-label={t('Send')}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)] hover:text-white disabled:opacity-50 disabled:hover:bg-[var(--bg-tertiary)] disabled:hover:text-[var(--text-primary)]"
            >
              <SendIcon size={17} className="text-current" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <AddMenu
            onPickFile={handlePickerClick}
            onOpenSettings={openSettings}
            onInsertSlash={() => {
              setContent((c) => (c.startsWith('/') ? c : `/${c}`))
              textareaRef.current?.focus()
            }}
          />

          <PermissionsDropdown />

          <CodingModeToggle />

          <div className="flex-1" />

          <EffortDropdown />

          <ModelDropdown onRequestKey={(providerId) => setKeyPromptProvider(providerId)} />
          {/* The voice-input button was removed 2026-08-17 (operator call): it was a mic
              icon whose only behaviour was a "coming soon" toast. A control that looks
              live and does nothing costs a click to discover and teaches distrust of the
              other controls beside it. It comes back when it records. */}
        </div>

        <ContextChipRow onAddFile={handlePickerClick} />
      </div>

      {/* The slim mode caption that sat here (`FULL ACCESS · ⇧⇥ TO CYCLE`) is
          gone. It restated the mode already shown on the Permissions pill a few
          pixels above — but as static text, where the pill is interactive — and
          it rendered OUTSIDE the composer card, so it floated on the background
          looking detached from the input it described. Its shortcut hint was
          also unconditional while the binding is not (Shift+Tab is only claimed
          when the composer is empty). The pill now carries both, in one place
          that cannot drift from the state it reports. */}

      {keyPromptProvider && (
        <ApiKeyModal
          defaultProvider={keyPromptProvider}
          required={false}
          onDismiss={() => setKeyPromptProvider(null)}
          onComplete={async () => {
            await refreshProviders()
            setKeyPromptProvider(null)
            toast.success('Key saved: model unlocked')
          }}
        />
      )}
    </div>
  )
}

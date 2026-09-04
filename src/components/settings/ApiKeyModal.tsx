import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SettingsLink } from '@/components/ui/settings'
import type { ProviderInfo } from '@/lib/types'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import { PRODUCT_NAME } from '@/lib/brand'
import { t, tf } from '@/lib/i18n'
import {
  FEATURED_PROVIDERS,
  featuredForProvider,
  ProviderCardGrid
} from '@/components/onboarding/provider-cards'

interface ApiKeyModalProps {
  onComplete: () => void
  onDismiss?: () => void
  defaultProvider?: string
  required?: boolean
}

interface ProviderEntry extends ProviderInfo {
  hasKey: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ApiKeyModal({ onComplete, onDismiss, defaultProvider, required = true }: ApiKeyModalProps) {
  const [providers, setProviders] = useState<ProviderEntry[]>([])
  const [selected, setSelected] = useState<string>(defaultProvider ?? 'openai')
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<React.ReactNode>('')
  // The failed-validation state is distinct from a generic error: the key IS on disk
  // (saved before the test), so every other surface already shows the provider as
  // connected while chat turns would error against it. Offer removal right here.
  const [savedButRejected, setSavedButRejected] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showKeyHelp, setShowKeyHelp] = useState(false)
  // SEC-10: when safeStorage is unavailable the key persists as plaintext.
  // null = still checking; false = MUST confirm before save.
  const [encrypted, setEncrypted] = useState<boolean | null>(null)
  const titleId = useId()
  const inputId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element that opened the modal gets focus back when it closes.
  const openerRef = useRef<HTMLElement | null>(null)

  const dismissible = !required && !!onDismiss

  const loadProviders = useCallback(async () => {
    const list = await window.api.settings.listProviderKeys()
    if (list.success) {
      setProviders(list.data as ProviderEntry[])
    }
    return list
  }, [])

  useEffect(() => {
    void (async () => {
      const [list, enc] = await Promise.all([
        loadProviders(),
        window.api.settings.isEncryptionAvailable()
      ])
      if (list.success) {
        const items = list.data as ProviderEntry[]
        if (defaultProvider && items.some((p) => p.id === defaultProvider)) {
          setSelected(defaultProvider)
        } else if (!defaultProvider) {
          // Auto-pick when the caller didn't scope a provider: prefer OpenAI (GPT) —
          // the most recognized default — over whatever happens to be first in the
          // list. Falls back to the first key-less provider if OpenAI already has a
          // key or isn't listed.
          const openaiMissing = items.find((p) => p.id === 'openai' && !p.hasKey)
          const firstMissing = openaiMissing ?? items.find((p) => !p.hasKey)
          if (firstMissing) setSelected(firstMissing.id)
        }
      }
      // A failed check is "unknown", not a plaintext alarm: the confirm before a save
      // (ensurePlaintextConsentIfNeeded) is what actually protects the write.
      setEncrypted(enc.success ? Boolean(enc.data) : null)
    })()
  }, [defaultProvider, loadProviders])

  // Keep the ✓ badges / "(key stored)" labels live: keys added or removed from any
  // OTHER surface while this modal is open used to leave a mount-time snapshot stale.
  useEffect(() => {
    return window.api?.settings?.onKeychainChanged?.(() => {
      void loadProviders()
    })
  }, [loadProviders])

  // Escape dismisses (when dismissible). The global shortcut resolver stays out of it
  // while a [role=dialog][aria-modal] is open, so Escape no longer also closes Settings.
  useEffect(() => {
    if (!dismissible) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) onDismiss?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismissible, onDismiss])

  // Focus: remember the opener, and hand focus back to it on unmount.
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const opener = openerRef.current
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  // Focus trap: Tab and Shift+Tab cycle inside the dialog.
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    )
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const removeRejectedKey = async () => {
    try {
      await window.api.settings.deleteProviderKey(selected)
      setSavedButRejected(false)
      setError('')
      setKey('')
    } catch {
      setError(
        <>
          {t('Couldn’t remove the key. ')}
          <SettingsLink tab="api">{t('Delete it under API Keys')}</SettingsLink>
        </>
      )
    }
  }

  const handleSubmit = async () => {
    if (!key.trim() || testing) return
    // SEC-10: shared consent gate. Confirms once per session when encryption
    // is unavailable and records consent in the main process so background
    // callers (mcp-manager token refresh, etc.) inherit the decision.
    const ok = await ensurePlaintextConsentIfNeeded()
    if (!ok) return
    setTesting(true)
    setError('')
    setSavedButRejected(false)

    try {
      const save = await window.api.settings.saveProviderKey(selected, key.trim())
      if (!save.success) {
        setError(save.error || t('Couldn’t save the key.'))
        return
      }
      const result = await window.api.settings.testProviderKey(selected)
      const data = result.success
        ? (result.data as { ok: boolean; reason?: string } | boolean | undefined)
        : undefined
      if (typeof data === 'object' && data !== null) {
        if (data.ok) {
          onComplete()
        } else {
          setError(data.reason || t('That service didn’t accept the key. Double-check you copied all of it.'))
          setSavedButRejected(true)
        }
      } else if (typeof data === 'boolean') {
        if (data) onComplete()
        else {
          setError(t('That service didn’t accept the key. Double-check you copied all of it.'))
          setSavedButRejected(true)
        }
      } else {
        setError(result.success ? t('No response — try again in a moment.') : (result.error || t('Something went wrong.')))
      }
    } catch {
      setError(t('Couldn’t connect. Check your internet and try again.'))
    } finally {
      setTesting(false)
    }
  }

  // Featured (plain-language) view of the selected provider, when it maps to one.
  const featured = featuredForProvider(selected)
  const selectedCardId = FEATURED_PROVIDERS.find((p) => p.providerId === selected)?.cardId ?? null
  const advancedProvider = providers.find((p) => p.id === selected)

  const storedProviderIds = useMemo(
    () => new Set(providers.filter((p) => p.hasKey).map((p) => p.id)),
    [providers]
  )

  // The name/link/placeholder to show for whatever is currently selected.
  const displayName = featured?.name ?? advancedProvider?.label ?? selected
  const docsUrl = featured?.docsUrl ?? advancedProvider?.docsUrl ?? ''
  const keyHint = featured?.keyHint ?? (selected === 'openai' || selected === 'deepseek' ? 'sk-…' : t('Paste your key'))
  const scoped = !!defaultProvider
  // Zero-catalog providers (groq/mistral/github-models/deepinfra/openrouter) validate a key
  // fine and then route NOTHING — "connected" with chat still unset-up. Say it BEFORE the
  // paste instead of letting the success state lie.
  const selectedUnroutable = advancedProvider ? advancedProvider.routable === false : false

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onDismiss?.()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="relative max-h-[90vh] w-[480px] overflow-y-auto rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-6"
      >
        {!required && onDismiss && (
          <IconButton className="absolute right-3 top-3"
            onClick={onDismiss}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </IconButton>
        )}
        <h2 id={titleId} className="text-[20px] font-semibold text-[var(--text-primary)]">
          {scoped ? tf('Connect {name}', { name: displayName }) : tf('Connect an AI model to {name}', { name: PRODUCT_NAME })}
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {t('This is optional — DUIN already answers from your notes without it. Connecting a model adds fuller, conversational answers. Pick a service below, get a key from its page, and paste it in. Your key is stored only on this device. When you use an online model, DUIN sends your current question plus relevant excerpts and personalization context to that provider, and — to build your knowledge graph — your notes, in batches.')}
        </p>

        {encrypted === false && (
          <div
            role="alert"
            className="mt-3 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-[12px] leading-relaxed text-[var(--text-secondary)]"
          >
            <strong className="text-[var(--warning)]">{t('Heads up:')}</strong>{' '}
            {t('secure storage isn’t available on this computer, so the key will be saved as plain text in DUIN’s app folder. You’ll be asked to confirm before it’s saved.')}
          </div>
        )}

        {!scoped && (
          <div className="mt-4">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t('Choose a service')}</span>
            <div className="mt-1.5">
              <ProviderCardGrid
                selectedCardId={selectedCardId}
                storedProviderIds={storedProviderIds}
                onSelect={(p) => { setSelected(p.providerId); setError(''); setSavedButRejected(false) }}
              />
            </div>
          </div>
        )}

        {/* Advanced: the full raw provider list (registry ids) — demoted, not on the
            default path. Lets power users pick any provider we route to. */}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-3 px-0 text-[var(--text-muted)]"
        >
          <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`} aria-hidden>▸</span>
          {t('Advanced — all providers')}
        </Button>
        {showAdvanced && (
          <label className="mt-2 block">
            <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{t('Provider')}</span>
            <Select
              value={selected}
              onChange={(e) => { setSelected(e.target.value); setError(''); setSavedButRejected(false) }}
              className="mt-1 w-full"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.hasKey ? ` ${t('(key stored)')}` : ''}
                </option>
              ))}
            </Select>
          </label>
        )}

        {selectedUnroutable && (
          <div className="mt-3 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {tf('{name} has no built-in models yet. Your key will be saved, but chat cannot use it until you import this service’s models.', { name: displayName })}{' '}
            <SettingsLink tab="models">{t('Open Models')}</SettingsLink>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <label htmlFor={inputId} className="text-[12px] font-medium text-[var(--text-secondary)]">
            {tf('Your {name} key', { name: displayName })}
          </label>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showKeyHelp}
            onClick={() => setShowKeyHelp((v) => !v)}
            className="text-[11px] text-[var(--text-muted)]"
          >
            {t('What’s a key?')}
          </Button>
        </div>
        {showKeyHelp && (
          <p className="mt-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {t('A key is a private password the service gives you so DUIN can use your account on your behalf. Creating a key is free — you only pay the provider for what you use. Use the “Get a key” link below — copy the key it shows and paste it here.')}
          </p>
        )}
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits once; while a check is running it is ignored, not queued.
            if (e.key === 'Enter' && !testing) {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder={keyHint}
          className="mt-1.5 px-3 py-2 font-mono text-[14px]"
          autoFocus
        />

        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[12px] font-medium text-[var(--accent)] hover:underline"
          >
            {tf('Get a {name} key →', { name: displayName })}
          </a>
        )}

        {error && <p role="alert" className="mt-2 text-[12px] text-[var(--error)]">{error}</p>}
        {savedButRejected && (
          <div className="mt-1.5 flex items-center gap-2 text-[12px]">
            <span className="text-[var(--text-muted)]">{t('The key was saved anyway.')}</span>
            <Button variant="ghost" size="sm" onClick={() => void removeRejectedKey()} className="px-0 text-[var(--accent)]">
              {t('Remove it')}
            </Button>
          </div>
        )}

        <Button
          onClick={() => void handleSubmit()}
          variant="primary"
          size="lg"
          className="mt-4 w-full"
          disabled={!key.trim() || testing}
        >
          {testing ? t('Checking…') : t('Connect')}
        </Button>

        <p className="mt-3 text-[12px] text-[var(--text-muted)]">
          {encrypted === false
            ? t('Secure storage is not available on this computer, so the key is saved as plain text in DUIN’s app folder. It is sent only to that provider.')
            : t('Stored encrypted on this computer and sent only to that provider.')}
        </p>
      </div>
    </div>
  )
}

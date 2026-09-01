// Plain-language AI-model provider cards (Dim 3 comprehension / Dim 5 upgrade path).
//
// First-run and the ApiKeyModal used to show a raw `<select>` of provider ids
// ("deepseek / openrouter / zhipu…") — jargon for a non-engineer. This surfaces
// the same providers as NAMED, plain-language cards with a one-tap "Get a free
// key →" deep-link.
//
// `providerId` is the registry PROVIDERS id the key is stored under; `docsUrl`
// values mirror electron/services/providers/registry.ts PROVIDERS[*].docsUrl.
//
// The Claude card stores an `anthropic` key: Anthropic is a first-class registry
// provider via its official OpenAI-compat endpoint (catalog redo, 2026-08-21).
// It USED to store an `openrouter` key ("no direct API path" was true then) —
// but the same redo emptied openrouter's catalog to zero pinned models, which
// turned the old card into a silent dead end: the key saved, validated, showed
// ✓ Connected… and no catalog model could ever route to it, so chat stayed
// keyless. The FIRST card a new user saw was the one that couldn't work.

import { t } from '@/lib/i18n'

export interface FeaturedProvider {
  /** Stable card key. */
  cardId: string
  /** Registry provider id the key is saved under (may differ from the card, e.g.
   *  the Claude card stores an `openrouter` key). */
  providerId: string
  /** Plain-language name a non-engineer recognizes. */
  name: string
  /** One-line, jargon-free description. */
  blurb: string
  /** Deep-link to that provider's "create a key" page (from the registry). */
  docsUrl: string
  /** Input placeholder hint for the key field. */
  keyHint: string
  /** Short "free tier" note when the provider has one. */
  freeNote?: string
}

// Featured first — the friendly default set. Order: strongest consumer-recognized
// names first, then the value picks.
export const FEATURED_PROVIDERS: FeaturedProvider[] = [
  {
    cardId: 'claude',
    providerId: 'anthropic',
    name: 'Claude',
    blurb: 'Anthropic’s Claude models',
    docsUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-…',
    freeNote: 'Pay-as-you-go'
  },
  {
    cardId: 'openai',
    providerId: 'openai',
    name: 'OpenAI',
    blurb: 'The models behind ChatGPT',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    freeNote: 'Pay-as-you-go'
  },
  {
    cardId: 'grok',
    providerId: 'xai',
    name: 'Grok',
    blurb: 'xAI’s Grok models',
    docsUrl: 'https://console.x.ai/',
    keyHint: 'xai-…'
  },
  {
    cardId: 'deepseek',
    providerId: 'deepseek',
    name: 'DeepSeek',
    blurb: 'Fast, low-cost, strong reasoning',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
    freeNote: 'Free trial credits'
  },
  {
    cardId: 'google',
    providerId: 'google',
    name: 'Google',
    blurb: 'Gemini / Gemma from Google AI Studio',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AI…',
    freeNote: 'Free tier available'
  },
  {
    cardId: 'zhipu',
    providerId: 'zhipu',
    name: 'Zhipu GLM',
    blurb: 'Zhipu AI’s GLM models',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyHint: 'API key',
    freeNote: 'Free tier available'
  }
]

/** The featured provider whose registry key matches `providerId`, if any. */
export function featuredForProvider(providerId: string): FeaturedProvider | undefined {
  return FEATURED_PROVIDERS.find((p) => p.providerId === providerId)
}

interface ProviderCardGridProps {
  /** Currently selected card id. */
  selectedCardId: string | null
  onSelect: (p: FeaturedProvider) => void
  /** Provider ids that already have a stored key (shows a ✓). */
  storedProviderIds?: Set<string>
}

/** A responsive grid of plain-language provider cards. Selecting one highlights it
 *  and calls `onSelect`; the caller shows the key input + deep-link for it. Names
 *  stay untranslated (GLOSSARY: model/provider names are proper nouns); blurbs go
 *  through t() — the EN blurb string is the dictionary key. */
export function ProviderCardGrid({
  selectedCardId,
  onSelect,
  storedProviderIds
}: ProviderCardGridProps): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {FEATURED_PROVIDERS.map((p) => {
        const active = p.cardId === selectedCardId
        const stored = storedProviderIds?.has(p.providerId)
        return (
          <button
            key={p.cardId}
            type="button"
            onClick={() => onSelect(p)}
            aria-pressed={active}
            className={`flex flex-col items-start rounded-lg border p-2.5 text-left transition-colors ${
              active
                ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                : 'border-[var(--panel-border)] bg-[var(--app-bg)] hover:border-[var(--accent)]'
            }`}
          >
            <span className="flex w-full items-center justify-between gap-1">
              <span className="text-[12px] font-semibold text-[var(--text-primary)]">{p.name}</span>
              {stored && <span className="text-[11px] font-medium text-[var(--accent)]">✓</span>}
            </span>
            <span className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{t(p.blurb)}</span>
          </button>
        )
      })}
    </div>
  )
}

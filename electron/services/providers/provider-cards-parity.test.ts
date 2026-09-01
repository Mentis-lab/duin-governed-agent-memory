// Onboarding provider-cards ↔ registry parity lock.
//
// The featured cards (src/components/onboarding/provider-cards.tsx) are the FIRST
// key-entry surface a new operator sees, and they name a registry provider id by
// string. The renderer cannot import the registry (tsconfig project boundaries:
// web includes `src/**` only, node includes `electron/**` only), so nothing at
// compile time ties a card to a provider that still exists — or still ROUTES.
//
// That gap already shipped a silent dead end: the Claude card stored its key under
// `openrouter`, then the 2026-08-21 catalog redo emptied openrouter's pinned
// catalog to zero. The key saved, validated live against openrouter.ai, showed
// "✓ Connected" — and no catalog model could ever use it, so a brand-new install
// whose operator picked the FIRST card stayed keyless in chat. This suite is the
// regression lock for that class, using the same source-text technique as
// default-app-settings.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODEL_CATALOG, PROVIDERS } from './registry'

const repoRoot = join(__dirname, '..', '..', '..')
const cardsSource = readFileSync(
  join(repoRoot, 'src', 'components', 'onboarding', 'provider-cards.tsx'),
  'utf-8'
)

/** Every `providerId: '<id>'` literal in the featured-cards source. */
function cardProviderIds(): string[] {
  const ids: string[] = []
  const re = /providerId:\s*'([^']+)'/g
  for (let m = re.exec(cardsSource); m; m = re.exec(cardsSource)) ids.push(m[1])
  return ids
}

describe('onboarding provider cards ↔ registry parity', () => {
  const ids = cardProviderIds()

  it('found the featured cards at all (the extractor is not silently matching nothing)', () => {
    expect(ids.length).toBeGreaterThanOrEqual(4)
  })

  it('every card stores its key under a provider the registry actually has', () => {
    for (const id of ids) {
      expect(Object.keys(PROVIDERS), `card providerId '${id}' missing from PROVIDERS`).toContain(id)
    }
  })

  it('every card provider is visible in the key UI (not hidden)', () => {
    for (const id of ids) {
      const desc = PROVIDERS[id as keyof typeof PROVIDERS]
      expect(desc.hidden ?? false, `card providerId '${id}' is hidden from listProviderKeys`).toBe(false)
    }
  })

  it("every card's key can ROUTE: at least one catalog model runs on that provider", () => {
    // The exact dead end this suite exists for. A card whose provider has zero
    // catalog models saves a key that nothing can ever resolve to — the modal
    // reports connected, the tier scan skips the provider, chat stays keyless.
    for (const id of ids) {
      const models = MODEL_CATALOG.filter((m) => m.provider === id)
      expect(
        models.length,
        `card providerId '${id}' has NO catalog models — its key would validate and then route nothing`
      ).toBeGreaterThan(0)
    }
  })

  it("every card's Get-a-key link matches the registry's docsUrl for that provider", () => {
    // The card and the registry each carry a docsUrl; when they drift the card
    // deep-links an operator to the wrong console for the key they're about to
    // paste. Cards may only differ where the registry has no docsUrl at all.
    const re = /providerId:\s*'([^']+)',\s*name:[^]*?docsUrl:\s*'([^']+)'/g
    for (let m = re.exec(cardsSource); m; m = re.exec(cardsSource)) {
      const [, id, cardUrl] = m
      const desc = PROVIDERS[id as keyof typeof PROVIDERS]
      if (desc?.docsUrl) {
        expect(cardUrl, `card '${id}' docsUrl drifted from registry`).toBe(desc.docsUrl)
      }
    }
  })
})

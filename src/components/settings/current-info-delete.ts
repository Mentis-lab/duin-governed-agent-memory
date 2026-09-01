// U13 — "Delete key" deleted the WRONG provider's key and reported success.
//
// The bug was a split brain between two sources of truth in
// CurrentInfoSettings:
//
//   - the delete TARGET came from the unsaved <select> state
//     (`financeProvider` / `weatherProvider`, which change on every keystroke
//     of the dropdown), while
//   - the button's enabled-ness came from the SAVED server state
//     (`status.finance.hasKey`).
//
// ...and `currentInfo:setProvider` persists the provider switch BEFORE it acts
// on `apiKey: null`. So changing the dropdown without saving and clicking
// Delete: (1) silently switched the live provider, (2) deleted the *new*
// provider's empty slot, (3) left the real key on disk, and (4) toasted
// "finance key deleted". With keys stored for both finance providers it
// deleted the OTHER real key.
//
// The weather variant is worse because it breaks a tool rather than just
// lying: current-info-tools' status reports `hasKey: true` for open-meteo
// unconditionally (it needs no key), so with open-meteo saved, flipping the
// dropdown to OpenWeatherMap rendered Delete ENABLED — and one click switched
// the live provider to a keyless OpenWeatherMap, breaking weather_lookup.
//
// The rule this module encodes: a destructive key action is only ever aimed at
// the SAVED provider, and is only offered when the dropdown agrees with it.

export type KeyedKind = 'finance' | 'weather'

export interface ProviderStatusLike {
  finance: { provider: string; hasKey: boolean }
  weather: { provider: string; hasKey: boolean; keyRequired: boolean }
}

/**
 * The provider a delete must be aimed at: the one that is actually saved.
 * Never the dropdown draft. `null` when status has not loaded yet, in which
 * case no delete may be issued at all.
 */
export function deleteTargetProvider(
  kind: KeyedKind,
  status: ProviderStatusLike | null | undefined
): string | null {
  if (!status) return null
  const provider = kind === 'finance' ? status.finance.provider : status.weather.provider
  return typeof provider === 'string' && provider ? provider : null
}

/**
 * Why Delete is unavailable, or `null` when it is safe to offer. Returned as
 * prose so the UI can explain itself instead of showing a dead button.
 */
export function deleteDisabledReason(
  kind: KeyedKind,
  status: ProviderStatusLike | null | undefined,
  draftProvider: string
): string | null {
  if (!status) return 'Provider status has not loaded yet.'
  const saved = kind === 'finance' ? status.finance : status.weather

  // open-meteo reports hasKey:true because it needs no key. Deleting "its" key
  // is meaningless, and offering it is what let one click swap the live
  // provider out from under weather_lookup.
  if (kind === 'weather' && status.weather.keyRequired !== true) {
    return `${status.weather.provider} does not use an API key.`
  }

  if (!saved.hasKey) return `No ${kind} key is stored for ${saved.provider}.`

  if (draftProvider !== saved.provider) {
    return `Save the provider change first — Delete always acts on the saved provider (${saved.provider}).`
  }

  return null
}

export function canDeleteKey(
  kind: KeyedKind,
  status: ProviderStatusLike | null | undefined,
  draftProvider: string
): boolean {
  return deleteDisabledReason(kind, status, draftProvider) === null
}

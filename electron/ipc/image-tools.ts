import { ipcMain } from 'electron'
import { deleteKey, getKey, hasKey, setKey } from '../services/keychain'
import { patchSettings } from '../services/settings-helper'
import {
  DEFAULT_IMAGE_SETTINGS,
  getImageGenProvider,
  getImageGenSettings,
  isImageGenProviderId,
  keychainProviderKey,
  PROVIDER_CANARY_MODEL,
  type ImageGenProviderId
} from '../services/image-gen-providers'
import { friendly, messageOf } from '../services/guarded'

// IPC surface for image-generation provider configuration.
//
//   imageGen:setProvider(provider, opts?) — write settings, persist key
//   imageGen:getProvider()                — return {provider, model, hasKey}
//   imageGen:test()                       — small canary generation
//
// All handlers return the standard `{ success, data | error }` envelope used
// elsewhere in the app. Keys never leave the main process — `getProvider`
// returns only the boolean `hasKey`, never the key itself.

// Single source of truth is image-gen-providers' id list, so a provider added
// there cannot be silently rejected here — the previous local copy of the list
// was a second place to forget.
const isValidProvider = isImageGenProviderId

interface SetProviderOpts {
  apiKey?: string
  model?: string
  size?: string
}

export function registerImageToolsHandlers(): void {
  ipcMain.handle(
    'imageGen:setProvider',
    async (_event, provider: unknown, opts: SetProviderOpts = {}) => {
      try {
        if (!isValidProvider(provider)) {
          return {
            success: false,
            error: `Unknown image gen provider: ${String(provider)}`
          }
        }

        const patch: Record<string, unknown> = {
          imageGen: {
            provider,
            model:
              typeof opts.model === 'string' && opts.model.length > 0
                ? opts.model
                : DEFAULT_IMAGE_SETTINGS.model,
            size:
              typeof opts.size === 'string' && opts.size.length > 0
                ? opts.size
                : DEFAULT_IMAGE_SETTINGS.size
          }
        }
        patchSettings(patch)

        if (typeof opts.apiKey === 'string') {
          const trimmed = opts.apiKey.trim()
          if (trimmed.length === 0) {
            deleteKey(keychainProviderKey(provider))
          } else {
            setKey(keychainProviderKey(provider), trimmed)
          }
        }

        return { success: true, data: getProviderSnapshot() }
      } catch (err) {
        return {
          success: false,
          error: friendly(err, 'imageGen:setProvider failed')
        }
      }
    }
  )

  ipcMain.handle('imageGen:getProvider', async () => {
    try {
      return { success: true, data: getProviderSnapshot() }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'imageGen:getProvider failed')
      }
    }
  })

  ipcMain.handle('imageGen:test', async () => {
    const settings = getImageGenSettings()
    const provider = getImageGenProvider()
    if (!provider.isConfigured()) {
      return {
        success: true,
        data: {
          ok: false,
          error:
            'No image generation provider configured. Save an API key first.'
        }
      }
    }
    try {
      // Burn the cheapest model the configured provider offers, not the one
      // the operator picked — a canary should not cost a full gpt-image-2
      // render. Providers with no entry (Stability) get undefined and throw
      // their own not-implemented error, which is surfaced below.
      const canaryModel = PROVIDER_CANARY_MODEL[settings.provider]
      const images = await provider.generate({
        prompt: 'test',
        size: '1024x1024',
        ...(canaryModel ? { model: canaryModel } : {})
      })
      if (images.length === 0) {
        return { success: true, data: { ok: false, error: 'No image returned.' } }
      }
      return {
        success: true,
        data: {
          ok: true,
          sample: {
            mimeType: images[0].mimeType,
            byteLength: images[0].bytes.length
          }
        }
      }
    } catch (err) {
      return {
        success: true,
        data: { ok: false, error: friendly(err, 'image generation failed') }
      }
    }
  })
}

function getProviderSnapshot(): {
  provider: ImageGenProviderId
  model: string
  size: string
  hasKey: boolean
} {
  const settings = getImageGenSettings()
  // Match the getKey contract: read the stored bytes to confirm decryption
  // works; otherwise a stored-but-undecryptable key would still report
  // hasKey=true and the user would never see why test() fails.
  let hasKeyStored = hasKey(keychainProviderKey(settings.provider))
  if (hasKeyStored) {
    const decoded = getKey(keychainProviderKey(settings.provider))
    if (!decoded) hasKeyStored = false
  }
  return {
    provider: settings.provider,
    model: settings.model ?? DEFAULT_IMAGE_SETTINGS.model ?? '',
    size: settings.size ?? DEFAULT_IMAGE_SETTINGS.size ?? '',
    hasKey: hasKeyStored
  }
}

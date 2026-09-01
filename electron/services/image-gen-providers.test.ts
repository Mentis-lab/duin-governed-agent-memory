import { describe, it, expect } from 'vitest'

import {
  IMAGE_GEN_PROVIDER_IDS,
  PROVIDER_CANARY_MODEL,
  PROVIDER_MODELS,
  defaultModelFor,
  isImageGenProviderId,
  minimaxDimensions,
  parseArkImageResponse,
  parseMiniMaxImageResponse,
  resolveModel,
  seedreamSize,
  sniffImageMime,
  DEFAULT_IMAGE_SETTINGS
} from './image-gen-providers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x22])

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('provider ids', () => {
  it('accepts every declared id and rejects anything else', () => {
    for (const id of IMAGE_GEN_PROVIDER_IDS) expect(isImageGenProviderId(id)).toBe(true)
    expect(isImageGenProviderId('seedance')).toBe(false)
    expect(isImageGenProviderId('')).toBe(false)
    expect(isImageGenProviderId(undefined)).toBe(false)
    expect(isImageGenProviderId(1)).toBe(false)
  })

  it('gives every provider at least one model, and a canary that it lists', () => {
    for (const id of IMAGE_GEN_PROVIDER_IDS) {
      expect(PROVIDER_MODELS[id].length).toBeGreaterThan(0)
      const canary = PROVIDER_CANARY_MODEL[id]
      // A canary the provider does not accept would be resolved away and the
      // Test button would quietly bill the operator's real model instead.
      if (canary) expect(PROVIDER_MODELS[id]).toContain(canary)
    }
  })
})

describe('resolveModel', () => {
  it('keeps a model the provider recognises', () => {
    expect(resolveModel('openai', 'gpt-image-1')).toBe('gpt-image-1')
    expect(resolveModel('openai', 'dall-e-2')).toBe('dall-e-2')
    expect(resolveModel('minimax', 'image-01')).toBe('image-01')
  })

  it('drops the previous provider model when the provider changes', () => {
    // The regression this guards: settings hold ONE model string, so switching
    // to MiniMax with 'gpt-image-2' still saved would POST that name to
    // MiniMax and fail remotely, looking like a bad key.
    expect(resolveModel('minimax', 'gpt-image-2')).toBe('image-01')
    expect(resolveModel('openai', 'image-01')).toBe('gpt-image-2')
  })

  it('falls back to the provider default for empty or unknown input', () => {
    expect(resolveModel('openai', undefined)).toBe(defaultModelFor('openai'))
    expect(resolveModel('openai', '')).toBe('gpt-image-2')
    expect(resolveModel('minimax', 'nope')).toBe('image-01')
  })

  it('ships gpt-image-2 as the out-of-the-box default', () => {
    expect(DEFAULT_IMAGE_SETTINGS.model).toBe('gpt-image-2')
    expect(resolveModel('openai', DEFAULT_IMAGE_SETTINGS.model)).toBe('gpt-image-2')
  })
})

describe('minimaxDimensions', () => {
  it('translates the canvas sizes the settings panel offers', () => {
    expect(minimaxDimensions('1024x1024')).toEqual({ width: 1024, height: 1024 })
    expect(minimaxDimensions('1024x1536')).toEqual({ width: 1024, height: 1536 })
    expect(minimaxDimensions('1536x1024')).toEqual({ width: 1536, height: 1024 })
  })

  it('omits dimensions for auto and for missing input', () => {
    // MiniMax has no 'auto'; sending it as a literal would be rejected.
    expect(minimaxDimensions('auto')).toBeNull()
    expect(minimaxDimensions(undefined)).toBeNull()
  })

  it('rejects sizes MiniMax cannot render, naming the constraint', () => {
    expect(() => minimaxDimensions('256x256')).toThrow(/512-2048/)
    expect(() => minimaxDimensions('4096x4096')).toThrow(/512-2048/)
    expect(() => minimaxDimensions('1020x1024')).toThrow(/divisible by 8/)
  })

  it('treats an unparseable size as no constraint rather than throwing', () => {
    expect(minimaxDimensions('square')).toBeNull()
  })
})

describe('parseMiniMaxImageResponse', () => {
  it('decodes base64 images and labels them by their real type', async () => {
    const out = await parseMiniMaxImageResponse(
      jsonResponse({
        id: 'trace-1',
        data: { image_base64: [JPEG.toString('base64')] },
        base_resp: { status_code: 0, status_msg: 'success' }
      }),
      'sk-secret'
    )
    expect(out).toHaveLength(1)
    expect(out[0].bytes.equals(JPEG)).toBe(true)
    // MiniMax returns JPEG; assuming PNG here would write a mislabelled file.
    expect(out[0].mimeType).toBe('image/jpeg')
  })

  it('throws on an application error delivered inside HTTP 200', async () => {
    // The trap: MiniMax answers 200 and puts the real verdict in base_resp.
    // Without this check a quota or moderation refusal surfaced as the far more
    // confusing "returned no image data".
    await expect(
      parseMiniMaxImageResponse(
        jsonResponse({
          base_resp: { status_code: 1008, status_msg: 'insufficient balance' }
        }),
        'sk-secret'
      )
    ).rejects.toThrow(/1008: insufficient balance/)
  })

  it('accepts status_code 0 and an absent base_resp alike', async () => {
    const withZero = await parseMiniMaxImageResponse(
      jsonResponse({ data: { image_base64: [PNG.toString('base64')] }, base_resp: { status_code: 0 } }),
      'k'
    )
    expect(withZero[0].mimeType).toBe('image/png')
    const withNone = await parseMiniMaxImageResponse(
      jsonResponse({ data: { image_base64: [PNG.toString('base64')] } }),
      'k'
    )
    expect(withNone[0].mimeType).toBe('image/png')
  })

  it('reports a non-2xx status with the body attached', async () => {
    await expect(
      parseMiniMaxImageResponse(
        new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
        'k'
      )
    ).rejects.toThrow(/429 Too Many Requests: rate limited/)
  })

  it('never echoes the api key back in an error', async () => {
    const key = 'sk-live-do-not-leak'
    await expect(
      parseMiniMaxImageResponse(
        jsonResponse({ base_resp: { status_code: 1004, status_msg: `bad token ${key}` } }),
        key
      )
    ).rejects.toThrow(/\[redacted\]/)
  })

  it('rejects a body that is not JSON', async () => {
    await expect(
      parseMiniMaxImageResponse(new Response('<html>gateway</html>', { status: 200 }), 'k')
    ).rejects.toThrow(/non-JSON body/)
  })

  it('rejects a success-shaped body carrying no images', async () => {
    await expect(
      parseMiniMaxImageResponse(jsonResponse({ data: {}, base_resp: { status_code: 0 } }), 'k')
    ).rejects.toThrow(/no image data/)
  })
})

describe('seedream', () => {
  it('passes DUIN canvas sizes through and omits auto', () => {
    // Ark takes 1K..4K, aspect presets, or an explicit WxH — the panel's sizes
    // are already the third form, so they need no translation.
    expect(seedreamSize('1024x1024')).toBe('1024x1024')
    expect(seedreamSize('1536x1024')).toBe('1536x1024')
    expect(seedreamSize('auto')).toBeNull()
    expect(seedreamSize(undefined)).toBeNull()
  })

  it('lists dated model ids, because Ark has no floating alias', () => {
    for (const m of PROVIDER_MODELS.seedream) expect(m).toMatch(/^doubao-seedream-\d/)
    expect(defaultModelFor('seedream')).toBe('doubao-seedream-5-0-260128')
  })

  it('decodes b64_json entries', async () => {
    const out = await parseArkImageResponse(
      jsonResponse({ data: [{ url: undefined, b64_json: PNG.toString('base64') }] }),
      'k'
    )
    expect(out).toHaveLength(1)
    expect(out[0].mimeType).toBe('image/png')
    expect(out[0].bytes.equals(PNG)).toBe(true)
  })

  it('prefers Ark structured error over the bare status line', async () => {
    // "InvalidParameter: size not supported" tells you what to change;
    // "400 Bad Request" does not.
    await expect(
      parseArkImageResponse(
        jsonResponse(
          { error: { code: 'InvalidParameter', message: 'size not supported' } },
          { status: 400, statusText: 'Bad Request' }
        ),
        'k'
      )
    ).rejects.toThrow(/InvalidParameter: size not supported/)
  })

  it('catches an error object returned under HTTP 200', async () => {
    await expect(
      parseArkImageResponse(jsonResponse({ error: { code: 'QuotaExceeded', message: 'no quota' } }), 'k')
    ).rejects.toThrow(/QuotaExceeded: no quota/)
  })

  it('never echoes the api key back in an error', async () => {
    const key = 'ark-live-secret'
    await expect(
      parseArkImageResponse(jsonResponse({ error: { code: 'AuthFail', message: `key ${key} bad` } }), key)
    ).rejects.toThrow(/\[redacted\]/)
  })

  it('rejects empty data and non-JSON bodies', async () => {
    await expect(parseArkImageResponse(jsonResponse({ data: [] }), 'k')).rejects.toThrow(
      /no image data/
    )
    await expect(
      parseArkImageResponse(new Response('<html>502</html>', { status: 200 }), 'k')
    ).rejects.toThrow(/non-JSON body/)
  })

  it('rejects a data entry carrying neither b64_json nor url', async () => {
    await expect(
      parseArkImageResponse(jsonResponse({ data: [{ b64_json: null }] }), 'k')
    ).rejects.toThrow(/without b64_json or url/)
  })
})

describe('sniffImageMime', () => {
  it('identifies png, jpeg and webp by magic number', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe(
      'image/png'
    )
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg')
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP', 'latin1')
    ])
    expect(sniffImageMime(webp)).toBe('image/webp')
  })

  it('does not claim png for unknown or truncated bytes', () => {
    // The reason this matters: image-tools derives the saved file extension
    // from this label, so a wrong guess writes a .png that is not one.
    expect(sniffImageMime(Buffer.from([0x00, 0x01]))).toBe('application/octet-stream')
    expect(sniffImageMime(Buffer.alloc(0))).toBe('application/octet-stream')
  })
})

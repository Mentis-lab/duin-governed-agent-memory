import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import { getKey } from './keychain'
import { readSettings } from './settings-helper'

// Pluggable image generation provider abstraction so the executor in
// image-tools.ts does not bake in OpenAI specifics. OpenAI and MiniMax are
// real; Stability is a stub returning "not implemented".
//
// Provider selection comes from settings.json (`imageGen.provider` / `.model`
// / `.size`). API keys live in the keychain under `image_gen:<provider>` -
// kept namespaced so chat provider keys (`openai`, `deepseek`, ...) and the
// image-gen credentials don't collide. The handler may bring its own key per
// request (used by `imageGen:test`).

export type ImageGenProviderId = 'openai' | 'minimax' | 'seedream' | 'stability'

export const IMAGE_GEN_PROVIDER_IDS: readonly ImageGenProviderId[] = [
  'openai',
  'minimax',
  'seedream',
  'stability'
]

export function isImageGenProviderId(v: unknown): v is ImageGenProviderId {
  return typeof v === 'string' && (IMAGE_GEN_PROVIDER_IDS as readonly string[]).includes(v)
}

/** Models each provider will accept, first entry being that provider's default.
 *
 *  This exists to stop a provider switch from carrying the previous provider's
 *  model across: settings hold ONE `model` string for whatever provider is
 *  selected, so switching openai -> minimax while `model` still said
 *  'gpt-image-2' would post that name to MiniMax and fail on the wire with a
 *  remote error that reads like a credential problem. `resolveModel` below
 *  drops any model the chosen provider doesn't recognise. */
export const PROVIDER_MODELS: Record<ImageGenProviderId, readonly string[]> = {
  // gpt-image-2 (2026-04-21) is current and supersedes gpt-image-1 for both
  // generate and edit. dall-e-2 stays because it is the ONLY model OpenAI's
  // /images/variations endpoint accepts.
  openai: ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'dall-e-2'],
  minimax: ['image-01'],
  // ByteDance Seedream on Volcengine Ark. The dated suffix IS the model id -
  // Ark has no floating alias, so a new Seedream release means a new entry here.
  seedream: [
    'doubao-seedream-5-0-260128',
    'doubao-seedream-4-5-251128',
    'doubao-seedream-4-0-250828'
  ],
  stability: ['stable-diffusion-xl']
}

/** The cheapest model to burn on the Settings "Test" canary, per provider. */
export const PROVIDER_CANARY_MODEL: Partial<Record<ImageGenProviderId, string>> = {
  openai: 'dall-e-2',
  minimax: 'image-01',
  seedream: 'doubao-seedream-4-0-250828'
}

export function defaultModelFor(provider: ImageGenProviderId): string {
  return PROVIDER_MODELS[provider][0]
}

/** A model the provider recognises, or that provider's default. */
export function resolveModel(
  provider: ImageGenProviderId,
  model: string | undefined
): string {
  if (model && PROVIDER_MODELS[provider].includes(model)) return model
  return defaultModelFor(provider)
}

export interface ImageGenSettings {
  provider: ImageGenProviderId
  model?: string
  size?: string
}

export const DEFAULT_IMAGE_SETTINGS: ImageGenSettings = {
  provider: 'openai',
  model: 'gpt-image-2',
  size: '1024x1024'
}

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto'])
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto'])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024 // 25 MB per OpenAI's docs
const NETWORK_TIMEOUT_MS = 60_000

export interface GenerateArgs {
  prompt: string
  size?: string
  quality?: string
  model?: string
}

export interface EditArgs {
  prompt: string
  imagePath: string
  maskPath?: string
  size?: string
  model?: string
}

export interface VariationArgs {
  imagePath: string
  size?: string
  n?: number
  model?: string
}

export interface ImageBytes {
  bytes: Buffer
  mimeType: string
}

export interface ImageGenProvider {
  readonly id: ImageGenProviderId
  /** Whether the provider has the credentials it needs. */
  isConfigured(): boolean
  generate(args: GenerateArgs): Promise<ImageBytes[]>
  edit(args: EditArgs): Promise<ImageBytes[]>
  variation(args: VariationArgs): Promise<ImageBytes[]>
}

// ─────────────────────────── helpers ───────────────────────────

/** Identify decoded image bytes by magic number.
 *
 *  OpenAI documents PNG for `b64_json`, so that path can assert it. MiniMax
 *  documents no content type at all and returns JPEG in practice, so guessing
 *  PNG there would mislabel every image it produces — and the label is what
 *  image-tools writes the file extension from. */
export function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

function extensionToMime(path: string): string | null {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

function readImageFile(path: string): { buf: Buffer; mime: string } {
  let st
  try {
    st = statSync(path)
  } catch {
    throw new Error(`image file not found: ${path}`)
  }
  if (!st.isFile()) throw new Error(`not a file: ${path}`)
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`image file too large (${st.size} bytes, max ${MAX_IMAGE_BYTES})`)
  }
  const mime = extensionToMime(path)
  if (!mime) {
    throw new Error(`unsupported image extension for ${path} (allowed: .png, .jpg, .jpeg, .webp)`)
  }
  const buf = readFileSync(path)
  return { buf, mime }
}

function normalizeSize(size: string | undefined, fallback: string): string {
  if (!size) return fallback
  if (!ALLOWED_SIZES.has(size)) {
    throw new Error(
      `invalid size "${size}" (allowed: ${[...ALLOWED_SIZES].join(', ')})`
    )
  }
  return size
}

function normalizeQuality(quality: string | undefined): string | undefined {
  if (quality === undefined) return undefined
  if (!ALLOWED_QUALITIES.has(quality)) {
    throw new Error(
      `invalid quality "${quality}" (allowed: ${[...ALLOWED_QUALITIES].join(', ')})`
    )
  }
  return quality
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function sanitizeError(err: unknown, key: string): string {
  // Never leak the API key in error output, even by accident.
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error')
  if (key && raw.includes(key)) return raw.replace(key, '[redacted]')
  return raw
}

// ─────────────────────────── OpenAI provider ───────────────────────────

class OpenAIImageGenProvider implements ImageGenProvider {
  readonly id: ImageGenProviderId = 'openai'

  constructor(
    private apiKey: string | null,
    private model: string = defaultModelFor('openai'),
    /** The operator's persisted Settings → Image Generation canvas size.
     *
     *  getImageGenProvider read settings.model and passed it, but read settings.size
     *  and dropped it — so every call fell back to the hardcoded '1024x1024' literal
     *  below and the setting did nothing unless a caller happened to pass a size. */
    private defaultSize: string = '1024x1024'
  ) {}

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  private requireKey(): string {
    if (!this.isConfigured() || !this.apiKey) {
      throw new Error(
        'No image generation provider configured. Configure in Settings → Image Generation.'
      )
    }
    return this.apiKey
  }

  async generate(args: GenerateArgs): Promise<ImageBytes[]> {
    const key = this.requireKey()
    const size = normalizeSize(args.size, this.defaultSize)
    const quality = normalizeQuality(args.quality)
    const model = args.model || this.model || defaultModelFor('openai')

    const body: Record<string, unknown> = { model, prompt: args.prompt, size, n: 1 }
    if (quality) body.quality = quality

    let resp: Response
    try {
      resp = await fetchWithTimeout('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new Error(`OpenAI image generation request failed: ${sanitizeError(err, key)}`, {
        cause: err
      })
    }

    return parseOpenAIImageResponse(resp, key)
  }

  async edit(args: EditArgs): Promise<ImageBytes[]> {
    const key = this.requireKey()
    const size = normalizeSize(args.size, this.defaultSize)
    const model = args.model || this.model || defaultModelFor('openai')

    const image = readImageFile(args.imagePath)
    let mask: { buf: Buffer; mime: string } | null = null
    if (args.maskPath) mask = readImageFile(args.maskPath)

    const form = new FormData()
    form.append('model', model)
    form.append('prompt', args.prompt)
    form.append('size', size)
    form.append('n', '1')
    form.append(
      'image',
      new Blob([image.buf as unknown as ArrayBuffer], { type: image.mime }),
      basename(args.imagePath)
    )
    if (mask) {
      form.append(
        'mask',
        new Blob([mask.buf as unknown as ArrayBuffer], { type: mask.mime }),
        basename(args.maskPath!)
      )
    }

    let resp: Response
    try {
      resp = await fetchWithTimeout('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form
      })
    } catch (err) {
      throw new Error(`OpenAI image edit request failed: ${sanitizeError(err, key)}`, {
        cause: err
      })
    }
    return parseOpenAIImageResponse(resp, key)
  }

  async variation(args: VariationArgs): Promise<ImageBytes[]> {
    const key = this.requireKey()
    const size = normalizeSize(args.size, this.defaultSize)
    // OpenAI's variations endpoint only supports dall-e-2. Force it here so
    // callers can leave args.model undefined.
    const model = args.model || 'dall-e-2'
    const n = Math.max(1, Math.min(4, args.n ?? 1))

    const image = readImageFile(args.imagePath)
    const form = new FormData()
    form.append('model', model)
    form.append('size', size)
    form.append('n', String(n))
    form.append(
      'image',
      new Blob([image.buf as unknown as ArrayBuffer], { type: image.mime }),
      basename(args.imagePath)
    )

    let resp: Response
    try {
      resp = await fetchWithTimeout('https://api.openai.com/v1/images/variations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form
      })
    } catch (err) {
      throw new Error(`OpenAI image variation request failed: ${sanitizeError(err, key)}`, {
        cause: err
      })
    }
    return parseOpenAIImageResponse(resp, key)
  }
}

function basename(p: string): string {
  // Tiny local helper so we don't add a path import just for this. Strip
  // trailing separators, then take the last segment. Works for forward and
  // back slashes.
  const cleaned = p.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx === -1 ? cleaned : cleaned.slice(idx + 1)
}

async function parseOpenAIImageResponse(
  resp: Response,
  key: string
): Promise<ImageBytes[]> {
  if (!resp.ok) {
    let detail = ''
    try {
      const text = await resp.text()
      detail = text.slice(0, 500)
    } catch {
      // ignore
    }
    throw new Error(
      `OpenAI image API ${resp.status} ${resp.statusText}: ${sanitizeError(detail, key)}`
    )
  }

  let payload: { data?: Array<{ b64_json?: string; url?: string }> }
  try {
    payload = (await resp.json()) as typeof payload
  } catch (err) {
    throw new Error(`OpenAI image API returned non-JSON body: ${sanitizeError(err, key)}`, {
      cause: err
    })
  }
  const data = payload.data ?? []
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('OpenAI image API returned no image data')
  }

  const out: ImageBytes[] = []
  for (const entry of data) {
    if (entry.b64_json) {
      out.push({ bytes: Buffer.from(entry.b64_json, 'base64'), mimeType: 'image/png' })
    } else if (entry.url) {
      // dall-e-2 variations may return a URL. Fetch the bytes inline so the
      // caller doesn't have to know about the two-shape response.
      let imgResp: Response
      try {
        imgResp = await fetchWithTimeout(entry.url, { method: 'GET' })
      } catch (err) {
        throw new Error(`failed to fetch generated image url: ${sanitizeError(err, key)}`, {
          cause: err
        })
      }
      if (!imgResp.ok) {
        throw new Error(
          `image url fetch failed: ${imgResp.status} ${imgResp.statusText}`
        )
      }
      const arr = await imgResp.arrayBuffer()
      const mime = imgResp.headers.get('content-type') ?? 'image/png'
      out.push({ bytes: Buffer.from(arr), mimeType: mime })
    } else {
      throw new Error('OpenAI image API returned a data entry without b64_json or url')
    }
  }
  return out
}

// ─────────────────────────── MiniMax provider ───────────────────────────

const MINIMAX_ENDPOINT = 'https://api.minimax.io/v1/image_generation'

/** MiniMax takes width+height (512-2048, divisible by 8) or an aspect_ratio
 *  preset, not OpenAI's "WxH" enum. Translate, and be explicit about `auto`:
 *  there is no auto on this API, so omit both and let MiniMax pick. */
export function minimaxDimensions(
  size: string | undefined
): { width: number; height: number } | null {
  if (!size || size === 'auto') return null
  const m = /^(\d+)x(\d+)$/.exec(size)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  const ok = (n: number) => n >= 512 && n <= 2048 && n % 8 === 0
  if (!ok(width) || !ok(height)) {
    throw new Error(
      `MiniMax cannot render ${size}: width and height must each be 512-2048 and divisible by 8.`
    )
  }
  return { width, height }
}

interface MiniMaxResponse {
  id?: string
  data?: { image_base64?: string[]; image_urls?: string[] }
  base_resp?: { status_code?: number; status_msg?: string }
}

class MiniMaxImageGenProvider implements ImageGenProvider {
  readonly id: ImageGenProviderId = 'minimax'

  constructor(
    private apiKey: string | null,
    private model: string = 'image-01',
    private defaultSize: string = '1024x1024'
  ) {}

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  private requireKey(): string {
    if (!this.isConfigured() || !this.apiKey) {
      throw new Error(
        'No image generation provider configured. Configure in Settings → Image Generation.'
      )
    }
    return this.apiKey
  }

  async generate(args: GenerateArgs): Promise<ImageBytes[]> {
    const key = this.requireKey()
    const dims = minimaxDimensions(args.size ?? this.defaultSize)
    const body: Record<string, unknown> = {
      model: resolveModel('minimax', args.model || this.model),
      prompt: args.prompt,
      response_format: 'base64',
      n: 1
    }
    if (dims) {
      body.width = dims.width
      body.height = dims.height
    }

    let resp: Response
    try {
      resp = await fetchWithTimeout(MINIMAX_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new Error(`MiniMax image generation request failed: ${sanitizeError(err, key)}`, {
        cause: err
      })
    }
    return parseMiniMaxImageResponse(resp, key)
  }

  // MiniMax's only image-conditioned mode is `subject_reference`, which carries
  // a person's likeness into a NEW scene. It is not a masked edit and not a
  // re-roll of the same image, so mapping either of these onto it would return
  // something the caller did not ask for. Say so instead.
  async edit(): Promise<ImageBytes[]> {
    throw new Error(
      'MiniMax has no masked-edit endpoint. Switch Settings → Image Generation to OpenAI for image_edit.'
    )
  }

  async variation(): Promise<ImageBytes[]> {
    throw new Error(
      'MiniMax has no variations endpoint. Switch Settings → Image Generation to OpenAI for image_variation.'
    )
  }
}

export async function parseMiniMaxImageResponse(
  resp: Response,
  key: string
): Promise<ImageBytes[]> {
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    throw new Error(
      `MiniMax image API ${resp.status} ${resp.statusText}: ${sanitizeError(text.slice(0, 500), key)}`
    )
  }

  let payload: MiniMaxResponse
  try {
    payload = JSON.parse(text) as MiniMaxResponse
  } catch (err) {
    throw new Error(`MiniMax image API returned non-JSON body: ${sanitizeError(err, key)}`, {
      cause: err
    })
  }

  // MiniMax reports application errors inside a 200 response. Skipping this
  // check turns a quota or moderation refusal into "returned no image data",
  // which sends the operator looking at the wrong thing.
  const status = payload.base_resp?.status_code
  if (typeof status === 'number' && status !== 0) {
    const msg = payload.base_resp?.status_msg || 'no message'
    throw new Error(`MiniMax image API error ${status}: ${sanitizeError(msg, key)}`)
  }

  const b64 = payload.data?.image_base64 ?? []
  if (b64.length > 0) {
    return b64.map((s) => {
      const bytes = Buffer.from(s, 'base64')
      return { bytes, mimeType: sniffImageMime(bytes) }
    })
  }

  const urls = payload.data?.image_urls ?? []
  if (urls.length > 0) {
    const out: ImageBytes[] = []
    for (const url of urls) {
      let imgResp: Response
      try {
        imgResp = await fetchWithTimeout(url, { method: 'GET' })
      } catch (err) {
        throw new Error(`failed to fetch generated image url: ${sanitizeError(err, key)}`, {
          cause: err
        })
      }
      if (!imgResp.ok) {
        throw new Error(`image url fetch failed: ${imgResp.status} ${imgResp.statusText}`)
      }
      const bytes = Buffer.from(await imgResp.arrayBuffer())
      out.push({ bytes, mimeType: imgResp.headers.get('content-type') ?? sniffImageMime(bytes) })
    }
    return out
  }

  throw new Error('MiniMax image API returned no image data')
}

// ─────────────────────────── Seedream (Volcengine Ark) ───────────────────────────

// Ark's China region. Operators outside China use BytePlus ModelArk instead
// (https://ark.ap-southeast.bytepluses.com/api/v3), which speaks the same
// protocol — if that ever needs to be selectable, it belongs in settings, not
// as a guess made here.
const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'

/** Ark accepts `1K`..`4K`, aspect presets like `16:9`, or an explicit WxH.
 *  DUIN's canvas sizes are already WxH so they pass through; `auto` has no Ark
 *  equivalent, so it is omitted and Ark picks its own default. */
export function seedreamSize(size: string | undefined): string | null {
  if (!size || size === 'auto') return null
  return size
}

interface ArkImageResponse {
  data?: Array<{ url?: string; b64_json?: string | null }>
  error?: { code?: string; message?: string }
}

class SeedreamImageGenProvider implements ImageGenProvider {
  readonly id: ImageGenProviderId = 'seedream'

  constructor(
    private apiKey: string | null,
    private model: string = defaultModelFor('seedream'),
    private defaultSize: string = '1024x1024'
  ) {}

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  private requireKey(): string {
    if (!this.isConfigured() || !this.apiKey) {
      throw new Error(
        'No image generation provider configured. Configure in Settings → Image Generation.'
      )
    }
    return this.apiKey
  }

  async generate(args: GenerateArgs): Promise<ImageBytes[]> {
    const key = this.requireKey()
    const size = seedreamSize(args.size ?? this.defaultSize)
    const body: Record<string, unknown> = {
      model: resolveModel('seedream', args.model || this.model),
      prompt: args.prompt,
      response_format: 'b64_json',
      output_format: 'png',
      // Ark stamps an AI watermark by default on some models. This is a
      // personal tool writing into the operator's own vault, so ask for the
      // clean image rather than silently returning a branded one.
      watermark: false,
      stream: false
    }
    if (size) body.size = size

    let resp: Response
    try {
      resp = await fetchWithTimeout(ARK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new Error(`Seedream image generation request failed: ${sanitizeError(err, key)}`, {
        cause: err
      })
    }
    return parseArkImageResponse(resp, key)
  }

  // Seedream DOES edit — Ark's `image` field takes reference images — but it
  // takes them as URLs, and DUIN hands edit() a LOCAL path. Whether Ark accepts
  // a base64 data URI there is not stated in its own docs (only in third-party
  // wrappers), and guessing wrong fails at request time with an opaque remote
  // error. Refuse plainly until that is confirmed against Ark itself.
  async edit(): Promise<ImageBytes[]> {
    throw new Error(
      'Seedream editing needs a publicly reachable image URL, which DUIN cannot produce from a local file. Switch Settings → Image Generation to OpenAI for image_edit.'
    )
  }

  async variation(): Promise<ImageBytes[]> {
    throw new Error(
      'Seedream has no variations endpoint. Switch Settings → Image Generation to OpenAI for image_variation.'
    )
  }
}

export async function parseArkImageResponse(
  resp: Response,
  key: string
): Promise<ImageBytes[]> {
  const text = await resp.text().catch(() => '')

  let payload: ArkImageResponse | null
  try {
    payload = JSON.parse(text) as ArkImageResponse
  } catch {
    payload = null
  }

  // Ark puts a structured error object in the body. Prefer it over the bare
  // status line — "InvalidParameter: size not supported" beats "400 Bad Request".
  if (payload?.error) {
    const { code, message } = payload.error
    throw new Error(
      `Seedream image API error ${code ?? resp.status}: ${sanitizeError(message ?? 'no message', key)}`
    )
  }
  if (!resp.ok) {
    throw new Error(
      `Seedream image API ${resp.status} ${resp.statusText}: ${sanitizeError(text.slice(0, 500), key)}`
    )
  }
  if (!payload) {
    throw new Error('Seedream image API returned non-JSON body')
  }

  const entries = payload.data ?? []
  if (entries.length === 0) throw new Error('Seedream image API returned no image data')

  const out: ImageBytes[] = []
  for (const entry of entries) {
    if (entry.b64_json) {
      const bytes = Buffer.from(entry.b64_json, 'base64')
      out.push({ bytes, mimeType: sniffImageMime(bytes) })
      continue
    }
    if (entry.url) {
      let imgResp: Response
      try {
        imgResp = await fetchWithTimeout(entry.url, { method: 'GET' })
      } catch (err) {
        throw new Error(`failed to fetch generated image url: ${sanitizeError(err, key)}`, {
          cause: err
        })
      }
      if (!imgResp.ok) {
        throw new Error(`image url fetch failed: ${imgResp.status} ${imgResp.statusText}`)
      }
      const bytes = Buffer.from(await imgResp.arrayBuffer())
      out.push({ bytes, mimeType: imgResp.headers.get('content-type') ?? sniffImageMime(bytes) })
      continue
    }
    throw new Error('Seedream image API returned a data entry without b64_json or url')
  }
  return out
}

// ─────────────────────────── Stability stub ───────────────────────────

class StabilityImageGenProvider implements ImageGenProvider {
  readonly id: ImageGenProviderId = 'stability'

  isConfigured(): boolean {
    // Even with a key configured, the provider is intentionally not wired up
    // yet. Returning false keeps `imageGen:test` honest.
    return false
  }

  async generate(): Promise<ImageBytes[]> {
    throw new Error('Stability AI provider not yet implemented.')
  }

  async edit(): Promise<ImageBytes[]> {
    throw new Error('Stability AI provider not yet implemented.')
  }

  async variation(): Promise<ImageBytes[]> {
    throw new Error('Stability AI provider not yet implemented.')
  }
}

// ─────────────────────────── factory ───────────────────────────

export function getImageGenSettings(): ImageGenSettings {
  const settings = readSettings()
  const raw = (settings.imageGen as Partial<ImageGenSettings> | undefined) ?? {}
  const provider: ImageGenProviderId = isImageGenProviderId(raw.provider)
    ? raw.provider
    : 'openai'
  return {
    provider,
    // resolveModel, not a raw passthrough: a settings file written before the
    // provider was switched still holds the old provider's model name.
    model: resolveModel(provider, typeof raw.model === 'string' ? raw.model : undefined),
    size: typeof raw.size === 'string' ? raw.size : DEFAULT_IMAGE_SETTINGS.size
  }
}

export function keychainProviderKey(provider: ImageGenProviderId): string {
  return `image_gen:${provider}`
}

/**
 * Resolve the configured provider, loading credentials from the keychain.
 * Always returns a provider instance — `isConfigured()` and the per-call
 * `requireKey` paths are how callers know the credentials aren't there yet.
 */
export function getImageGenProvider(): ImageGenProvider {
  const settings = getImageGenSettings()
  const size = settings.size || DEFAULT_IMAGE_SETTINGS.size!
  switch (settings.provider) {
    case 'stability':
      return new StabilityImageGenProvider()
    case 'minimax': {
      const key = getKey(keychainProviderKey('minimax'))
      return new MiniMaxImageGenProvider(key, resolveModel('minimax', settings.model), size)
    }
    case 'seedream': {
      const key = getKey(keychainProviderKey('seedream'))
      return new SeedreamImageGenProvider(key, resolveModel('seedream', settings.model), size)
    }
    case 'openai':
    default: {
      const key = getKey(keychainProviderKey('openai'))
      return new OpenAIImageGenProvider(key, resolveModel('openai', settings.model), size)
    }
  }
}

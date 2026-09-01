import { getKey } from './keychain'
import { readSettings } from './settings-helper'
import { messageOf } from './guarded'

// Text-to-speech service (Wave-3 — outbound voice). Wraps ONE provider so a
// scheduled / channel reply can optionally be delivered as spoken audio. Two
// backends, both zero-new-dependency:
//
//   - 'openai'  — OpenAI's `/audio/speech` endpoint via the EXISTING `openai`
//                 provider key (keychain). Pure request shaping lives in
//                 `buildOpenAiTtsRequest` so it's unit-testable without a key.
//   - 'edge'    — a zero-KEY local subprocess (`edge-tts` CLI, if the operator
//                 installs it). Scaffolded + flag-gated; audio out is human-verify.
//
// Contract (mirrors the OCR/audio best-effort spirit):
//   - FLAG-GATED, default OFF (`DUIN_TTS` / persisted `ttsEnabled`). Off, no
//     synthesis is attempted and callers behave byte-identically to today.
//   - BEST-EFFORT: ANY failure (flag off, no key, no binary, HTTP error, spawn
//     error) resolves to `{ ok: false, error }` — synthesis NEVER throws into a
//     dispatch/scheduler path. The text was already delivered; voice is a bonus.
//
// HUMAN-VERIFY: actual audio bytes (real OpenAI key round-trip, `edge-tts`
// installed, playback) can't be exercised here. The unit-tested surface is the
// request SHAPING; the network/subprocess call is scaffolded behind the flag.

export type TtsProvider = 'openai' | 'edge'

/** Default OpenAI TTS model + voice. Kept as constants so shaping is stable and
 *  the test pins exact values. `tts-1` is the low-latency model; `alloy` a
 *  neutral default voice. */
export const DEFAULT_OPENAI_TTS_MODEL = 'tts-1'
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy'
export const DEFAULT_OPENAI_TTS_FORMAT = 'mp3'

/**
 * TTS feature flag. Composition (env override → persisted setting → default OFF):
 *   1. `DUIN_TTS` env var, when SET (non-empty) — 1/true/on/yes → on, else off.
 *   2. Otherwise the persisted `ttsEnabled` setting.
 *   3. Default OFF — voice out is an explicit opt-in (needs a key or a binary).
 */
export function ttsEnabled(): boolean {
  const raw = process.env.DUIN_TTS
  if (raw != null && raw.trim() !== '') {
    const v = raw.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'on' || v === 'yes'
  }
  return readSettings().ttsEnabled === true
}

/** Selected TTS provider. `DUIN_TTS_PROVIDER` env wins when SET; else the
 *  persisted `ttsProvider` setting; else 'openai'. Unknown → 'openai'. */
export function ttsProvider(): TtsProvider {
  const raw = process.env.DUIN_TTS_PROVIDER?.trim()?.toLowerCase()
  const fromSettings =
    typeof readSettings().ttsProvider === 'string'
      ? String(readSettings().ttsProvider).toLowerCase()
      : ''
  const val = raw || fromSettings
  return val === 'edge' ? 'edge' : 'openai'
}

export interface TtsOptions {
  /** Provider voice id (e.g. 'alloy'/'nova' for OpenAI, 'en-US-AriaNeural' for edge). */
  voice?: string
  /** OpenAI model id. */
  model?: string
  /** Output container format ('mp3'|'wav'|'opus'|'aac'|'flac'). */
  format?: string
}

export interface OpenAiTtsRequest {
  url: string
  headers: Record<string, string>
  /** JSON-serializable body for the POST. */
  body: {
    model: string
    voice: string
    input: string
    response_format: string
  }
}

/** MIME for an OpenAI TTS response_format. */
export function ttsFormatMime(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav'
    case 'opus':
      return 'audio/opus'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    case 'mp3':
    default:
      return 'audio/mpeg'
  }
}

/**
 * Shape an OpenAI `/audio/speech` request. PURE (no network, no key read) so the
 * mapping — endpoint, auth header, model/voice/format defaults, body — is
 * unit-testable. `apiKey` is passed in by the caller (which reads the keychain).
 */
export function buildOpenAiTtsRequest(
  text: string,
  apiKey: string,
  opts: TtsOptions = {}
): OpenAiTtsRequest {
  return {
    url: 'https://api.openai.com/v1/audio/speech',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: opts.model?.trim() || DEFAULT_OPENAI_TTS_MODEL,
      voice: opts.voice?.trim() || DEFAULT_OPENAI_TTS_VOICE,
      input: text,
      response_format: opts.format?.trim() || DEFAULT_OPENAI_TTS_FORMAT
    }
  }
}

export interface TtsResult {
  ok: boolean
  /** Synthesized audio bytes (present only on ok). */
  audio?: Buffer
  /** MIME of `audio`. */
  mime?: string
  /** Which backend produced (or attempted) the audio. */
  provider?: TtsProvider
  error?: string
}

// Test seam: inject a fake fetch so the OpenAI HTTP path can be exercised without
// a real key/network. Defaults to the global fetch.
type FetchLike = (url: string, init: unknown) => Promise<{
  ok: boolean
  status: number
  arrayBuffer: () => Promise<ArrayBuffer>
  text: () => Promise<string>
}>
let fetchOverride: FetchLike | null = null
/** Test-only: install a fake fetch (or null to restore global fetch). */
export function __setTtsFetch(fn: FetchLike | null): void {
  fetchOverride = fn
}

/**
 * Synthesize `text` to speech. BEST-EFFORT: returns `{ ok: false, error }` on
 * ANY failure (flag off, missing key/binary, HTTP/spawn error) and never throws.
 * On success returns the audio bytes + mime for the caller to play/attach.
 *
 * HUMAN-VERIFY: the real key round-trip and audio playback are out of scope for
 * unit tests — only the request shaping is locked. This is the network seam.
 */
export async function synthesizeSpeech(text: string, opts: TtsOptions = {}): Promise<TtsResult> {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'empty text' }
  if (!ttsEnabled()) return { ok: false, error: 'tts disabled' }
  const provider = ttsProvider()
  try {
    if (provider === 'openai') return await synthesizeOpenAi(body, opts)
    return await synthesizeEdge(body, opts)
  } catch (e) {
    return { ok: false, provider, error: messageOf(e) }
  }
}

async function synthesizeOpenAi(text: string, opts: TtsOptions): Promise<TtsResult> {
  const apiKey = getKey('openai')
  if (!apiKey) return { ok: false, provider: 'openai', error: 'no openai key' }
  const req = buildOpenAiTtsRequest(text, apiKey, opts)
  const doFetch = fetchOverride ?? (globalThis.fetch as unknown as FetchLike)
  const res = await doFetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return { ok: false, provider: 'openai', error: `openai tts ${res.status}: ${detail.slice(0, 200)}` }
  }
  const audio = Buffer.from(await res.arrayBuffer())
  return {
    ok: true,
    provider: 'openai',
    audio,
    mime: ttsFormatMime(req.body.response_format)
  }
}

/**
 * Edge-TTS backend (zero key). Scaffolded: shells out to an `edge-tts` CLI the
 * operator must install (`pip install edge-tts`). HUMAN-VERIFY — no binary is
 * bundled; absent, this degrades to a clean error.
 */
async function synthesizeEdge(text: string, opts: TtsOptions): Promise<TtsResult> {
  const bin = process.env.DUIN_EDGE_TTS_BIN?.trim() || 'edge-tts'
  const voice = opts.voice?.trim() || 'en-US-AriaNeural'
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as typeof import('child_process')
    // edge-tts --voice <v> --text <t> --write-media /dev/stdout is unreliable
    // cross-platform; the robust path writes a temp file. Kept minimal + gated:
    // we stream stdout with `--write-media -` where supported.
    const audio = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(bin, ['--voice', voice, '--text', text, '--write-media', '-'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const chunks: Buffer[] = []
      let err = ''
      child.stdout?.on('data', (d: Buffer) => chunks.push(d))
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString('utf-8')
      })
      child.on('error', reject)
      child.on('close', (code: number | null) => {
        if (code === 0 && chunks.length) resolve(Buffer.concat(chunks))
        else reject(new Error(`edge-tts exited ${code}: ${err.slice(0, 200)}`))
      })
    })
    return { ok: true, provider: 'edge', audio, mime: 'audio/mpeg' }
  } catch (e) {
    return { ok: false, provider: 'edge', error: messageOf(e) }
  }
}

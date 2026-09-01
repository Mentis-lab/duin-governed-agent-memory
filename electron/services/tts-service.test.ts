import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the keychain so the OpenAI key read is deterministic and the electron
// safeStorage import chain is never touched.
const getKey = vi.fn()
vi.mock('./keychain', () => ({ getKey: (p: string) => getKey(p) }))

import {
  buildOpenAiTtsRequest,
  ttsFormatMime,
  ttsEnabled,
  ttsProvider,
  synthesizeSpeech,
  __setTtsFetch,
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_OPENAI_TTS_FORMAT
} from './tts-service'

const ORIGINAL_TTS = process.env.DUIN_TTS
const ORIGINAL_PROVIDER = process.env.DUIN_TTS_PROVIDER

beforeEach(() => {
  getKey.mockReset()
})

afterEach(() => {
  if (ORIGINAL_TTS === undefined) delete process.env.DUIN_TTS
  else process.env.DUIN_TTS = ORIGINAL_TTS
  if (ORIGINAL_PROVIDER === undefined) delete process.env.DUIN_TTS_PROVIDER
  else process.env.DUIN_TTS_PROVIDER = ORIGINAL_PROVIDER
  __setTtsFetch(null)
})

// ──────────────────── request shaping (the tested boundary) ────────────────────

describe('buildOpenAiTtsRequest', () => {
  it('shapes the endpoint, auth header, and default model/voice/format', () => {
    const req = buildOpenAiTtsRequest('hello world', 'sk-test')
    expect(req.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(req.headers.Authorization).toBe('Bearer sk-test')
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.body).toEqual({
      model: DEFAULT_OPENAI_TTS_MODEL,
      voice: DEFAULT_OPENAI_TTS_VOICE,
      input: 'hello world',
      response_format: DEFAULT_OPENAI_TTS_FORMAT
    })
  })

  it('honors explicit voice/model/format overrides', () => {
    const req = buildOpenAiTtsRequest('hi', 'sk-x', {
      voice: 'nova',
      model: 'tts-1-hd',
      format: 'wav'
    })
    expect(req.body.voice).toBe('nova')
    expect(req.body.model).toBe('tts-1-hd')
    expect(req.body.response_format).toBe('wav')
    expect(req.body.input).toBe('hi')
  })

  it('falls back to defaults for blank/whitespace overrides', () => {
    const req = buildOpenAiTtsRequest('hi', 'sk-x', { voice: '  ', model: '', format: '   ' })
    expect(req.body.voice).toBe(DEFAULT_OPENAI_TTS_VOICE)
    expect(req.body.model).toBe(DEFAULT_OPENAI_TTS_MODEL)
    expect(req.body.response_format).toBe(DEFAULT_OPENAI_TTS_FORMAT)
  })
})

describe('ttsFormatMime', () => {
  it('maps formats to mimes (mp3 default)', () => {
    expect(ttsFormatMime('mp3')).toBe('audio/mpeg')
    expect(ttsFormatMime('wav')).toBe('audio/wav')
    expect(ttsFormatMime('opus')).toBe('audio/opus')
    expect(ttsFormatMime('aac')).toBe('audio/aac')
    expect(ttsFormatMime('flac')).toBe('audio/flac')
    expect(ttsFormatMime('anything-else')).toBe('audio/mpeg')
  })
})

// ──────────────────── feature flag + provider selection ────────────────────

describe('ttsEnabled (default OFF)', () => {
  it('defaults OFF when unset', () => {
    delete process.env.DUIN_TTS
    expect(ttsEnabled()).toBe(false)
  })
  it('env ON override', () => {
    for (const v of ['1', 'true', 'on', 'YES']) {
      process.env.DUIN_TTS = v
      expect(ttsEnabled()).toBe(true)
    }
  })
  it('anything else is OFF', () => {
    for (const v of ['0', 'false', 'off', '']) {
      process.env.DUIN_TTS = v
      expect(ttsEnabled()).toBe(false)
    }
  })
})

describe('ttsProvider', () => {
  it('defaults to openai', () => {
    delete process.env.DUIN_TTS_PROVIDER
    expect(ttsProvider()).toBe('openai')
  })
  it('env selects edge', () => {
    process.env.DUIN_TTS_PROVIDER = 'edge'
    expect(ttsProvider()).toBe('edge')
  })
  it('unknown falls back to openai', () => {
    process.env.DUIN_TTS_PROVIDER = 'espeak'
    expect(ttsProvider()).toBe('openai')
  })
})

// ──────────────────── synthesizeSpeech best-effort ────────────────────

describe('synthesizeSpeech best-effort contract', () => {
  it('rejects empty text', async () => {
    process.env.DUIN_TTS = '1'
    const r = await synthesizeSpeech('   ')
    expect(r).toEqual({ ok: false, error: 'empty text' })
  })

  it('is a no-op when the flag is off', async () => {
    delete process.env.DUIN_TTS
    const r = await synthesizeSpeech('hello')
    expect(r).toEqual({ ok: false, error: 'tts disabled' })
    expect(getKey).not.toHaveBeenCalled()
  })

  it('reports missing openai key', async () => {
    process.env.DUIN_TTS = '1'
    process.env.DUIN_TTS_PROVIDER = 'openai'
    getKey.mockReturnValue(null)
    const r = await synthesizeSpeech('hello')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no openai key/)
  })

  it('POSTs the shaped request and returns audio bytes on success', async () => {
    process.env.DUIN_TTS = '1'
    process.env.DUIN_TTS_PROVIDER = 'openai'
    getKey.mockReturnValue('sk-live')
    const audioBytes = new Uint8Array([1, 2, 3, 4])
    const fetchMock = vi.fn(async (url: string, init: unknown) => {
      expect(url).toBe('https://api.openai.com/v1/audio/speech')
      const body = JSON.parse((init as { body: string }).body)
      expect(body.input).toBe('hello')
      expect(body.model).toBe(DEFAULT_OPENAI_TTS_MODEL)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => audioBytes.buffer,
        text: async () => ''
      }
    })
    __setTtsFetch(fetchMock)
    const r = await synthesizeSpeech('hello')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('openai')
    expect(r.mime).toBe('audio/mpeg')
    expect(Buffer.isBuffer(r.audio)).toBe(true)
    expect([...(r.audio as Buffer)]).toEqual([1, 2, 3, 4])
  })

  it('surfaces an HTTP error (never throws)', async () => {
    process.env.DUIN_TTS = '1'
    process.env.DUIN_TTS_PROVIDER = 'openai'
    getKey.mockReturnValue('sk-live')
    __setTtsFetch(async () => ({
      ok: false,
      status: 429,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => 'rate limited'
    }))
    const r = await synthesizeSpeech('hello')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/openai tts 429/)
    expect(r.error).toMatch(/rate limited/)
  })
})

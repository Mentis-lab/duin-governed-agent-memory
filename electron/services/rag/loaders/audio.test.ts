import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDIO_EXTENSIONS,
  isAudioExtension,
  audioMime,
  audioTranscribeEnabled,
  transcribeAudio,
  __setWhisperRunner
} from './audio'
import { loadDocument } from './index'
import { isIngestable } from '../../local-brain/index-store'

// No real whisper binary is exercised here. The runner is injected via
// __setWhisperRunner so the flag-gating + dispatch + best-effort contract is
// tested fast and deterministically. (A real transcription is integration-only.)

const ORIGINAL_FLAG = process.env.DUIN_AUDIO_TRANSCRIBE
const ORIGINAL_BIN = process.env.DUIN_WHISPER_BIN

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.DUIN_AUDIO_TRANSCRIBE
  else process.env.DUIN_AUDIO_TRANSCRIBE = ORIGINAL_FLAG
  if (ORIGINAL_BIN === undefined) delete process.env.DUIN_WHISPER_BIN
  else process.env.DUIN_WHISPER_BIN = ORIGINAL_BIN
  __setWhisperRunner(null)
})

// ──────────────────── extension classification ────────────────────

describe('audio extension classification', () => {
  it('recognizes the audio extensions (case-insensitive)', () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(isAudioExtension(`memo${ext}`)).toBe(true)
      expect(isAudioExtension(`MEMO${ext.toUpperCase()}`)).toBe(true)
    }
  })

  it('rejects non-audio extensions', () => {
    expect(isAudioExtension('note.md')).toBe(false)
    expect(isAudioExtension('shot.png')).toBe(false)
    expect(isAudioExtension('noext')).toBe(false)
  })

  it('maps extensions to audio mimes', () => {
    expect(audioMime('a.m4a')).toBe('audio/mp4')
    expect(audioMime('a.MP3')).toBe('audio/mpeg')
    expect(audioMime('a.wav')).toBe('audio/wav')
    expect(audioMime('a.ogg')).toBe('audio/ogg')
  })
})

// ──────────────────── feature flag (default OFF) ────────────────────

describe('audioTranscribeEnabled (default OFF, env overrides)', () => {
  it('defaults OFF when the env var is unset (no settings.json in tests)', () => {
    delete process.env.DUIN_AUDIO_TRANSCRIBE
    expect(audioTranscribeEnabled()).toBe(false)
  })

  it('treats an empty env var as "unset" → default OFF', () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = ''
    expect(audioTranscribeEnabled()).toBe(false)
  })

  it('env ON override for 1/true/on/yes (any case)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'Yes']) {
      process.env.DUIN_AUDIO_TRANSCRIBE = v
      expect(audioTranscribeEnabled()).toBe(true)
    }
  })

  it('anything else is OFF', () => {
    for (const v of ['0', 'false', 'off', 'no', 'nope']) {
      process.env.DUIN_AUDIO_TRANSCRIBE = v
      expect(audioTranscribeEnabled()).toBe(false)
    }
  })
})

// ──────────────────── isIngestable gating (flag-off == today) ────────────────────

describe('isIngestable audio gating', () => {
  it('audio is NOT ingestable when the flag is off (default)', () => {
    delete process.env.DUIN_AUDIO_TRANSCRIBE
    expect(isIngestable('memo.m4a')).toBe(false)
    expect(isIngestable('memo.mp3')).toBe(false)
    // non-audio ingestables are unaffected
    expect(isIngestable('a.md')).toBe(true)
    expect(isIngestable('a.pdf')).toBe(true)
  })

  it('audio IS ingestable when the flag is on', () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = '1'
    expect(isIngestable('memo.m4a')).toBe(true)
    expect(isIngestable('memo.wav')).toBe(true)
    expect(isIngestable('memo.ogg')).toBe(true)
  })
})

// ──────────────────── dispatcher gating ────────────────────

describe('loadDocument audio gating', () => {
  it('does NOT intercept audio when the flag is off', async () => {
    delete process.env.DUIN_AUDIO_TRANSCRIBE
    await expect(loadDocument('memo.m4a')).rejects.toThrow(/Unsupported/i)
  })

  it('routes audio through transcription when enabled, with no binary → empty text (never throws)', async () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = '1'
    process.env.DUIN_WHISPER_BIN = '/definitely/not/a/real/whisper/binary'
    const r = await loadDocument('memo.m4a')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.text).toBe('')
      expect(r.mime).toBe('audio/mp4')
    }
  })
})

// ──────────────────── transcribeAudio best-effort ────────────────────

describe('transcribeAudio best-effort contract', () => {
  it('returns empty text when the flag is off (never spawns)', async () => {
    delete process.env.DUIN_AUDIO_TRANSCRIBE
    __setWhisperRunner(async () => 'should not be called')
    const r = await transcribeAudio('memo.mp3')
    expect(r).toEqual({ text: '' })
  })

  it('returns empty text when no binary resolves (degrades, never throws)', async () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = '1'
    process.env.DUIN_WHISPER_BIN = '/definitely/not/a/real/whisper/binary'
    const r = await transcribeAudio('memo.mp3')
    expect(r).toEqual({ text: '' })
  })

  it('maps a successful runner result to trimmed text', async () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = '1'
    // A resolvable "binary": point at this test file so existsSync passes.
    process.env.DUIN_WHISPER_BIN = __filename
    __setWhisperRunner(async () => '  hello from the memo  \n')
    const r = await transcribeAudio('memo.mp3')
    expect(r.text).toBe('hello from the memo')
  })

  it('swallows a runner failure and returns empty text', async () => {
    process.env.DUIN_AUDIO_TRANSCRIBE = '1'
    process.env.DUIN_WHISPER_BIN = __filename
    __setWhisperRunner(async () => {
      throw new Error('whisper boom')
    })
    const r = await transcribeAudio('memo.mp3')
    expect(r).toEqual({ text: '' })
  })
})

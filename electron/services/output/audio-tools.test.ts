import { describe, it, expect } from 'vitest'
import {
  resolveAudioFormat,
  audioExtForMime,
  sanitizeBaseName,
  buildAudioFilename,
  validateGenerateAudioArgs,
  DEFAULT_AUDIO_FORMAT,
  type GenerateAudioArgs
} from './audio-tools'

// Pure arg/shape helpers for generate_audio — no key, no binary, no Electron.
// The actual synthesis + file write are human-verify (need a real provider).

describe('resolveAudioFormat', () => {
  it('accepts supported formats case-insensitively', () => {
    expect(resolveAudioFormat('wav')).toBe('wav')
    expect(resolveAudioFormat('WAV')).toBe('wav')
    expect(resolveAudioFormat(' opus ')).toBe('opus')
  })
  it('falls back to the default for unknown / empty / non-string', () => {
    expect(resolveAudioFormat('ogg')).toBe(DEFAULT_AUDIO_FORMAT)
    expect(resolveAudioFormat('')).toBe(DEFAULT_AUDIO_FORMAT)
    expect(resolveAudioFormat(undefined)).toBe(DEFAULT_AUDIO_FORMAT)
    expect(resolveAudioFormat(42)).toBe(DEFAULT_AUDIO_FORMAT)
    expect(DEFAULT_AUDIO_FORMAT).toBe('mp3')
  })
})

describe('audioExtForMime', () => {
  it('maps known audio mimes to extensions', () => {
    expect(audioExtForMime('audio/wav')).toBe('.wav')
    expect(audioExtForMime('audio/opus')).toBe('.opus')
    expect(audioExtForMime('audio/aac')).toBe('.aac')
    expect(audioExtForMime('audio/flac')).toBe('.flac')
    expect(audioExtForMime('audio/mpeg')).toBe('.mp3')
  })
  it('defaults unknown mime to .mp3', () => {
    expect(audioExtForMime('application/octet-stream')).toBe('.mp3')
  })
})

describe('sanitizeBaseName', () => {
  it('strips path separators and traversal', () => {
    expect(sanitizeBaseName('../../etc/passwd')).not.toContain('/')
    expect(sanitizeBaseName('../../etc/passwd')).not.toContain('..')
    expect(sanitizeBaseName('a/b\\c')).toBe('a-b-c')
  })
  it('collapses whitespace and unsafe chars to single dashes', () => {
    expect(sanitizeBaseName('my   report!!name')).toBe('my-report-name')
  })
  it('returns empty for empty / non-string', () => {
    expect(sanitizeBaseName('')).toBe('')
    expect(sanitizeBaseName('   ')).toBe('')
    expect(sanitizeBaseName(undefined)).toBe('')
    expect(sanitizeBaseName(123)).toBe('')
  })
  it('caps length at 64 chars', () => {
    expect(sanitizeBaseName('a'.repeat(200)).length).toBe(64)
  })
})

describe('buildAudioFilename', () => {
  it('uses the base when present', () => {
    const name = buildAudioFilename('brief', '.mp3', 0, 'abc123')
    expect(name).toBe('brief-0-abc123.mp3')
  })
  it('falls back to an audio- prefix with no base', () => {
    const name = buildAudioFilename('', '.wav', 0, 'zzz')
    expect(name).toBe('audio-0-zzz.wav')
  })
  it('encodes the timestamp in base36', () => {
    expect(buildAudioFilename('x', '.mp3', 36, 'r')).toBe('x-10-r.mp3')
  })
})

describe('validateGenerateAudioArgs', () => {
  it('rejects empty / missing text', () => {
    expect(validateGenerateAudioArgs({ text: '' } as GenerateAudioArgs)).toEqual({
      error: expect.stringMatching(/text is required/)
    })
    expect(validateGenerateAudioArgs({ text: '   ' } as GenerateAudioArgs)).toHaveProperty('error')
    expect(validateGenerateAudioArgs({} as GenerateAudioArgs)).toHaveProperty('error')
  })
  it('shapes text + opts with defaults', () => {
    const r = validateGenerateAudioArgs({ text: '  hello world  ' })
    expect('error' in r).toBe(false)
    if ('error' in r) throw new Error('unexpected')
    expect(r.text).toBe('hello world')
    expect(r.format).toBe('mp3')
    expect(r.opts.format).toBe('mp3')
    expect(r.opts.voice).toBeUndefined()
    expect(r.base).toBe('')
  })
  it('passes through voice, format and sanitized name', () => {
    const r = validateGenerateAudioArgs({
      text: 'hi',
      voice: 'nova',
      format: 'WAV',
      name: 'weekly report'
    })
    if ('error' in r) throw new Error('unexpected error')
    expect(r.opts.voice).toBe('nova')
    expect(r.format).toBe('wav')
    expect(r.opts.format).toBe('wav')
    expect(r.base).toBe('weekly-report')
  })
})

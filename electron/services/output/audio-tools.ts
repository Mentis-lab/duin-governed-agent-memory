// audio-tools.ts — the `generate_audio` executor. Turns text into a spoken-audio
// FILE by driving the existing tts-service (OpenAI `/audio/speech` or a local
// `edge-tts` subprocess — no NEW npm dependency), writing the bytes into the
// userData artifacts/audio directory and returning the absolute path.
//
// Mirrors image-tools.ts: a thin executor around a provider module, plus a set
// of PURE arg/shape helpers (validate → format → filename) that are unit-testable
// without a key, a binary, or the Electron app. The synthesis call itself is
// best-effort (tts-service never throws) and is HUMAN-VERIFY — actual audio bytes
// need a real OpenAI key or an installed edge-tts.

import { synthesizeSpeech, type TtsOptions } from '../tts-service'
import { messageOf } from '../guarded'

// Container formats tts-service (OpenAI `/audio/speech`) can emit. Kept in sync
// with tts-service.ttsFormatMime so the tool's schema enum and the mime→ext map
// agree. edge-tts always emits mp3.
export const AUDIO_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac'] as const
export type AudioFormat = (typeof AUDIO_FORMATS)[number]

export const DEFAULT_AUDIO_FORMAT: AudioFormat = 'mp3'
const TEXT_PREVIEW_CHARS = 80

export interface GenerateAudioArgs {
  text: string
  voice?: string
  format?: string
  name?: string
}

/** Normalise a caller-supplied `format` to a supported container, defaulting to
 *  mp3. PURE. Unknown / empty → the default so a bad hint never fails the call. */
export function resolveAudioFormat(raw: unknown): AudioFormat {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (AUDIO_FORMATS as readonly string[]).includes(v) ? (v as AudioFormat) : DEFAULT_AUDIO_FORMAT
}

/** File extension for an audio mime (mirrors tts-service.ttsFormatMime inverse).
 *  Falls back to .mp3 for the OpenAI default `audio/mpeg`. PURE. */
export function audioExtForMime(mime: string): string {
  switch (mime) {
    case 'audio/wav':
      return '.wav'
    case 'audio/opus':
      return '.opus'
    case 'audio/aac':
      return '.aac'
    case 'audio/flac':
      return '.flac'
    case 'audio/mpeg':
    default:
      return '.mp3'
  }
}

/** Sanitise a caller-supplied base filename to a safe single path segment (no
 *  directory separators, no traversal, bounded length). Empty/absent → ''. PURE. */
export function sanitizeBaseName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return ''
  // Strip anything that isn't a filename-safe char; collapse runs to '-'.
  const cleaned = s
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
  return cleaned
}

/** Build the output filename for a synthesized clip: `<base>-<ts>-<rand><ext>`
 *  when a base is given, else `audio-<ts>-<rand><ext>`. PURE given its inputs. */
export function buildAudioFilename(base: string, ext: string, now: number, rand: string): string {
  const stem = base ? `${base}-${now.toString(36)}-${rand}` : `audio-${now.toString(36)}-${rand}`
  return `${stem}${ext}`
}

/** Validate `generate_audio` args into a synthesis request. PURE — returns the
 *  cleaned text + TtsOptions, or an `{ error }` with a model-readable reason. */
export function validateGenerateAudioArgs(
  args: GenerateAudioArgs
): { text: string; opts: TtsOptions; format: AudioFormat; base: string } | { error: string } {
  const text = typeof args?.text === 'string' ? args.text.trim() : ''
  if (!text) return { error: 'text is required and must be a non-empty string' }
  const format = resolveAudioFormat(args?.format)
  const voice = typeof args?.voice === 'string' && args.voice.trim() ? args.voice.trim() : undefined
  return {
    text,
    format,
    base: sanitizeBaseName(args?.name),
    opts: { voice, format }
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

// ─────────────────────────── generate_audio ───────────────────────────

/**
 * Synthesize `args.text` to a spoken-audio file and return the absolute path.
 * Best-effort by construction: tts-service returns `{ ok:false }` (never throws)
 * when the flag is off, no key/binary is present, or the provider errors, and we
 * surface that as a clean `Error: …` string for the model.
 *
 * The write target + Electron `app` are resolved LAZILY so the pure helpers above
 * (and this module's import) stay usable in a node-only unit test.
 */
export async function executeGenerateAudio(args: GenerateAudioArgs): Promise<string> {
  const parsed = validateGenerateAudioArgs(args)
  if ('error' in parsed) return `Error: ${parsed.error}`

  let result
  try {
    result = await synthesizeSpeech(parsed.text, parsed.opts)
  } catch (e) {
    // synthesizeSpeech is best-effort and shouldn't throw, but never let a
    // provider surprise crash a dispatch/scheduler path.
    return `Error: audio synthesis failed: ${messageOf(e)}`
  }
  if (!result.ok || !result.audio) {
    return `Error: audio synthesis unavailable (${result.error ?? 'unknown'}). Enable TTS (settings.ttsEnabled / DUIN_TTS) and configure an OpenAI key or install edge-tts.`
  }

  try {
    const { app } = await import('electron')
    const { join } = await import('path')
    const { existsSync, mkdirSync, writeFileSync } = await import('fs')
    const dir = join(app.getPath('userData'), 'artifacts', 'audio')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const ext = audioExtForMime(result.mime ?? 'audio/mpeg')
    const rand = Math.random().toString(36).slice(2, 8)
    const filename = buildAudioFilename(parsed.base, ext, Date.now(), rand)
    const dest = join(dir, filename)
    writeFileSync(dest, result.audio)
    return `Synthesized audio to ${dest} (${result.audio.length} bytes, provider: ${result.provider ?? 'unknown'}, text: "${truncate(parsed.text, TEXT_PREVIEW_CHARS)}")`
  } catch (e) {
    return `Error: writing audio file failed: ${messageOf(e)}`
  }
}

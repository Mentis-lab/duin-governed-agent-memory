import { existsSync } from 'fs'
import { extname, join } from 'path'
import { readSettings } from '../../settings-helper'
import { messageOf } from '../../guarded'

// Voice-memo loader (Wave-3 — audio files). Turns voice memos / recordings
// (.m4a/.mp3/.wav/.ogg) into searchable text so a dropped recording stops being
// invisible to the vault index / RAG library. Symmetric in spirit to ocr.ts,
// with the SAME best-effort / lazy / flag-gated contract:
//
//   - LOCAL-FIRST / OFFLINE: transcription runs a LOCAL whisper.cpp /
//     faster-whisper binary the USER provides (we never bundle a multi-hundred-MB
//     model + native binary). No network at call time.
//   - FLAG-GATED, default OFF. Unlike OCR (proven + on-by-default), voice-memo
//     transcription depends on a human-provided binary that isn't present in a
//     fresh install, so it stays OFF until the operator opts in via
//     `DUIN_AUDIO_TRANSCRIBE` (or the persisted `audioTranscribeEnabled` setting).
//     Flag-off, audio files are NOT ingestable and this module never spawns
//     anything — flag-off ingest is byte-identical to today.
//   - BEST-EFFORT: ANY failure (flag off, binary absent, spawn error, non-zero
//     exit, timeout, garbage output) resolves to `{ text: '' }`. Transcription
//     must NEVER throw into the ingest pipeline — an unreadable memo degrades to a
//     0-chunk viewable doc, exactly like a text-layerless PDF or a modelless OCR.
//   - LAZY: the binary is only spawned the first time transcription actually runs
//     for an enabled + resolvable install; there is no persistent worker to hold.
//
// HUMAN-VERIFY: the actual transcription (whisper binary present, correct CLI
// flags for the chosen build, real audio → text) cannot be exercised here — no
// binary is bundled. This module is scaffolded to degrade to a clean no-op with a
// clear log when the binary is missing, and to shell out symmetrically to the
// paddle OCR worker when it IS present.

/** Audio extensions we route to transcription. */
export const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.ogg'] as const

const AUDIO_MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
}

/** True when `name` has an extension we route to transcription. */
export function isAudioExtension(name: string): boolean {
  return extname(name).toLowerCase() in AUDIO_MIME
}

/** The audio mime for a path/name (defaults to a generic audio mime). */
export function audioMime(name: string): string {
  return AUDIO_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Voice-memo transcription feature flag. Composition (env override → persisted
 * setting → default OFF):
 *   1. `DUIN_AUDIO_TRANSCRIBE` env var, when SET (non-empty), always wins —
 *      parsed as 1/true/on/yes → on, anything else → off. Debug knob.
 *   2. Otherwise the persisted `audioTranscribeEnabled` setting.
 *   3. Default OFF when unset — transcription needs a human-provided binary that
 *      isn't present in a fresh install, so it must be an explicit opt-in.
 */
export function audioTranscribeEnabled(): boolean {
  const raw = process.env.DUIN_AUDIO_TRANSCRIBE
  if (raw != null && raw.trim() !== '') {
    const v = raw.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'on' || v === 'yes'
  }
  // Not a typed AppSettings key (env-first feature); readSettings() returns a
  // loose record, so an unset value simply falls to the default OFF.
  return readSettings().audioTranscribeEnabled === true
}

/**
 * Locate the user-provided whisper binary (whisper.cpp `main`/`whisper-cli`, or a
 * `faster-whisper`/`whisper` CLI on PATH). Resolution order:
 *   1. `DUIN_WHISPER_BIN` env override (explicit absolute path to the binary).
 *   2. `process.resourcesPath/whisper/<bin>` (packaged app — if the operator drops
 *      a binary into the extraResources dir; see resources/whisper/README.md).
 *   3. `resources/whisper/<bin>` walked up from this file (dev / repo run).
 * A candidate must EXIST on disk. Returns null when no binary is found, so the
 * caller degrades to empty text (a clear log, never a crash). We deliberately do
 * NOT probe $PATH by name here — an explicit path keeps the spawn deterministic
 * and avoids running some unrelated `whisper` that happens to be installed.
 */
export function resolveWhisperBinary(): string | null {
  const candidates: string[] = []
  const override = process.env.DUIN_WHISPER_BIN?.trim()
  if (override) candidates.push(override)
  const binNames =
    process.platform === 'win32'
      ? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
      : ['whisper-cli', 'main', 'whisper']
  if (process.resourcesPath) {
    for (const b of binNames) candidates.push(join(process.resourcesPath, 'whisper', b))
  }
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    for (const b of binNames) candidates.push(join(dir, 'resources', 'whisper', b))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Locate the whisper model file (`.bin`/`.gguf`) the binary needs. Optional —
 *  some builds embed a default. `DUIN_WHISPER_MODEL` env override wins; else a
 *  `*.bin` under the resolved binary's `resources/whisper/models` sibling. */
export function resolveWhisperModel(): string | null {
  const override = process.env.DUIN_WHISPER_MODEL?.trim()
  if (override && existsSync(override)) return override
  return null
}

export interface AudioTranscript {
  text: string
}

// Bound a single transcription so a wedged binary can't hang ingest forever.
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.DUIN_WHISPER_TIMEOUT_MS) || 300_000 // signal-lint-ignore: 0 means instant timeout, i.e. transcription could never complete

// Test seam: inject a fake runner so the dispatch/degrade contract can be
// exercised without a real binary. Returns the transcript text (or throws).
type TranscribeRunner = (bin: string, audioPath: string) => Promise<string>
let runnerOverride: TranscribeRunner | null = null
/** Test-only: install a fake transcription runner (or null to restore spawn). */
export function __setWhisperRunner(runner: TranscribeRunner | null): void {
  runnerOverride = runner
}

/**
 * Transcribe an audio file to text. BEST-EFFORT: returns `{ text: '' }` on ANY
 * failure (flag off, binary/model absent, spawn error, non-zero exit, timeout)
 * and never throws into the ingest pipeline.
 *
 * @param audioPath a file path to the audio memo.
 */
export async function transcribeAudio(audioPath: string): Promise<AudioTranscript> {
  try {
    if (!audioTranscribeEnabled()) return { text: '' }
    const bin = resolveWhisperBinary()
    if (!bin) {
      // No human-provided binary → degrade to a clean no-op with a clear log so
      // the operator knows WHY a memo indexed as 0 chunks (not a silent skip).
      console.info(
        '[audio] voice-memo transcription is enabled but no whisper binary was ' +
          'found (set DUIN_WHISPER_BIN or drop one in resources/whisper/). ' +
          `Skipping "${audioPath}" (indexes as a 0-chunk viewable doc).`
      )
      return { text: '' }
    }
    const run = runnerOverride ?? spawnWhisper
    const text = await run(bin, audioPath)
    return { text: (text ?? '').trim() }
  } catch (e) {
    console.debug('[audio] transcription failed (degrading to empty):', messageOf(e))
    return { text: '' }
  }
}

/**
 * Spawn the whisper binary and capture its stdout transcript. Modeled on the
 * paddle OCR worker spawn (a bounded, isolated subprocess), but a plain
 * child_process since whisper is a self-contained CLI, not a message worker.
 *
 * HUMAN-VERIFY: the exact flags depend on the operator's build. These target
 * whisper.cpp's `whisper-cli` (`-otxt`-less stdout via `--no-prints`/`-nt`); a
 * faster-whisper wrapper may need different flags. Kept in one place so the human
 * can adjust for their binary. Any deviation surfaces as empty text (best-effort).
 */
async function spawnWhisper(bin: string, audioPath: string): Promise<string> {
  // Lazy require: keep child_process out of the module graph until we actually
  // transcribe (and out of the flag-off / test paths entirely).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process')
  const model = resolveWhisperModel()
  // whisper.cpp: `-f <audio> -nt` (no timestamps) prints plain text to stdout;
  // `-m <model>` only when a model path is resolvable (some builds bundle one).
  const args = ['-f', audioPath, '-nt']
  if (model) args.unshift('-m', model)
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      reject(new Error('whisper timed out'))
    }, TRANSCRIBE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf-8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf-8')
    })
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`whisper exited ${code}: ${err.slice(0, 200)}`))
    })
  })
}

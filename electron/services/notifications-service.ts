import { BrowserWindow, Notification, app } from 'electron'
import { mt } from './main-i18n'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { messageOf } from './guarded'

export interface PushNotificationInput {
  title: string
  body: string
  deepLink?: string | null
}

export interface PushNotificationResult {
  shown: boolean
  reason?: string
}

export function pushNotification(input: PushNotificationInput): PushNotificationResult {
  if (!input.title || typeof input.title !== 'string') {
    throw new Error('title required')
  }
  if (!input.body || typeof input.body !== 'string') {
    throw new Error('body required')
  }
  if (!Notification.isSupported()) {
    return { shown: false, reason: 'notifications unsupported' }
  }
  const notification = new Notification({
    title: input.title,
    body: input.body
  })
  notification.on('click', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('notifications:clicked', {
        title: input.title,
        body: input.body,
        deepLink: input.deepLink ?? null
      })
    }
  })
  notification.show()
  return { shown: true }
}

// ── Daily brain digest — a jargon-free opt-in ────────────────────────────────
// "Send me a daily brain digest": a plain-language toggle that schedules ONE local
// notification per day at a chosen time, nudging the user back to the Home Digest.
// The schedule persists to userData so it survives restarts; the scheduler is a
// simple in-process timer (no OS-level scheduling — a documented, sufficient stub:
// it only fires while the app is running, which is the common case for a desktop
// second-brain the user keeps open).

export interface DigestSchedule {
  /** Whether the daily digest notification is on. */
  enabled: boolean
  /** Local hour (0-23) to fire the digest. */
  hour: number
  /** Local minute (0-59) to fire the digest. */
  minute: number
}

const DEFAULT_SCHEDULE: DigestSchedule = { enabled: false, hour: 8, minute: 0 }
const SCHEDULE_FILE = 'brain-digest-schedule.json'

let cachedSchedule: DigestSchedule | null = null
let digestTimer: ReturnType<typeof setTimeout> | null = null

/** Coerce any persisted/IPC input into a valid schedule (clamped, typed). PURE. */
export function normalizeSchedule(raw: Partial<DigestSchedule> | null | undefined): DigestSchedule {
  const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt
    return n < lo ? lo : n > hi ? hi : n
  }
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SCHEDULE.enabled,
    hour: clampInt(raw?.hour, 0, 23, DEFAULT_SCHEDULE.hour),
    minute: clampInt(raw?.minute, 0, 59, DEFAULT_SCHEDULE.minute)
  }
}

/** Milliseconds from `now` until the next `hour:minute` local occurrence. PURE. */
export function nextDigestDelayMs(schedule: DigestSchedule, now: Date = new Date()): number {
  const next = new Date(now)
  next.setHours(schedule.hour, schedule.minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function schedulePath(): string | null {
  try {
    return join(app.getPath('userData'), SCHEDULE_FILE)
  } catch {
    // app not ready (e.g. unit context) — fall back to in-memory only.
    return null
  }
}

function loadSchedule(): DigestSchedule {
  if (cachedSchedule) return cachedSchedule
  const p = schedulePath()
  if (p && existsSync(p)) {
    try {
      cachedSchedule = normalizeSchedule(JSON.parse(readFileSync(p, 'utf8')))
      return cachedSchedule
    } catch (e) { console.debug('[notifications-service] corrupt file  fall through to default:', messageOf(e)) }
  }
  cachedSchedule = { ...DEFAULT_SCHEDULE }
  return cachedSchedule
}

function persistSchedule(s: DigestSchedule): void {
  cachedSchedule = s
  const p = schedulePath()
  if (!p) return
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(s), 'utf8')
  } catch (e) { console.debug('[notifications-service] best-effort persistence:', messageOf(e)) }
}

function fireDigest(): void {
  try {
    pushNotification({
      title: mt('Your daily brain digest'),
      body: mt("Here's what your brain wants you to see today — open DUIN to catch up."),
      deepLink: 'duin://home-digest'
    })
  } catch (e) { console.debug('[notifications-service] notifications may be unsupported; the timer keeps running:', messageOf(e)) }
}

function disarmDigest(): void {
  if (digestTimer) {
    clearTimeout(digestTimer)
    digestTimer = null
  }
}

/** (Re)arm the daily timer from the current schedule. No-op when disabled. */
function armDigest(): void {
  disarmDigest()
  const s = loadSchedule()
  if (!s.enabled) return
  const tick = (): void => {
    fireDigest()
    // Re-arm a day out. (Recompute from the schedule to avoid drift across DST.)
    digestTimer = setTimeout(tick, nextDigestDelayMs(loadSchedule()))
  }
  digestTimer = setTimeout(tick, nextDigestDelayMs(s))
}

/** Called once at startup to restore a persisted opt-in. */
export function initDigestScheduler(): void {
  armDigest()
}

/** Current daily-digest schedule (for the renderer's toggle state). */
export function getDigestSchedule(): DigestSchedule {
  return { ...loadSchedule() }
}

/** Enable/disable or retime the daily digest; persists and re-arms. Returns the
 *  effective schedule. */
export function setDigestSchedule(input: Partial<DigestSchedule>): DigestSchedule {
  const s = normalizeSchedule({ ...loadSchedule(), ...input })
  persistSchedule(s)
  armDigest()
  return { ...s }
}

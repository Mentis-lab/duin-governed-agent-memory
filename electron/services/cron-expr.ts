// THE 5-field cron parser. Singular deliberately.
//
// There used to be two: automations-runner.parseCron (what electron/ipc/automations.ts
// VALIDATES with — create / update / validateCron all call it) and
// automation-trigger.parseCron (what automations-store WRITES with, via
// createAutomation → legacyCronTrigger → parseAutomationTrigger, and what
// parseStoredAutomationTrigger READS every row with on every listAutomations()).
// They were copies that had drifted apart in BOTH directions, and each direction was
// a live defect:
//
//   • The runner accepted what the store then refused. Its numeric branch had lost
//     the `String(n) !== piece` check, so `parseInt('5abc')` yielded 5: the CronEditor
//     reported the expression valid, with a description and a next-fire time, and the
//     very next call — createAutomation — threw. The user was told the cron was good
//     and then the save failed.
//
//   • The store accepted what the runner refused, re-introducing a defect trunk had
//     already fixed in 872cf8a1 ("bound cron range endpoints before iterating"). The
//     ported step branch had no bound on `hi`, so `1-2000000/1` drove a multi-million
//     iteration Set.add loop synchronously on the main process (measured: 232 ms for
//     2M) and `0-99/1` silently produced minutes 60-99 — a field set outside its own
//     legal domain — while the plain-range form `0-99` correctly threw.
//
// Converging on ONE implementation is the fix; patching the copy would only reset the
// clock. Both modules now re-export from here, so the validator and the writer cannot
// disagree again by construction.
//
// Supports `*`, exact numbers, `a,b,c` lists, `a-b` ranges, and `[range]/N` steps.
// Does NOT support names (mon, tue), `?`, or 6/7-field cron — keep it simple.

export type FieldSet = Set<number>

export interface CronExpr {
  minutes: FieldSet
  hours: FieldSet
  dayOfMonth: FieldSet
  month: FieldSet
  dayOfWeek: FieldSet
}

function parseField(raw: string, min: number, max: number): FieldSet {
  const set = new Set<number>()
  for (const piece of raw.split(',')) {
    if (piece === '*') {
      for (let i = min; i <= max; i++) set.add(i)
      continue
    }
    const stepMatch = piece.match(/^(\*|\d+(-\d+)?)\/(\d+)$/)
    if (stepMatch) {
      const range = stepMatch[1]
      const step = parseInt(stepMatch[3], 10)
      if (step <= 0) throw new Error(`bad step ${step}`)
      let lo = min
      let hi = max
      if (range !== '*') {
        const m = range.match(/^(\d+)(?:-(\d+))?$/)!
        lo = parseInt(m[1], 10)
        hi = m[2] ? parseInt(m[2], 10) : max
        // Bound the explicit range BEFORE iterating. Without this an unbounded
        // `hi` (e.g. `1-20000000/1`) drives a multi-million iteration Set.add
        // loop on the main thread, freezing Electron — and a merely out-of-domain
        // `hi` (e.g. `0-99/1`) quietly admits minutes 60-99 into the field set.
        if (lo < min || hi > max || lo > hi) {
          throw new Error(`bad field range: ${piece}`)
        }
      }
      for (let i = lo; i <= hi; i += step) set.add(i)
      continue
    }
    const rangeMatch = piece.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10)
      const hi = parseInt(rangeMatch[2], 10)
      // Same guard for the plain-range form. The regex accepts any digit count,
      // so `1-20000000` would otherwise spin a 20M-iteration Set.add loop
      // (~3.7s, ~560MB) before RangeError — reachable straight from the
      // CronEditor's validate-as-you-type IPC.
      if (lo < min || hi > max || lo > hi) {
        throw new Error(`bad field range: ${piece}`)
      }
      for (let i = lo; i <= hi; i++) set.add(i)
      continue
    }
    const n = parseInt(piece, 10)
    // `String(n) !== piece` rejects parseInt's prefix leniency (`5abc` → 5, `+5` → 5,
    // ` 5` → 5). Without it the IPC validator green-lights an expression the store
    // then refuses to persist.
    if (!Number.isFinite(n) || String(n) !== piece || n < min || n > max) {
      throw new Error(`bad field value: ${piece}`)
    }
    set.add(n)
  }
  return set
}

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `Cron needs 5 fields (min hour dom month dow), got ${parts.length}: "${expr}"`
    )
  }
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6)
  }
}

export function matches(expr: CronExpr, d: Date): boolean {
  return (
    expr.minutes.has(d.getMinutes()) &&
    expr.hours.has(d.getHours()) &&
    expr.dayOfMonth.has(d.getDate()) &&
    expr.month.has(d.getMonth() + 1) &&
    expr.dayOfWeek.has(d.getDay())
  )
}

const COMMON_PRESETS: Record<string, string> = {
  '* * * * *': 'Every minute',
  '*/5 * * * *': 'Every 5 minutes',
  '*/10 * * * *': 'Every 10 minutes',
  '*/15 * * * *': 'Every 15 minutes',
  '*/30 * * * *': 'Every 30 minutes',
  '0 * * * *': 'Every hour, on the hour',
  '0 */2 * * *': 'Every 2 hours',
  '0 9 * * *': 'Daily at 09:00',
  '0 9 * * 1-5': 'Weekdays at 09:00',
  '0 0 * * *': 'Daily at midnight',
  '0 0 * * 0': 'Weekly at midnight Sunday',
  '0 0 1 * *': 'Monthly on the 1st'
}

function describeFieldSet(set: FieldSet, min: number, max: number, label: string): string {
  const all = max - min + 1
  if (set.size === all) return `every ${label}`
  const sorted = [...set].sort((a, b) => a - b)
  if (sorted.length === 1) return `at ${label} ${sorted[0]}`
  // Detect step pattern: equally spaced.
  if (sorted.length >= 3) {
    const step = sorted[1] - sorted[0]
    let stepOk = step > 1
    for (let i = 2; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] !== step) {
        stepOk = false
        break
      }
    }
    if (stepOk) return `every ${step} ${label}${label.endsWith('s') ? '' : 's'}`
  }
  return `${label}s ${sorted.join(',')}`
}

/**
 * Render a friendly description of a cron expression. Returns null if the
 * expression doesn't parse. Falls back to a field-by-field summary for
 * unrecognized patterns.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** `13` → `13th`. Used for day-of-month, which reads badly as a bare number. */
function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** A single-valued field, or null when it names more than one moment. */
function only(set: FieldSet): number | null {
  return set.size === 1 ? [...set][0] : null
}

function isFull(set: FieldSet, min: number, max: number): boolean {
  return set.size === max - min + 1
}

/** "Every Sunday", "On the 28th", "Weekdays" — or null when the pattern isn't a simple one. */
function describeDays(parsed: CronExpr): string | null {
  const domAll = isFull(parsed.dayOfMonth, 1, 31)
  const dowAll = isFull(parsed.dayOfWeek, 0, 6)
  if (domAll && dowAll) return 'Every day'
  if (domAll && !dowAll) {
    const days = [...parsed.dayOfWeek].sort((a, b) => a - b)
    const asKey = days.join(',')
    if (asKey === '1,2,3,4,5') return 'Weekdays'
    if (asKey === '0,6') return 'Weekends'
    if (days.length === 1) return `Every ${DAY_NAMES[days[0]]}`
    return `Every ${days.map((d) => DAY_NAMES[d]).join(', ')}`
  }
  if (!domAll && dowAll) {
    const day = only(parsed.dayOfMonth)
    return day === null ? null : `Monthly on the ${ordinal(day)}`
  }
  return null // both constrained — cron ORs them, which has no short phrasing
}

/**
 * Render a friendly description of a cron expression. Returns null if the
 * expression doesn't parse.
 *
 * This used to be a 12-entry lookup table with a field-by-field fallback that described
 * ONLY minutes and hours — so anything outside the table silently lost its day. The
 * commonest real schedule there is, `0 21 * * 0`, came out as "at minute 0, at hour 21":
 * true, useless, and missing the word "Sunday". Days are now described first, because the
 * day is what someone is actually checking when they scan a list of automations.
 */
export function describeCron(expr: string): string | null {
  const trimmed = expr.trim().replace(/\s+/g, ' ')
  if (COMMON_PRESETS[trimmed]) return COMMON_PRESETS[trimmed]
  let parsed: CronExpr
  try {
    parsed = parseCron(trimmed)
  } catch {
    return null
  }
  const monthAll = isFull(parsed.month, 1, 12)
  const days = monthAll ? describeDays(parsed) : null
  const hour = only(parsed.hours)
  const minute = only(parsed.minutes)
  // A single wall-clock time is the case worth spelling out; anything else stays generic.
  if (days && hour !== null && minute !== null) {
    return `${days} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }
  const minutes = describeFieldSet(parsed.minutes, 0, 59, 'minute')
  const hours = describeFieldSet(parsed.hours, 0, 23, 'hour')
  const base = `${minutes}, ${hours}`
  return days && days !== 'Every day' ? `${days}, ${base}` : base
}

/**
 * Find the next firing time on or after `from`. Returns null when no match
 * within the next 366 days (handles bad expressions defensively). Tests at the
 * minute granularity the tick scheduler uses, so the result is always second 0.
 */
export function nextFireAfter(expr: string, from: Date = new Date()): Date | null {
  let parsed: CronExpr
  try {
    parsed = parseCron(expr)
  } catch {
    return null
  }
  // Start at the next minute boundary.
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const horizonMinutes = 366 * 24 * 60
  for (let i = 0; i < horizonMinutes; i++) {
    if (matches(parsed, candidate)) return new Date(candidate)
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}

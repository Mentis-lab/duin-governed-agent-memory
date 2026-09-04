/** What a number field is allowed to hold. */
export interface NumberSpec {
  min?: number
  max?: number
  /** Round to whole numbers on commit. Default true. */
  integer?: boolean
  /** 0 is always accepted, even below `min`: it means "off" for caps and budgets. */
  zeroMeansOff?: boolean
}

/**
 * Turn what the operator typed into the value to store, at COMMIT time only.
 *
 * The field this replaces clamped on every keystroke, so a floor of 200 turned the "1" of
 * "1000" into 200 before the second digit arrived, and clearing a seed field wrote the
 * default. Here the draft is free text until blur or Enter; then an empty or unparsable
 * draft REVERTS to the current value, and a number is clamped once.
 */
export function commitNumber(draft: string, current: number, spec: NumberSpec = {}): number {
  const trimmed = draft.trim()
  if (trimmed === '') return current
  const raw = Number(trimmed)
  if (!Number.isFinite(raw)) return current
  if (spec.zeroMeansOff && raw === 0) return 0
  let n = spec.integer === false ? raw : Math.round(raw)
  if (spec.min !== undefined && n < spec.min) n = spec.min
  if (spec.max !== undefined && n > spec.max) n = spec.max
  return n
}

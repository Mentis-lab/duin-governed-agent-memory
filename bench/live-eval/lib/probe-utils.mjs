// probe-utils.mjs — the small vocabulary every probe module speaks.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A measured result. `t0` (ms epoch) yields `ms`. */
export function res(id, pass, evidence, t0) {
  return { id, pass: !!pass, evidence, ...(t0 ? { ms: Date.now() - t0 } : {}) }
}

/** Could not run here; excluded from the lane total. */
export function skip(id, why) {
  return { id, pass: null, skipped: true, evidence: why }
}

/** Measured, but the contract has not landed yet; recorded, excluded from the score. */
export function unverified(id, observedPass, evidence, why, t0) {
  return { id, pass: !!observedPass, unverified: true, evidence: { unverifiedBecause: why, ...(typeof evidence === 'object' && evidence ? evidence : { evidence }) }, ...(t0 ? { ms: Date.now() - t0 } : {}) }
}

/** Does an answer honestly report a missing file / absent fact? (tools/l6_run.py task E) */
export const NOT_FOUND_RE =
  /not found|does not exist|doesn't exist|no such file|not exist|ENOENT|missing|unable to|cannot|can't|could not|couldn't|no file|isn't there|is not there|not present/i

/** Files under `dir` (recursive) whose UTF-8 text contains `needle`. Relative paths. */
export function findFilesContaining(dir, needle) {
  const hits = []
  const walk = (d, rel) => {
    let names
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(d, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const r = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) walk(full, r)
      else if (st.size < 4 * 1024 * 1024) {
        try {
          if (readFileSync(full, 'utf8').includes(needle)) hits.push(r)
        } catch {
          /* unreadable: not a hit */
        }
      }
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return hits
}

/** Files named `name` (exact basename) under `dir`, recursive. Relative paths. */
export function findFilesNamed(dir, name) {
  const hits = []
  const walk = (d, rel) => {
    let names
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const full = join(d, n)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const r = rel ? `${rel}/${n}` : n
      if (st.isDirectory()) walk(full, r)
      else if (n === name) hits.push(r)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return hits
}

export const readText = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Windows path for a prompt: the model sees the absolute path exactly as the OS spells it. */
export const winPath = (p) => String(p).replace(/\//g, '\\')

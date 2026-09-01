// save_strategy / save_mental_model (native) — persist a reviewed strategy or mental model into
// the guiding layer (strategies.json). Port of save_strategy (server.py:7232) + save_mental_model
// (7318). Deterministic find-or-append writes. Entries without a `type` are strategies.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { STRAT_KEYS, MODEL_TYPES, modelKeys } from './generate-strategy-native'

const strategiesPath = (v: string): string => join(v, '.duin', '_state', 'strategies.json')

function loadStrategies(v: string): Record<string, unknown>[] {
  try {
    const data = JSON.parse(readFileSync(strategiesPath(v), 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
function saveStrategies(v: string, data: Record<string, unknown>[]): void {
  const path = strategiesPath(v)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8') // Python json.dump(indent=2)
  renameSync(tmp, path)
}

const sectionsFor = (payload: Record<string, unknown>, keys: string[]): Record<string, string> | null => {
  if (!('sections' in payload)) return null
  const src = (payload.sections && typeof payload.sections === 'object' ? payload.sections : {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = String(src[k] ?? '')
  return out
}

export interface SaveResult {
  ok: boolean
  error?: string
  id?: string
}

/** Persist a strategy (Playing-to-Win). Port of save_strategy. */
export function saveStrategy(v: string | null, payload: Record<string, unknown>): SaveResult {
  const sid = String(payload.id ?? '').trim()
  if (!sid) return { ok: false, error: 'id required' }
  if (!v) return { ok: false, error: 'no vault' }
  const data = loadStrategies(v)
  const sec = sectionsFor(payload, STRAT_KEYS)
  const found = data.find((s) => s.id === sid)
  if (found) {
    if (sec) found.sections = sec
    for (const k of ['title', 'level', 'target']) if (k in payload) found[k] = payload[k]
  } else {
    data.push({
      id: sid, level: payload.level ?? 'project', target: payload.target ?? '',
      title: payload.title ?? sid, sections: sec ?? Object.fromEntries(STRAT_KEYS.map((k) => [k, '']))
    })
  }
  saveStrategies(v, data)
  return { ok: true, id: sid }
}

/** Persist a mental model of a given type. Port of save_mental_model. */
export function saveMentalModel(v: string | null, payload: Record<string, unknown>): SaveResult {
  const sid = String(payload.id ?? '').trim()
  if (!sid) return { ok: false, error: 'id required' }
  if (!v) return { ok: false, error: 'no vault' }
  const mtype = MODEL_TYPES.includes(String(payload.type)) ? String(payload.type) : 'strategy'
  const keys = modelKeys(mtype)
  const data = loadStrategies(v)
  const sec = sectionsFor(payload, keys)
  const found = data.find((s) => s.id === sid)
  if (found) {
    if (sec) found.sections = sec
    for (const k of ['title', 'type', 'level', 'target', 'summary']) if (k in payload) found[k] = payload[k]
  } else {
    data.push({
      id: sid, type: mtype, level: payload.level ?? 'general', target: payload.target ?? '',
      title: payload.title ?? sid, summary: payload.summary ?? '',
      sections: sec ?? Object.fromEntries(keys.map((k) => [k, '']))
    })
  }
  saveStrategies(v, data)
  return { ok: true, id: sid }
}

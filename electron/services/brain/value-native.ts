// value-native — TS port of server.py:list_value. The value-visible loop: DUIN's track
// record (saves/misses/verdicts parsed from the Friday value-digest.md) + decisions now DUE
// for a verdict (reviewOn <= today, via listDecisions). Pure read.
import { readFileSync } from 'fs'
import { join } from 'path'
import { listDecisions } from './decisions-native'

const isoOf = (d: Date): string => d.toISOString().slice(0, 10)

interface Track {
  decided: number | null
  reviewed: number | null
  surfaced: number | null
  pendingDue: number | null
  right?: number
  wrong?: number
  partial?: number
}

export function listValue(vaultDir: string | null, today: Date = new Date()): {
  digest: string
  track: Track | Record<string, never>
  saves: string[]
  misses: string[]
  dueForVerdict: { id: string; title: string; reviewOn: string }[]
  hasDigest: boolean
} {
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const todayIso = isoOf(t0)
  let digest = ''
  let track: Track | Record<string, never> = {}
  let saves: string[] = []
  let misses: string[] = []
  if (vaultDir) {
    try {
      digest = readFileSync(join(vaultDir, '.duin', '_state', 'value-digest.md'), 'utf-8').replace(/\r\n?/g, '\n')
    } catch {
      digest = ''
    }
  }
  if (digest) {
    const num = (labelRe: string): number | null => {
      const m = new RegExp(`${labelRe}\\D*\\*\\*(\\d+)\\*\\*`).exec(digest)
      return m ? parseInt(m[1], 10) : null
    }
    const tr: Track = {
      decided: num('decided'),
      reviewed: num('reviewed'),
      surfaced: num('DUIN-surfaced'),
      pendingDue: num('pending verdict \\(due\\)')
    }
    const vm = /verdicts:\s*(.+)/.exec(digest)
    if (vm) {
      for (const k of ['right', 'wrong', 'partial'] as const) {
        const km = new RegExp(`${k}\\s+(\\d+)`).exec(vm[1])
        if (km) tr[k] = parseInt(km[1], 10)
      }
    }
    track = tr
    const bullets = (header: string): string[] => {
      const seg = new RegExp(`###\\s*${header}[\\s\\S]*?(?=\\n###|\\n##|$)`).exec(digest)
      if (!seg) return []
      return seg[0]
        .split('\n')
        .slice(1)
        .filter((ln) => ln.trim().startsWith('-') || ln.trim().startsWith('*'))
        .map((ln) => ln.replace(/^[-*]\s*/, '').trim())
    }
    saves = bullets('✅ Saves')
    misses = bullets('⚠️ Misses')
  }
  const dueForVerdict = listDecisions(vaultDir)
    .decisions.filter((d) => d.reviewOn && d.reviewOn <= todayIso)
    .map((d) => ({ id: d.id, title: d.title, reviewOn: d.reviewOn }))
  return { digest, track, saves, misses, dueForVerdict, hasDigest: Boolean(digest) }
}

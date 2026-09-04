// fs-snap.mjs — directory snapshots so every claimed file effect is verified on disk, and so a
// stray write into the fixture vault (the 2026-09-02 S3 finding) is a measured failure.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** rel path → { size, mtimeMs } for every file under dir (posix separators). */
export function snapshotTree(dir) {
  const out = new Map()
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
      else out.set(r, { size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  walk(dir, '')
  return out
}

/** PURE. { added, removed, changed } between two snapshots. */
export function treeDelta(before, after) {
  const added = []
  const removed = []
  const changed = []
  for (const [k, v] of after) {
    const b = before.get(k)
    if (!b) added.push(k)
    else if (b.size !== v.size || b.mtimeMs !== v.mtimeMs) changed.push(k)
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

/** App-maintained state inside a vault — not a "write" a tool call made. `.trash` is NOT here:
 *  a tombstone of an out-of-vault file landing in the vault is exactly the S3 defect. */
export function isVaultAppState(rel) {
  return /^(\.duin|\.brain|\.obsidian)(\/|$)/.test(rel)
}

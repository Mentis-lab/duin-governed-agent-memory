// rsi-confinement.ts — path-confinement guard for the RSI self-improvement loop.
//
// Extracted to a dependency-free module so BOTH sides can enforce it without an import cycle:
// the propose-time gate (rsi-proposer.ts) AND the durable write sinks (self-improve-loop.ts).
// It previously lived only in rsi-proposer, and self-improve-loop importing from there would
// close a cycle (rsi-proposer already imports applyChange from self-improve-loop).
import { join, resolve, sep, dirname, basename } from 'path'
import { realpathSync } from 'fs'

/** Resolve to a REAL absolute path, defeating symlink / NTFS-junction traversal.
 *
 *  Until 2026-08-03 this guard was purely lexical (`resolve` + `startsWith`), so a junction planted
 *  at or under `<vault>/.duin/` that pointed outside the vault passed the check and
 *  `atomicWriteDurable` cheerfully followed it. The sibling guard in `ans/action-ledger.ts` had
 *  already learned this lesson ~200 lines away; this one had not.
 *
 *  Tolerates a target that does not exist yet — `rsi-tunables.json` legitimately does not on the
 *  first write, and neither may `_state/` — by walking up to the nearest EXISTING ancestor and
 *  re-appending the unresolved tail. The sibling only tries one level; walking is what makes a
 *  first write into a not-yet-created directory behave. */
function realResolve(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length > 0 ? join(real, ...tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs // reached the filesystem root with nothing real — stay lexical
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

/** targetPath must resolve inside <vault>/.duin/ — no arbitrary-path writes, and no escaping via a
 *  symlink or junction anywhere along either path. */
export function isConfinedToDuin(vault: string, targetPath: string): boolean {
  const root = realResolve(join(vault, '.duin')) + sep
  const t = realResolve(targetPath)
  return t.startsWith(root)
}

import { realpathSync } from 'fs'
import { resolve } from 'path'

const grantedDirectories = new Set<string>()

/** Record a directory selected through a native OS picker as a renderer trust grant.
 *  Recording is best-effort about realpath: a picker only ever returns a directory that
 *  exists, so a realpath failure here means something transient (a race, a permission
 *  quirk) — and failing the PICK because the bookkeeping step threw would break the one
 *  gesture that is unambiguous consent. Falls back to the resolved path; the lookup side
 *  still realpaths and so still fails closed on anything it cannot resolve. */
export function grantTrustedDirectory(candidate: string): string {
  let recorded: string
  try {
    recorded = realpathSync(candidate)
  } catch {
    recorded = resolve(candidate)
  }
  grantedDirectories.add(recorded)
  return recorded
}

/** Generic renderer settings cannot mint a new trust root; only a picker grant can. */
export function hasTrustedDirectoryGrant(candidate: string): boolean {
  try {
    return grantedDirectories.has(realpathSync(candidate))
  } catch {
    return false
  }
}

export function __resetTrustedDirectoryGrants(): void {
  grantedDirectories.clear()
}

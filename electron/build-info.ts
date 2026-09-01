// Build provenance — makes "which commit is this build?" answerable from the
// running app instead of by correlating `app.asar` mtimes against git log.
//
// The values are injected by electron.vite.config.ts as `define` string
// literals, so in any bundled build (packaged AND `electron-vite dev`) the
// `process.env.LAMPREY_BUILD_*` reads below are substituted at build time and
// never actually touch `process.env` at runtime. That is what lets the same
// module be imported from the sandboxed preload, where a real `process.env`
// lookup would be unavailable.
//
// Outside that pipeline (vitest, a plain `node out/main/index.js` smoke run, a
// source tarball built without git) the reads resolve to undefined and every
// field degrades to `unknown`. This surface is rendered in the About menu and
// served over HTTP, so it must never throw — hence no assertions and no
// required env.

export type BuildInfo = {
  /** package.json version at build time, e.g. `0.8.0`. */
  version: string
  /** Full 40-char commit SHA, or `unknown`. */
  sha: string
  /** First 7 chars of `sha`, or `unknown`. */
  shortSha: string
  /** Branch name at build time, or `unknown` (CI detached HEAD uses GITHUB_REF_NAME). */
  branch: string
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean
  /** ISO-8601 build timestamp, or `unknown`. */
  builtAt: string
}

export const UNKNOWN = 'unknown'

const env = (key: string): string => {
  // Read via a lookup rather than a static member expression for everything
  // except the five keys below — those must stay literal member expressions so
  // Vite's `define` can textually replace them.
  switch (key) {
    case 'sha':
      return (process.env.LAMPREY_BUILD_SHA ?? '').trim()
    case 'branch':
      return (process.env.LAMPREY_BUILD_BRANCH ?? '').trim()
    case 'time':
      return (process.env.LAMPREY_BUILD_TIME ?? '').trim()
    case 'version':
      return (process.env.LAMPREY_BUILD_VERSION ?? '').trim()
    case 'dirty':
      return (process.env.LAMPREY_BUILD_DIRTY ?? '').trim()
    default:
      return ''
  }
}

/** Resolve the build stamp. Cheap and allocation-only — safe to call per request. */
export function buildInfo(): BuildInfo {
  const sha = env('sha')
  return {
    version: env('version') || UNKNOWN,
    sha: sha || UNKNOWN,
    shortSha: sha ? sha.slice(0, 7) : UNKNOWN,
    branch: env('branch') || UNKNOWN,
    dirty: env('dirty') === '1',
    builtAt: env('time') || UNKNOWN
  }
}

/**
 * One-line human stamp, e.g. `v0.8.0 · 1a7e6a0 · 2026-07-25T13:04:35.000Z`.
 * A dirty build is marked so a hand-patched bundle can't masquerade as its
 * base commit. Unknown fields are omitted rather than printed as `unknown`,
 * except the SHA — a stamp with no commit at all should say so out loud.
 */
export function formatBuildStamp(info: BuildInfo = buildInfo()): string {
  const parts: string[] = []
  if (info.version !== UNKNOWN) parts.push(`v${info.version}`)
  parts.push(info.dirty ? `${info.shortSha}-dirty` : info.shortSha)
  if (info.builtAt !== UNKNOWN) parts.push(info.builtAt)
  return parts.join(' · ')
}

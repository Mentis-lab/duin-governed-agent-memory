import { PRODUCT_REPO_URL } from '@/lib/brand'

// Pure helpers behind the "DUIN on GitHub" section of Settings → GitHub. They live beside the
// page rather than in it because vitest here is node-only: the page reads window.api at
// import; these read nothing.

/** "owner/repo" of a github.com repository URL; null for anything else, including the empty
 *  PRODUCT_REPO_URL a private fork ships with. */
export function repoSlug(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null
  const [owner, repo] = u.pathname.split('/').filter(Boolean)
  if (!owner || !repo) return null
  return `${owner}/${repo.replace(/\.git$/, '')}`
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

interface ParsedVersion {
  nums: [number, number, number]
  pre: string[] | null
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const m = VERSION_RE.exec(value.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null }
}

function comparePre(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0
  if (!a) return 1 // a release outranks its own pre-releases
  if (!b) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xn) return -1
    else if (yn) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Semantic-version order: negative when a < b, positive when a > b, zero when equal, null when
 *  either side is not a version (a dev build reports `unknown`; a tag can be anything). A
 *  leading "v" is ignored and "0.8.0-tester.3" ranks below "0.8.0". */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  return comparePre(pa.pre, pb.pre)
}

/** True when `latest` is a newer version than `current`, false when it is the same or older,
 *  null when the two cannot be compared. */
export function isNewerVersion(current: string | null | undefined, latest: string | null | undefined): boolean | null {
  const c = compareVersions(latest, current)
  return c === null ? null : c > 0
}

/** The Platform option of .github/ISSUE_TEMPLATE/bug_report.yml for a Node platform string.
 *  The strings must match the form's options exactly or GitHub leaves the field blank. */
export function platformLabel(platform: string | undefined): string | null {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS (Apple Silicon)'
    case 'linux':
      return 'Linux'
    default:
      return null
  }
}

/** The repository's bug-report form with the version and platform fields filled in. GitHub
 *  issue forms take a field's id as a query parameter; the OS version and the steps stay the
 *  reporter's. Null when the build has no public repository. */
export function bugReportUrl(
  version: string | null | undefined,
  platform: string | undefined,
  repoUrl: string = PRODUCT_REPO_URL
): string | null {
  if (!repoSlug(repoUrl)) return null
  const params = ['template=bug_report.yml']
  const v = typeof version === 'string' ? version.trim() : ''
  if (v && v !== 'unknown') params.push(`version=${encodeURIComponent(v.startsWith('v') ? v : `v${v}`)}`)
  const label = platformLabel(platform)
  if (label) params.push(`platform=${encodeURIComponent(label)}`)
  return `${repoUrl.replace(/\/+$/, '')}/issues/new?${params.join('&')}`
}

/** Whether a connected token can star. Classic OAuth scopes name it (`repo` or `public_repo`);
 *  an empty list means the scopes are unknown (the gh tool, fine-grained tokens), and GitHub
 *  itself is left to answer. */
export function canStar(scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true
  return scopes.includes('repo') || scopes.includes('public_repo')
}

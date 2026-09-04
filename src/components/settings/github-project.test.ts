import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bugReportUrl, canStar, compareVersions, isNewerVersion, platformLabel, repoSlug } from './github-project'

// The "DUIN on GitHub" section of Settings → GitHub. Node-only, pure helpers, per the
// PermissionsSettings.test.tsx convention.

const REPO = 'https://github.com/Mentis-lab/duin-governed-agent-memory'

describe('repoSlug', () => {
  it('reads owner/repo off a github.com URL', () => {
    expect(repoSlug(REPO)).toBe('Mentis-lab/duin-governed-agent-memory')
    expect(repoSlug(`${REPO}.git/`)).toBe('Mentis-lab/duin-governed-agent-memory')
  })

  it('is null for the empty URL a private fork ships with, and for anything not github.com', () => {
    expect(repoSlug('')).toBeNull()
    expect(repoSlug('https://gitlab.com/a/b')).toBeNull()
    expect(repoSlug('http://github.com/a/b')).toBeNull()
    expect(repoSlug('https://github.com/only-owner')).toBeNull()
  })
})

describe('compareVersions / isNewerVersion', () => {
  it('orders releases numerically, not lexically, and ignores a leading v', () => {
    expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(isNewerVersion('0.1.0', 'v0.2.0')).toBe(true)
    expect(isNewerVersion('0.2.0', 'v0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', 'v0.1.0')).toBe(false)
  })

  it('ranks a pre-release below its release', () => {
    expect(isNewerVersion('0.8.0-tester.3', '0.8.0')).toBe(true)
    expect(isNewerVersion('0.8.0', '0.8.0-tester.3')).toBe(false)
    expect(compareVersions('0.8.0-tester.3', '0.8.0-tester.10')).toBeLessThan(0)
  })

  it('answers null, not false, when a side is not a version', () => {
    expect(isNewerVersion('unknown', 'v0.1.0')).toBeNull()
    expect(isNewerVersion('0.1.0', 'nightly')).toBeNull()
    expect(isNewerVersion(null, undefined)).toBeNull()
  })
})

describe('bugReportUrl', () => {
  it('opens the bug form with the version and platform fields filled in', () => {
    expect(bugReportUrl('0.1.0', 'win32', REPO)).toBe(
      `${REPO}/issues/new?template=bug_report.yml&version=v0.1.0&platform=Windows`
    )
  })

  it('keeps a v the version already has, and encodes the macOS option', () => {
    const url = bugReportUrl('v0.2.0', 'darwin', 'https://github.com/o/r')
    expect(url).toContain('version=v0.2.0')
    expect(url).toContain('platform=macOS%20(Apple%20Silicon)')
  })

  it('leaves out what it does not know rather than sending "unknown"', () => {
    expect(bugReportUrl('unknown', 'freebsd', 'https://github.com/o/r')).toBe(
      'https://github.com/o/r/issues/new?template=bug_report.yml'
    )
    expect(bugReportUrl(null, undefined, 'https://github.com/o/r')).toBe(
      'https://github.com/o/r/issues/new?template=bug_report.yml'
    )
  })

  it('is null without a public repository', () => {
    expect(bugReportUrl('0.1.0', 'win32', '')).toBeNull()
  })
})

describe('platformLabel', () => {
  it('maps the platforms DUIN ships on and nothing else', () => {
    expect(platformLabel('win32')).toBe('Windows')
    expect(platformLabel('darwin')).toBe('macOS (Apple Silicon)')
    expect(platformLabel('linux')).toBe('Linux')
    expect(platformLabel('sunos')).toBeNull()
    expect(platformLabel(undefined)).toBeNull()
  })

  // GitHub prefills a dropdown only when the value matches an option exactly, so the labels
  // here are pinned to the form in the repository, not to a copy of it.
  it('matches the Platform options of .github/ISSUE_TEMPLATE/bug_report.yml exactly', () => {
    const form = readFileSync(join(process.cwd(), '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8')
    const block = /id:\s*platform[\s\S]*?options:\s*\n((?:\s+-\s+.*\n)+)/.exec(form)
    expect(block).not.toBeNull()
    const options = (block?.[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(options).toContain(platformLabel(platform))
    }
  })
})

describe('canStar', () => {
  it('needs repo or public_repo when the scopes are known, and defers to GitHub when they are not', () => {
    expect(canStar(['read:user', 'repo'])).toBe(true)
    expect(canStar(['public_repo'])).toBe(true)
    expect(canStar(['read:user'])).toBe(false)
    expect(canStar([])).toBe(true)
  })
})

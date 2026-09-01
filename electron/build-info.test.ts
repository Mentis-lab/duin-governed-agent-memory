import { describe, it, expect, afterEach } from 'vitest'
import { buildInfo, formatBuildStamp, UNKNOWN } from './build-info'

// Under vitest there is no electron-vite `define`, so the LAMPREY_BUILD_* keys
// are real (absent) env vars. That makes both halves of the contract testable:
// the unstamped fallback, and the stamped values a bundled build sees.
const KEYS = [
  'LAMPREY_BUILD_SHA',
  'LAMPREY_BUILD_BRANCH',
  'LAMPREY_BUILD_TIME',
  'LAMPREY_BUILD_VERSION',
  'LAMPREY_BUILD_DIRTY'
] as const

const clear = (): void => {
  for (const k of KEYS) delete process.env[k]
}

afterEach(clear)

describe('buildInfo', () => {
  it('degrades to `unknown` when nothing was stamped — never throws', () => {
    clear()
    expect(() => buildInfo()).not.toThrow()
    expect(buildInfo()).toEqual({
      version: UNKNOWN,
      sha: UNKNOWN,
      shortSha: UNKNOWN,
      branch: UNKNOWN,
      dirty: false,
      builtAt: UNKNOWN
    })
  })

  it('reports the stamped commit, branch, version and build time', () => {
    clear()
    process.env.LAMPREY_BUILD_SHA = '1a7e6a069824fa41d16088f9d13c2e1fcd59cf13'
    process.env.LAMPREY_BUILD_BRANCH = 'fix/loose-ends'
    process.env.LAMPREY_BUILD_TIME = '2026-07-25T13:04:35.000Z'
    process.env.LAMPREY_BUILD_VERSION = '0.8.0'

    expect(buildInfo()).toEqual({
      version: '0.8.0',
      sha: '1a7e6a069824fa41d16088f9d13c2e1fcd59cf13',
      shortSha: '1a7e6a0',
      branch: 'fix/loose-ends',
      dirty: false,
      builtAt: '2026-07-25T13:04:35.000Z'
    })
  })

  it('treats an empty stamp the same as an absent one (unset CI secret)', () => {
    clear()
    process.env.LAMPREY_BUILD_SHA = ''
    process.env.LAMPREY_BUILD_VERSION = '   '
    expect(buildInfo().sha).toBe(UNKNOWN)
    expect(buildInfo().shortSha).toBe(UNKNOWN)
    expect(buildInfo().version).toBe(UNKNOWN)
  })

  it('flags a dirty tree only on the exact "1" marker', () => {
    clear()
    process.env.LAMPREY_BUILD_DIRTY = '1'
    expect(buildInfo().dirty).toBe(true)
    process.env.LAMPREY_BUILD_DIRTY = ''
    expect(buildInfo().dirty).toBe(false)
  })
})

describe('formatBuildStamp', () => {
  it('renders version · short sha · build time', () => {
    expect(
      formatBuildStamp({
        version: '0.8.0',
        sha: '1a7e6a069824fa41d16088f9d13c2e1fcd59cf13',
        shortSha: '1a7e6a0',
        branch: 'main',
        dirty: false,
        builtAt: '2026-07-25T13:04:35.000Z'
      })
    ).toBe('v0.8.0 · 1a7e6a0 · 2026-07-25T13:04:35.000Z')
  })

  it('marks a dirty build so it cannot masquerade as its base commit', () => {
    expect(
      formatBuildStamp({
        version: '0.8.0',
        sha: 'abcdef1234567890',
        shortSha: 'abcdef1',
        branch: 'main',
        dirty: true,
        builtAt: '2026-07-25T13:04:35.000Z'
      })
    ).toBe('v0.8.0 · abcdef1-dirty · 2026-07-25T13:04:35.000Z')
  })

  it('says `unknown` out loud rather than pretending, when nothing was stamped', () => {
    clear()
    expect(formatBuildStamp()).toBe(UNKNOWN)
  })
})

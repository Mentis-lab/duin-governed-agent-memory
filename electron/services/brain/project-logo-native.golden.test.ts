// GOLDEN lock for the _logo_slug / _project_logo_url port. The slug drives the
// `logo` field on project nodes in the brain graph; its CJK handling (keep
// U+4E00–U+9FFF, strip everything else) differs from _slug and is easy to get
// wrong. Expected values hand-derived from the Python regex, not the code.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logoSlug, projectLogoUrl, saveProjectLogo, clearProjectLogo } from './project-logo-native'

describe('project-logo-native — golden (_logo_slug / _project_logo_url parity)', () => {
  it('logoSlug: keeps CJK, collapses non-alnum runs, defaults to "project"', () => {
    expect(logoSlug('北澜')).toBe('北澜') // CJK preserved verbatim
    expect(logoSlug('北澜 · 国内渠道')).toBe('北澜-国内渠道') // space + middot run → single '-'
    expect(logoSlug('DUIN')).toBe('DUIN') // ascii preserved (no lowercasing, unlike _slug)
    expect(logoSlug('  《北澜》  ')).toBe('北澜') // edge '-' stripped (《》 are non-CJK-ideograph punctuation)
    expect(logoSlug('!!!')).toBe('project') // all-stripped → default
    expect(logoSlug('a__b--c')).toBe('a-b-c')
  })

  it('projectLogoUrl: URL iff <slug>.png exists in the injected dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-logo-'))
    try {
      writeFileSync(join(dir, '北澜.png'), 'x')
      expect(projectLogoUrl(dir, '北澜')).toBe('/project-logos/北澜.png')
      expect(projectLogoUrl(dir, 'DUIN')).toBeNull() // no DUIN.png
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('saveProjectLogo/clearProjectLogo round-trip; guards empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-logo2-'))
    try {
      expect(saveProjectLogo(dir, '', Buffer.from('x'))).toEqual({ ok: false, error: 'project required' })
      expect(saveProjectLogo(dir, '北澜', Buffer.alloc(0))).toEqual({ ok: false, error: 'empty file' })
      expect(saveProjectLogo(dir, '北澜', Buffer.from('PNGDATA'))).toEqual({ ok: true, project: '北澜', logo: '/project-logos/北澜.png' })
      expect(projectLogoUrl(dir, '北澜')).toBe('/project-logos/北澜.png')
      expect(clearProjectLogo(dir, '北澜')).toEqual({ ok: true, project: '北澜' })
      expect(projectLogoUrl(dir, '北澜')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

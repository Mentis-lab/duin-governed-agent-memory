// updater-identity.test.ts — regression cover for the 2026-07-25 P0.
//
// The shipped installer's update feed pointed at USS-Parks/lamprey: the repo DUIN's BRANCH lives
// in, not the repo DUIN releases from. That feed publishes a different product on its own version
// line — Lamprey-x64.exe at 0.27.1 against DUIN's 0.8.0 — so electron-updater read it as an
// upgrade. With autoDownload and autoInstallOnAppQuit both on, and updater errors deliberately
// suppressed from the UI, a packaged DUIN would have silently replaced itself with another product
// on next quit. Nothing in the update path asked whether the artifact was even DUIN's.
//
// Repointing the feed fixes this instance. This guard fixes the CLASS: an update whose artifact
// isn't DUIN's own is refused no matter what feed served it, and it fails CLOSED on anything it
// cannot identify.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { updateIsOwnProduct, EXPECTED_ARTIFACT_PREFIX } from './updater'

describe('update artifact identity guard', () => {
  it('accepts DUIN\'s own artifact', () => {
    expect(
      updateIsOwnProduct({ path: 'DUIN-x64.exe', files: [{ url: 'DUIN-x64.exe' }] })
    ).toBe(true)
  })

  it('REFUSES the exact payload that caused the P0', () => {
    // Verbatim from the live USS-Parks/lamprey feed on 2026-07-25.
    expect(
      updateIsOwnProduct({
        version: '0.27.1',
        path: 'Lamprey-x64.exe',
        files: [{ url: 'Lamprey-x64.exe' }]
      })
    ).toBe(false)
  })

  it('refuses a mixed manifest — one foreign file is enough', () => {
    expect(
      updateIsOwnProduct({
        path: 'DUIN-x64.exe',
        files: [{ url: 'DUIN-x64.exe' }, { url: 'Lamprey-x64.exe' }]
      })
    ).toBe(false)
  })

  it('fails CLOSED on an unidentifiable manifest', () => {
    // No names to check means no evidence this is ours. Refusing costs a missed update;
    // accepting cost the whole product.
    expect(updateIsOwnProduct({ version: '9.9.9' })).toBe(false)
    expect(updateIsOwnProduct({ files: [] })).toBe(false)
    expect(updateIsOwnProduct(null)).toBe(false)
    expect(updateIsOwnProduct(undefined)).toBe(false)
  })

  it('is case-insensitive and tolerates a path-qualified url', () => {
    expect(updateIsOwnProduct({ path: 'duin-arm64.exe' })).toBe(true)
    expect(updateIsOwnProduct({ files: [{ url: 'releases/download/v0.8.0/DUIN-x64.exe' }] })).toBe(true)
  })

  it('does not accept a name that merely CONTAINS the product name', () => {
    // "NotDUIN-x64.exe" / "Lamprey-DUIN-x64.exe" must not pass a substring check.
    expect(updateIsOwnProduct({ path: 'NotDUIN-x64.exe' })).toBe(false)
    expect(updateIsOwnProduct({ path: 'Lamprey-DUIN-x64.exe' })).toBe(false)
  })

  it('the expected prefix matches electron-builder artifactName (${productName}-)', () => {
    expect(EXPECTED_ARTIFACT_PREFIX).toBe('DUIN-')
  })
})

// 2026-07-27 — the 07-25 guard was NOT sufficient, proven in the field.
//
// It only ran on `update-available`. An artifact downloaded by an EARLIER build re-fires
// `update-downloaded` on the next launch, and that handler announced it unconditionally — so the
// operator was shown "Update available (v0.27.1) — restart to install" for upstream Lamprey, with
// a Restart button wired to quitAndInstall(). A staged `pending/Lamprey-x64.exe` (287.9 MB) was
// found in the updater cache, armed by autoInstallOnAppQuit to install on the next quit.
//
// These handlers need an Electron app to mount, so the invariants are asserted against the SOURCE
// — the same idiom the repo uses elsewhere for choke points it cannot unit-mount.
describe('updater install path — every route to an install is identity-guarded', () => {
  const src = readFileSync(join(__dirname, 'updater.ts'), 'utf-8')

  it('guards update-downloaded, not just update-available', () => {
    const downloaded = src.slice(src.indexOf("on('update-downloaded'"))
    const body = downloaded.slice(0, downloaded.indexOf('})'))
    expect(body).toMatch(/updateIsOwnProduct\(info\)/)
    // and refuses before announcing it to the renderer
    expect(body.indexOf('updateIsOwnProduct')).toBeLessThan(body.indexOf("send('update:downloaded'"))
  })

  it('never installs on quit without an explicit decision', () => {
    expect(src).toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=\s*false/)
    expect(src).not.toMatch(/autoInstallOnAppQuit\s*=\s*true/)
  })

  it('quitAndInstall refuses unless THIS session verified the download', () => {
    const fn = src.slice(src.indexOf('export async function quitAndInstall'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/verifiedDownloadReady/)
    // The refusal must precede the CALL, or the guard is decorative. Match
    // `autoUpdater.quitAndInstall()` specifically — bare `quitAndInstall()` also matches
    // this function's own signature (`quitAndInstall(): Promise<void>`) and would pass
    // vacuously against the declaration rather than the call.
    expect(body.indexOf('verifiedDownloadReady')).toBeLessThan(
      body.indexOf('autoUpdater.quitAndInstall()')
    )
    expect(body).toContain('autoUpdater.quitAndInstall()')
  })

  it('only a guard-passing download arms the install flag', () => {
    const set = src.indexOf('verifiedDownloadReady = true')
    expect(set).toBeGreaterThan(-1)
    // it is set inside the downloaded handler, AFTER the identity check
    const guard = src.indexOf('updateIsOwnProduct(info)', src.indexOf("on('update-downloaded'"))
    expect(guard).toBeLessThan(set)
  })
})

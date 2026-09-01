import { describe, it, expect } from 'vitest'
import { resolveExportPath, isFullHtmlDocument } from './artifact-export'

// Pure export-path shaping + document detection. The electron-dependent write/PDF
// paths are not exercised here (they need the Electron main process — human-verify).

describe('resolveExportPath', () => {
  it('rejects an empty path', () => {
    const r = resolveExportPath('   ', 'html')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/output path is required/)
  })
  it('keeps a matching extension', () => {
    const r = resolveExportPath('C:/out/report.html', 'html')
    expect(r.ok && r.path).toMatch(/report\.html$/)
  })
  it('appends the extension when absent', () => {
    const r = resolveExportPath('C:/out/report', 'pdf')
    expect(r.ok && r.path).toMatch(/report\.pdf$/)
  })
  it('swaps an html→pdf mismatch instead of double-appending', () => {
    const r = resolveExportPath('C:/out/report.html', 'pdf')
    expect(r.ok && r.path).toMatch(/report\.pdf$/)
    expect(r.ok && r.path).not.toMatch(/\.html/)
  })
  it('swaps a pdf→html mismatch', () => {
    const r = resolveExportPath('/tmp/deck.pdf', 'html')
    expect(r.ok && r.path).toMatch(/deck\.html$/)
    expect(r.ok && r.path).not.toMatch(/\.pdf/)
  })
  it('leaves an unrelated extension in place and appends', () => {
    // e.g. "notes.txt" → export as html should not strip .txt, it appends .html
    const r = resolveExportPath('notes.txt', 'html')
    expect(r.ok && r.path).toMatch(/notes\.txt\.html$/)
  })
})

describe('isFullHtmlDocument', () => {
  it('detects a full document by <html> or <!doctype>', () => {
    expect(isFullHtmlDocument('<!DOCTYPE html><html><body>x</body></html>')).toBe(true)
    expect(isFullHtmlDocument('<html lang="en"><body>x</body></html>')).toBe(true)
  })
  it('treats a bare fragment as not-full', () => {
    expect(isFullHtmlDocument('<div class="card">hi</div>')).toBe(false)
    expect(isFullHtmlDocument('just text')).toBe(false)
  })
})

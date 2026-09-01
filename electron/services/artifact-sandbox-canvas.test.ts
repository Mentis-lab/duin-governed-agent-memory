import { describe, expect, it, vi } from 'vitest'

// artifact-sandbox imports electron at module scope for the WebContentsView it
// manages. buildHtmlDoc itself is pure, so a minimal mock is enough to reach it.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:/app', getPath: () => 'C:/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {}
}))

import { buildHtmlDoc } from './artifact-sandbox'

const canvas = (obj: unknown): string => JSON.stringify(obj)

describe('buildHtmlDoc — canvas', () => {
  it('renders a canvas document into a full HTML page with the canvas styles', () => {
    const html = buildHtmlDoc(
      'canvas',
      canvas({
        nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 60, text: 'Ship it' }]
      })
    )
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('.cv-block')
    expect(html).toContain('Ship it')
  })

  it('escapes vault text — a canvas must not be able to inject markup', () => {
    const html = buildHtmlDoc(
      'canvas',
      canvas({
        nodes: [
          {
            id: 'a',
            type: 'text',
            x: 0,
            y: 0,
            width: 200,
            height: 60,
            text: '</div><script>alert(1)</script>'
          }
        ]
      })
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders a readable message for malformed JSON instead of throwing', () => {
    // A throw here would break the panel for EVERY artifact type, not just this.
    expect(() => buildHtmlDoc('canvas', 'not json')).not.toThrow()
    const html = buildHtmlDoc('canvas', 'not json')
    expect(html).toContain('Could not read this canvas')
  })

  it('escapes the error message too', () => {
    const html = buildHtmlDoc('canvas', '<img src=x>')
    expect(html).not.toContain('<img src=x>')
  })

  it('handles an empty canvas without an error state', () => {
    const html = buildHtmlDoc('canvas', '{}')
    expect(html).toContain('This canvas is empty')
    expect(html).not.toContain('Could not read')
  })

  it('leaves the other artifact types untouched', () => {
    expect(buildHtmlDoc('svg', '<svg/>')).toContain('<svg/>')
    expect(buildHtmlDoc('mermaid', 'graph TD')).toContain('class="mermaid"')
  })
})

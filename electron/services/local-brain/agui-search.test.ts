import { describe, it, expect } from 'vitest'
import { formatCascadeResults } from './agui-search'
import type { WebSearchResult } from '../web-search-adapters'

function r(title: string, url: string, snippet = ''): WebSearchResult {
  return { title, url, snippet }
}

describe('agui-search — formatCascadeResults', () => {
  it('renders ordered title/url/snippet blocks with a [via …] provenance footer', () => {
    const out = formatCascadeResults(
      [r('Alpha', 'https://a.example', 'first snippet'), r('Beta', 'https://b.example', 'second')],
      ['brave', 'tavily']
    )
    expect(out).toBe(
      'Alpha\nhttps://a.example\nfirst snippet\n\nBeta\nhttps://b.example\nsecond\n\n[via brave, tavily]'
    )
  })

  it('omits the snippet line when a result has none', () => {
    const out = formatCascadeResults([r('NoSnip', 'https://x.example')], ['brave'])
    expect(out).toBe('NoSnip\nhttps://x.example\n\n[via brave]')
  })

  it('omits the footer when no providers were used', () => {
    const out = formatCascadeResults([r('T', 'https://t.example', 's')], [])
    expect(out).toBe('T\nhttps://t.example\ns')
  })

  it('truncates to maxChars with a marker', () => {
    const long = formatCascadeResults([r('T'.repeat(50), 'https://u.example', 'x'.repeat(200))], ['brave'], 40)
    expect(long.endsWith('\n\n[…truncated…]')).toBe(true)
    expect(long.length).toBe(40 + '\n\n[…truncated…]'.length)
  })

  it('empty results → empty string (caller falls back to the DDG scrape)', () => {
    expect(formatCascadeResults([], [])).toBe('')
  })
})

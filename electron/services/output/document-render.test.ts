import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  renderInline,
  renderMarkdownToHtml,
  renderMarkdownToPrintHtml
} from './document-render'

// Pure markdown → print-HTML renderer. Fixture in → clean HTML out. No electron.

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderInline', () => {
  it('renders bold, italic, and inline code', () => {
    expect(renderInline('a **b** c')).toBe('a <strong>b</strong> c')
    expect(renderInline('a *b* c')).toBe('a <em>b</em> c')
    expect(renderInline('use `code` here')).toBe('use <code>code</code> here')
  })
  it('does not expand markdown inside inline code', () => {
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>')
  })
  it('renders safe links and drops unsafe schemes', () => {
    expect(renderInline('[site](https://example.com)')).toBe(
      '<a href="https://example.com">site</a>'
    )
    // javascript: scheme is dropped, keeping just the text.
    expect(renderInline('[x](javascript:evil)')).toBe('x')
    expect(renderInline('[y](data:text/html;base64,AAA)')).toBe('y')
  })
})

describe('renderMarkdownToHtml', () => {
  it('renders headings by level', () => {
    const out = renderMarkdownToHtml('# H1\n\n## H2\n\n### H3')
    expect(out).toContain('<h1>H1</h1>')
    expect(out).toContain('<h2>H2</h2>')
    expect(out).toContain('<h3>H3</h3>')
  })

  it('renders an unordered list as a single <ul>', () => {
    const out = renderMarkdownToHtml('- one\n- two\n- three')
    expect(out).toBe('<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>')
  })

  it('renders an ordered list as a single <ol>', () => {
    const out = renderMarkdownToHtml('1. first\n2. second')
    expect(out).toBe('<ol>\n<li>first</li>\n<li>second</li>\n</ol>')
  })

  it('closes a list when a blank line then a paragraph follows', () => {
    const out = renderMarkdownToHtml('- a\n- b\n\nAfter the list.')
    expect(out).toContain('</ul>')
    expect(out).toContain('<p>After the list.</p>')
    // list is closed before the paragraph opens
    expect(out.indexOf('</ul>')).toBeLessThan(out.indexOf('<p>'))
  })

  it('renders a fenced code block with escaped contents (no inline expansion)', () => {
    const out = renderMarkdownToHtml('```\nconst x = 1 < 2 && **k**\n```')
    expect(out).toBe('<pre><code>const x = 1 &lt; 2 &amp;&amp; **k**</code></pre>')
  })

  it('renders a blockquote joining continuation lines', () => {
    const out = renderMarkdownToHtml('> quoted line one\n> line two')
    expect(out).toBe('<blockquote>quoted line one line two</blockquote>')
  })

  it('renders a horizontal rule', () => {
    expect(renderMarkdownToHtml('---')).toBe('<hr>')
  })

  it('coalesces wrapped lines into one paragraph and expands inline markup', () => {
    const out = renderMarkdownToHtml('This is **bold**\nand wrapped.')
    expect(out).toBe('<p>This is <strong>bold</strong> and wrapped.</p>')
  })

  it('escapes raw HTML in prose (no injection)', () => {
    const out = renderMarkdownToHtml('a <script>alert(1)</script> b')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })
})

describe('renderMarkdownToPrintHtml', () => {
  it('produces a full standalone document with the title and print CSS', () => {
    const html = renderMarkdownToPrintHtml('Body text.', { title: 'My Report' })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<title>My Report</title>')
    // auto <h1> header from the title
    expect(html).toContain('<h1>My Report</h1>')
    expect(html).toContain('<p>Body text.</p>')
    expect(html).toContain('@page')
  })

  it('suppresses the auto heading when heading:false', () => {
    const html = renderMarkdownToPrintHtml('# Own Title\n\nx', {
      title: 'Meta',
      heading: false
    })
    expect(html).not.toContain('<h1>Meta</h1>')
    expect(html).toContain('<h1>Own Title</h1>')
  })

  it('falls back to a default <title> when none given', () => {
    const html = renderMarkdownToPrintHtml('hello')
    expect(html).toContain('<title>Document</title>')
    expect(html).not.toMatch(/<h1>\s*<\/h1>/)
  })
})

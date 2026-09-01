import { describe, expect, it } from 'vitest'
import { htmlToText } from './html'

describe('htmlToText', () => {
  it('strips tags, keeping visible text', () => {
    const { text } = htmlToText('<h1>Hello</h1><p>World body</p>')
    expect(text).toContain('Hello')
    expect(text).toContain('World body')
    expect(text).not.toMatch(/<[^>]+>/)
  })
  it('drops script/style/noscript content entirely', () => {
    const { text } = htmlToText('<style>.a{color:red}</style><script>var x=1</script><p>keep me</p>')
    expect(text).toContain('keep me')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('var x')
  })
  it('extracts the <title> for the doc title', () => {
    expect(htmlToText('<title>My Deck</title><body>x</body>').title).toBe('My Deck')
  })
  it('falls back to the first <h1> for the title', () => {
    expect(htmlToText('<body><h1>Intro Guide</h1><p>x</p></body>').title).toBe('Intro Guide')
  })
  it('decodes common entities', () => {
    expect(htmlToText('<p>A &amp; B &lt;tag&gt; &quot;q&quot;</p>').text).toContain('A & B <tag> "q"')
  })
  it('turns block boundaries into newlines (readable text)', () => {
    const { text } = htmlToText('<p>one</p><p>two</p>')
    expect(text.split('\n').filter(Boolean)).toEqual(['one', 'two'])
  })
  it('strips a truncated trailing tag (model cut HTML mid-tag)', () => {
    const { text } = htmlToText('<title>Deck</title><body><h1>Title</h1><p>body</p><h2 style="col')
    expect(text).toContain('Title')
    expect(text).toContain('body')
    expect(text).not.toContain('<h2')
    expect(text).not.toContain('<h1')
  })
  it('handles a full document with head noise', () => {
    const doc = '<!DOCTYPE html><html><head><title>Deck</title><style>body{margin:0}</style></head><body><h1>Slide 1</h1><p>Point A</p></body></html>'
    const { text, title } = htmlToText(doc)
    expect(title).toBe('Deck')
    expect(text).toContain('Slide 1')
    expect(text).toContain('Point A')
    expect(text).not.toContain('margin:0')
  })
})

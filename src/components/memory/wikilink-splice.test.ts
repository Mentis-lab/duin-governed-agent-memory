// Backlog finding 13 (critical). Picking a [[note]] suggestion wrote straight to
// textarea.value and dispatched a bare input event. React installs its OWN value setter
// plus a _valueTracker, so that assignment updated the tracker too — React then compared
// tracker to node, saw them equal, and fired no onChange. The link appeared in the
// textarea, controlled state never learned about it, and Save (which reads state, not
// the DOM) wrote the note without it.
//
// The DOM half of that fix — calling the prototype's native setter to leave the tracker
// stale — cannot be asserted here: this repo's vitest env has no jsdom, so there is no
// React and no tracker to observe. What IS testable is the text edit itself, which is
// why it was extracted.

import { describe, it, expect } from 'vitest'
import { spliceWikilink } from './wikilink-splice'

describe('spliceWikilink', () => {
  it('replaces the half-typed link before the caret', () => {
    const v = 'see [[dai'
    expect(spliceWikilink(v, v.length, 'daily-note')).toEqual({
      text: 'see [[daily-note]]',
      caret: 'see [[daily-note]]'.length
    })
  })

  it('keeps the text after the caret', () => {
    const v = 'see [[dai and more'
    const caret = 'see [[dai'.length
    const r = spliceWikilink(v, caret, 'daily-note')
    expect(r.text).toBe('see [[daily-note]] and more')
    // Caret lands right after the inserted link, not at the end of the line.
    expect(r.caret).toBe('see [[daily-note]]'.length)
  })

  it('completes an empty [[ with no typed prefix', () => {
    const v = 'x [['
    expect(spliceWikilink(v, v.length, 'note').text).toBe('x [[note]]')
  })

  it('only touches the LAST open [[ before the caret', () => {
    const v = '[[done]] then [[par'
    expect(spliceWikilink(v, v.length, 'partial').text).toBe('[[done]] then [[partial]]')
  })

  it('does nothing when there is no open [[ before the caret', () => {
    const v = 'no link here'
    expect(spliceWikilink(v, v.length, 'note')).toEqual({ text: v, caret: v.length })
  })

  it('will not reach across a newline for an opener', () => {
    // The pattern excludes newlines, so a bracket on an earlier line is not "open".
    const v = '[[stale\nnow typing'
    expect(spliceWikilink(v, v.length, 'note').text).toBe(v)
  })

  it('clamps a caret outside the string instead of producing junk', () => {
    const v = 'a [[b'
    expect(spliceWikilink(v, 999, 'note').text).toBe('a [[note]]')
    expect(spliceWikilink(v, -5, 'note').text).toBe(v)
  })
})

import { describe, it, expect } from 'vitest'
import { stripAnsi } from './strip-ansi'

// Regression pin for the escape that leaked into the DOM: the reasoning card
// rendered a literal "1m" because a tool-sourced \u001b[1m reached it unstripped.

describe('stripAnsi', () => {
  it('removes the bold sequence that leaked into the reasoning card', () => {
    expect(stripAnsi('\u001b[1mplanning\u001b[0m the next step')).toBe('planning the next step')
  })

  it('leaves the visible text alone, including the bare letter m', () => {
    expect(stripAnsi('\u001b[1m')).toBe('')
    expect(stripAnsi('1m')).toBe('1m')
    expect(stripAnsi('m')).toBe('m')
  })

  it('handles colour, cursor and multi-parameter sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[39m')).toBe('red')
    expect(stripAnsi('\u001b[2Kclear')).toBe('clear')
    expect(stripAnsi('\u001b[1;32;40mstyled\u001b[0m')).toBe('styled')
    expect(stripAnsi('\u001b[?25lhidden\u001b[?25h')).toBe('hidden')
  })

  it('returns clean input unchanged (identity, not a copy-through)', () => {
    const clean = 'searching the vault for "budget" — 12 hits'
    expect(stripAnsi(clean)).toBe(clean)
    expect(stripAnsi('')).toBe('')
  })

  it('preserves newlines and markdown, which the card renders', () => {
    expect(stripAnsi('\u001b[1m## Step\n- one\n- two\u001b[0m')).toBe('## Step\n- one\n- two')
  })

  it('strips a sequence split across the middle of a word', () => {
    expect(stripAnsi('re\u001b[0mason')).toBe('reason')
  })
})


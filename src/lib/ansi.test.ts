import { describe, it, expect } from 'vitest'
import { stripAnsi } from './ansi'
import { stripAnsi as stripAnsiMain } from '../../electron/shared/strip-ansi'

// src/lib/ansi.ts is a deliberate mirror of electron/shared/strip-ansi.ts: the
// renderer bundle has no runtime import path into electron/ (only the ambient
// LampreyAPI type), the same arrangement as electron/brand.ts <-> src/lib/brand.ts.
// A mirror can drift, so pin the two copies to identical behaviour here.

const CASES = [
  '\u001b[1mplanning\u001b[0m the next step',
  '\u001b[31mred\u001b[39m',
  '\u001b[2Kclear',
  '\u001b[1;32;40mstyled\u001b[0m',
  '\u001b[?25lhidden\u001b[?25h',
  're\u001b[0mason',
  '\u001b[1m## Step\n- one\n- two\u001b[0m',
  '1m',
  'm',
  '',
  'searching the vault for "budget" — 12 hits'
]

describe('renderer stripAnsi', () => {
  it('removes the bold sequence that leaked into the reasoning card', () => {
    expect(stripAnsi('\u001b[1mplanning\u001b[0m the next step')).toBe('planning the next step')
  })

  it('does not eat a literal "1m" that the user actually typed', () => {
    expect(stripAnsi('1m')).toBe('1m')
  })

  it.each(CASES)('behaves identically to the main-process copy for %j', (input) => {
    expect(stripAnsi(input)).toBe(stripAnsiMain(input))
  })
})

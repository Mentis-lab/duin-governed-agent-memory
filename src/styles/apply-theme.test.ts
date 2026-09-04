import { describe, it, expect } from 'vitest'
import {
  fontScaleRatio,
  BASE_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  chatFontSizePx,
  DEFAULT_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MAX_CHAT_FONT_SIZE,
  docFontSizePx,
  DEFAULT_DOC_FONT_SIZE,
  MIN_DOC_FONT_SIZE,
  MAX_DOC_FONT_SIZE
} from './apply-theme'

describe('fontScaleRatio', () => {
  it('maps the base font size to 100%', () => {
    expect(fontScaleRatio(BASE_FONT_SIZE)).toBe(1)
  })

  it('scales up and down proportionally', () => {
    expect(fontScaleRatio(16)).toBeCloseTo(16 / 14)
    expect(fontScaleRatio(12)).toBeCloseTo(12 / 14)
    expect(fontScaleRatio(20)).toBeCloseTo(20 / 14)
  })

  it('clamps out-of-range sizes to the supported band', () => {
    expect(fontScaleRatio(2)).toBeCloseTo(MIN_FONT_SIZE / BASE_FONT_SIZE)
    expect(fontScaleRatio(999)).toBeCloseTo(MAX_FONT_SIZE / BASE_FONT_SIZE)
  })

  it('falls back to 100% for missing or invalid input', () => {
    expect(fontScaleRatio(undefined)).toBe(1)
    expect(fontScaleRatio(NaN)).toBe(1)
    // @ts-expect-error deliberate misuse
    expect(fontScaleRatio('big')).toBe(1)
  })
})

describe('chatFontSizePx', () => {
  // The transcript size is its OWN setting, not page zoom. Zoom scales chrome and
  // content together, so it can never change how large the chat reads relative to the
  // UI around it — which is the thing people actually want to adjust.
  it('passes a supported size through', () => {
    expect(chatFontSizePx(16)).toBe(16)
  })

  it('falls back to the default for missing / NaN input', () => {
    expect(chatFontSizePx(undefined)).toBe(DEFAULT_CHAT_FONT_SIZE)
    expect(chatFontSizePx(Number.NaN)).toBe(DEFAULT_CHAT_FONT_SIZE)
  })

  it('clamps out-of-range values rather than rendering an unreadable transcript', () => {
    expect(chatFontSizePx(2)).toBe(MIN_CHAT_FONT_SIZE)
    expect(chatFontSizePx(400)).toBe(MAX_CHAT_FONT_SIZE)
  })

  it('defaults to the size the transcript was previously hardcoded at', () => {
    // 12px was the constant in markdown.css, so an install that has never touched the
    // new control renders exactly as before.
    expect(DEFAULT_CHAT_FONT_SIZE).toBe(12)
  })
})

describe('docFontSizePx', () => {
  // Documents are the third size, distinct from both page zoom and the transcript:
  // a note read in the Explorer panel, in its own window, in Library, or as an
  // artifact. Before this control they were three different hardcoded numbers.
  it('passes a supported size through', () => {
    expect(docFontSizePx(18)).toBe(18)
  })

  it('falls back to the default for missing / NaN input', () => {
    expect(docFontSizePx(undefined)).toBe(DEFAULT_DOC_FONT_SIZE)
    expect(docFontSizePx(Number.NaN)).toBe(DEFAULT_DOC_FONT_SIZE)
  })

  it('clamps out-of-range values rather than rendering an unreadable document', () => {
    expect(docFontSizePx(1)).toBe(MIN_DOC_FONT_SIZE)
    expect(docFontSizePx(900)).toBe(MAX_DOC_FONT_SIZE)
  })

  it("defaults to .markdown-body's own reading base", () => {
    // 16px is what Library and the artifact viewer already rendered at; the Explorer
    // panel (12px) and a detached window (14px) are the two that were out of step.
    expect(DEFAULT_DOC_FONT_SIZE).toBe(16)
  })

  it('is a separate control from the transcript size', () => {
    // Same input, different setting — a regression that collapsed one into the other
    // would make the chat and document toggles move together. Their defaults differ
    // (16 vs 12) and so do their upper bounds (28 vs 24).
    expect(docFontSizePx(undefined)).not.toBe(chatFontSizePx(undefined))
    expect(docFontSizePx(999)).not.toBe(chatFontSizePx(999))
  })
})

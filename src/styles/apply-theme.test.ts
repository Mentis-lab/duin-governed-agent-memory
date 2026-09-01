import { describe, it, expect } from 'vitest'
import {
  fontScaleRatio,
  BASE_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  chatFontSizePx,
  DEFAULT_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  MAX_CHAT_FONT_SIZE
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

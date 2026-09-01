import { describe, it, expect } from 'vitest'
import {
  panelBranch,
  panelFromResult,
  panelLoading,
  panelError,
  panelReady,
  isEmptyData
} from './panel-state'
import { ok, err } from './result'

describe('panelBranch', () => {
  it('THE invariant: a failed read is never the empty branch', () => {
    // This is the whole audit finding. DecisionsPanel rendered "No decisions on
    // record yet" over a ledger it could not reach; PermissionsSettings asserted
    // "No conversation policies" on a security surface after a failed read.
    expect(panelBranch(panelError<string[]>('brain unreachable'))).toBe('error')
    expect(panelBranch(panelReady<string[]>([]))).toBe('empty')
  })

  it('an in-flight read is loading, never empty', () => {
    expect(panelBranch(panelLoading<string[]>())).toBe('loading')
  })

  it('populated data is ready', () => {
    expect(panelBranch(panelReady(['a']))).toBe('ready')
  })

  it('honours a domain-specific emptiness test', () => {
    const state = panelReady({ decisions: [] as string[], cascades: [] as string[] })
    expect(panelBranch(state)).toBe('ready') // default: object with keys is not empty
    expect(panelBranch(state, (d) => d.decisions.length === 0 && d.cascades.length === 0)).toBe(
      'empty'
    )
  })
})

describe('panelFromResult', () => {
  it('lifts ok:false into the error phase carrying the sentence', () => {
    const s = panelFromResult(err('decisions: state 500'))
    expect(s.phase).toBe('error')
    if (s.phase === 'error') expect(s.error).toBe('decisions: state 500')
  })

  it('lifts an empty success into ready — emptiness is still data', () => {
    const s = panelFromResult(ok<string[]>([]))
    expect(s).toEqual({ phase: 'ready', data: [] })
    expect(panelBranch(s)).toBe('empty')
  })
})

describe('isEmptyData', () => {
  it('is conservative — only genuinely empty containers count', () => {
    expect(isEmptyData([])).toBe(true)
    expect(isEmptyData({})).toBe(true)
    expect(isEmptyData(null)).toBe(true)
    expect(isEmptyData(undefined)).toBe(true)
    expect(isEmptyData(new Map())).toBe(true)
    expect(isEmptyData([0])).toBe(false)
    expect(isEmptyData({ count: 0 })).toBe(false)
    expect(isEmptyData(0)).toBe(false)
    expect(isEmptyData('')).toBe(false)
  })
})

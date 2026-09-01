import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveStrategy, saveMentalModel } from './strategy-save-native'
import { actFuture } from './future-act-native'

describe('strategy-save', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ss2-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects a missing id', () => {
    expect(saveStrategy(vault, {})).toEqual({ ok: false, error: 'id required' })
  })

  it('appends a new strategy with defaulted sections', () => {
    const r = saveStrategy(vault, { id: 's1', title: 'My strat', sections: { aspiration: 'a' } })
    expect(r).toEqual({ ok: true, id: 's1' })
    const data = JSON.parse(readFileSync(join(sd, 'strategies.json'), 'utf-8'))
    expect(data[0]).toMatchObject({ id: 's1', title: 'My strat', sections: { aspiration: 'a', where_to_play: '', how_to_win: '', capabilities: '', values: '' } })
  })

  it('updates an existing strategy in place', () => {
    writeFileSync(join(sd, 'strategies.json'), JSON.stringify([{ id: 's1', title: 'old', sections: {} }]))
    saveStrategy(vault, { id: 's1', title: 'new', level: 'company' })
    const data = JSON.parse(readFileSync(join(sd, 'strategies.json'), 'utf-8'))
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: 's1', title: 'new', level: 'company' })
  })

  it('saveMentalModel uses the type template keys', () => {
    saveMentalModel(vault, { id: 'm1', type: 'lens', title: 'Lens', sections: { lens: 'x' } })
    const data = JSON.parse(readFileSync(join(sd, 'strategies.json'), 'utf-8'))
    expect(data[0]).toMatchObject({ id: 'm1', type: 'lens', sections: { lens: 'x', reveals: '', prompts: '', watch_fors: '' } })
  })
})

describe('future-act — actFuture', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-fa-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'future-nodes.jsonl'), [
      JSON.stringify({ id: 'a', status: 'open' }),
      JSON.stringify({ id: 'b', status: 'open' })
    ].join('\n') + '\n')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  const load = (): Record<string, unknown>[] => readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

  it('engage → status engaged; pass → declined + kept:false; reset → open', () => {
    expect(actFuture(vault, 'a', 'engage')).toEqual({ ok: true, id: 'a', action: 'engage' })
    expect(load().find((n) => n.id === 'a')!.status).toBe('engaged')
    actFuture(vault, 'a', 'pass')
    expect(load().find((n) => n.id === 'a')).toMatchObject({ status: 'declined', kept: false })
    actFuture(vault, 'a', 'reset')
    expect(load().find((n) => n.id === 'a')!.status).toBe('open')
  })

  it('keep sets kept:true without changing status', () => {
    actFuture(vault, 'b', 'keep')
    expect(load().find((n) => n.id === 'b')).toMatchObject({ status: 'open', kept: true })
  })

  it('delete removes the node', () => {
    expect(actFuture(vault, 'a', 'delete')).toEqual({ ok: true, id: 'a', action: 'delete' })
    expect(load().map((n) => n.id)).toEqual(['b'])
  })
})

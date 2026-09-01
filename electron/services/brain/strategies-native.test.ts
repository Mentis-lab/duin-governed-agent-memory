import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listStrategies, listMentalModels } from './strategies-native'

describe('strategies-native', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-st-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('listStrategies returns the json array (else empty)', () => {
    writeFileSync(join(vault, '.duin', '_state', 'strategies.json'), JSON.stringify([{ id: 's1', title: 'win' }]))
    expect(listStrategies(vault)).toEqual({ strategies: [{ id: 's1', title: 'win' }] })
    rmSync(join(vault, '.duin', '_state', 'strategies.json'))
    expect(listStrategies(vault)).toEqual({ strategies: [] })
  })

  it('listMentalModels defaults missing type→strategy + always returns templates', () => {
    writeFileSync(join(vault, '.duin', '_state', 'strategies.json'), JSON.stringify([{ id: 'm1' }, { id: 'm2', type: 'lens' }]))
    const { models, templates } = listMentalModels(vault)
    expect((models[0] as { type: string }).type).toBe('strategy')
    expect((models[1] as { type: string }).type).toBe('lens')
    expect(templates.strategy[0]).toEqual({ key: 'aspiration', label: 'Goals & aspirations' })
    expect(Object.keys(templates)).toEqual(['strategy', 'principle', 'lens', 'framework', 'playbook'])
  })

  it('null vault → empty (models still has templates)', () => {
    expect(listStrategies(null)).toEqual({ strategies: [] })
    expect(listMentalModels(null).models).toEqual([])
    expect(listMentalModels(null).templates.lens.length).toBe(4)
  })
})

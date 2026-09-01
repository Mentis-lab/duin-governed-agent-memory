// strategies-native — TS port of server.py:list_strategies + list_mental_models.
// Both read `.duin/_state/strategies.json` (the guiding layer: Playing-to-Win cascades +
// principles/lenses/frameworks/playbooks). Pure reads.
import { readFileSync } from 'fs'
import { join } from 'path'

const strategiesPath = (v: string): string => join(v, '.duin', '_state', 'strategies.json')

const MODEL_TEMPLATES: Record<string, [string, string][]> = {
  strategy: [['aspiration', 'Goals & aspirations'], ['where_to_play', 'Where to play'], ['how_to_win', 'How to win'], ['capabilities', 'Capabilities'], ['values', 'Values / guardrails']],
  principle: [['statement', 'The principle'], ['why', 'Why it holds'], ['applies_when', 'When it applies'], ['examples', 'In practice']],
  lens: [['lens', 'The lens'], ['reveals', 'What it surfaces'], ['prompts', 'Questions it prompts'], ['watch_fors', 'Watch-fors']],
  framework: [['steps', 'The steps'], ['use_when', 'When to use it'], ['io', 'Inputs → outputs'], ['examples', 'In practice']],
  playbook: [['trigger', 'Trigger'], ['plays', 'Plays / steps'], ['watch_fors', 'Watch-fors'], ['examples', 'In practice']]
}

function readStrategies(vaultDir: string): Record<string, unknown>[] {
  try {
    const data = JSON.parse(readFileSync(strategiesPath(vaultDir), 'utf-8'))
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

export function listStrategies(vaultDir: string | null): { strategies: unknown[] } {
  if (!vaultDir) return { strategies: [] }
  return { strategies: readStrategies(vaultDir) }
}

export function listMentalModels(vaultDir: string | null): { models: unknown[]; templates: Record<string, { key: string; label: string }[]> } {
  const templates: Record<string, { key: string; label: string }[]> = {}
  for (const [k, v] of Object.entries(MODEL_TEMPLATES)) templates[k] = v.map(([key, label]) => ({ key, label }))
  if (!vaultDir) return { models: [], templates }
  const models = readStrategies(vaultDir).map((m) => ({ ...m, type: (m.type as string) || 'strategy' }))
  return { models, templates }
}

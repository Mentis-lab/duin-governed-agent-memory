import { t } from '@/lib/i18n'
import type { ReactElement } from 'react'
import { Button } from '@/components/ui/Button'

export function workflowScaffold(name = 'new-workflow'): string {
  return `export const meta = {
  name: '${name}',
  description: 'Describe what this workflow does.',
  phases: [
    { title: 'Plan', detail: 'Choose the agents and inputs' },
    { title: 'Run', detail: 'Collect agent outputs' }
  ]
}

phase('Plan')
log('Preparing workflow')

phase('Run')
const result = await agent('Summarize the current task and return the next concrete step.', {
  label: 'first-pass',
  agentType: 'general',
  model: 'cheap'
})

return { result }
`
}

interface MetaScaffolderProps {
  onInsert: (source: string) => void
}

export function MetaScaffolder({ onInsert }: MetaScaffolderProps): ReactElement {
  return (
    <Button variant="secondary" className="font-mono"
      onClick={() => onInsert(workflowScaffold())}
    >
      {t('Scaffold meta')}
    </Button>
  )
}

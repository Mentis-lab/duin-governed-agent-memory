import { t } from '@/lib/i18n'
import { SettingsPage } from '@/components/ui/settings'
import { AutomationsSettings } from './AutomationsSettings'
import { LoopSettings } from './LoopSettings'

// The "Automations" tab (id `workflows`) — the plain-language home for what DUIN does on its
// own. Two sections, and ONLY what is a setting:
//   • Scheduled — the two switches, the create form, and the list of scheduled prompts
//   • Loops     — the master switch and the ceilings every new loop is born with
// The capability breaker and the governor's record that used to make this a 4,600 px page are
// monitoring, not settings; they live in the Governance tab of the Automations hub now.
// The title is drawn by SettingsDialog from the tab label.
export function WorkflowsSettings(): React.ReactElement {
  return (
    <SettingsPage
      purpose={t('What DUIN does on its own: prompts that run on a schedule, and loops that keep working toward a goal. The capability breaker and what the governor has done are in the Governance tab of the Automations hub.')}
    >
      <AutomationsSettings />
      <LoopSettings />
    </SettingsPage>
  )
}

import { t } from '@/lib/i18n'
import { NumberRow, SettingsSection, ToggleRow } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'

// Settings → Automations, section "Loops": the master switch and the five ceilings every new
// loop is born with. The loop controller and loop-config.ts read these fresh on every tick,
// so a plain settings write is the whole mechanism. Loops ship OFF by default.
//
// Background autonomy — the switch that lets loops AND schedules run unattended — sits in the
// Scheduled section above, directly under the schedule switch, because a schedule fires only
// when both are on. The capability breaker and the governor's record that used to live below
// the ceilings are monitoring, not settings; they moved to the Governance tab of the
// Automations hub (src/components/automations/GovernancePanel.tsx).

const DEFAULTS = {
  loopMaxIterations: 25,
  loopMaxWallclockMin: 30, // 1_800_000 ms
  loopTokenBudget: 500000,
  loopMaxConcurrent: 1,
  loopMinIntervalSeconds: 30
}

/** One switch arms FOUR things: the automations runner, the loop runner, the goal-automation
 *  bridge, and the RSI self-improve loop that rewrites DUIN's own retrieval config. Only the first
 *  three were legible from the toggle's label, and the fourth is the one an operator would most
 *  want to be asked about — its first write lands ~60 seconds after boot, not on some distant
 *  schedule. Naming the consequence is the point; a toggle that silently starts a program editing
 *  its own configuration is not informed consent.
 *
 *  Exported (with the predicate below) so it is unit-testable — this repo's vitest env is node-only
 *  with no jsdom, so pane behaviour lives in pure helpers by convention. The Scheduled section
 *  (AutomationsSettings) owns the switch and shows this through t() at confirm time. */
export const AUTONOMY_CONFIRM_MESSAGE =
  'Turn on background autonomy?\n\n' +
  'This lets scheduled loops run unattended and execute tools that write files in your vault.\n\n' +
  "It also starts DUIN's self-improvement loop, which edits its OWN configuration files under " +
  '<vault>/.duin/ on a timer — the first write lands about a minute after the app starts. Those ' +
  'changes are limited to two bounded retrieval settings, are snapshotted before every write, and ' +
  'can be undone.\n\n' +
  'You can turn this off again at any time.'

/** Confirm on the way ON only. A kill switch you have to argue with is not a kill switch, so
 *  turning autonomy OFF must always be one click. */
export function autonomyChangeNeedsConfirm(next: boolean): boolean {
  return next === true
}

export function LoopSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const enabled = settings.loopsEnabled ?? false
  const maxIterations = settings.loopMaxIterations ?? DEFAULTS.loopMaxIterations
  const maxWallclockMin = Math.round((settings.loopMaxWallclockMs ?? 1_800_000) / 60_000)
  const tokenBudget = settings.loopTokenBudget ?? DEFAULTS.loopTokenBudget
  const maxConcurrent = settings.loopMaxConcurrent ?? DEFAULTS.loopMaxConcurrent
  const minIntervalSeconds = settings.loopMinIntervalSeconds ?? DEFAULTS.loopMinIntervalSeconds

  return (
    <SettingsSection
      label={t('Loops')}
      description={t('A loop runs a turn again and again until a goal or a ceiling is reached, even with the window closed. Start one from chat with /loop. Manage running loops in the Loops tab of the Automations hub.')}
    >
      <ToggleRow
        label={t('Enable loops')}
        hint={
          enabled
            ? t('On: loops can be created and will run. Running unattended also needs Background autonomy, above.')
            : t('Off: /loop and loop creation are refused.')
        }
        checked={enabled}
        onChange={(next) => updateSettings({ loopsEnabled: next })}
      />
      <NumberRow
        label={t('Max iterations')}
        hint={t('Hard stop: a loop ends after this many turns, whatever is left in its backlog.')}
        value={maxIterations}
        defaultValue={DEFAULTS.loopMaxIterations}
        spec={{ min: 1 }}
        unit={t('iterations')}
        disabled={!enabled}
        onCommit={(n) => updateSettings({ loopMaxIterations: n })}
      />
      <NumberRow
        label={t('Max wall-clock')}
        hint={t('Hard stop: a loop ends once this much real time has passed since it started.')}
        value={maxWallclockMin}
        defaultValue={DEFAULTS.loopMaxWallclockMin}
        spec={{ min: 1 }}
        unit={t('minutes')}
        disabled={!enabled}
        onCommit={(n) => updateSettings({ loopMaxWallclockMs: n * 60_000 })}
      />
      <NumberRow
        label={t('Token budget')}
        hint={t('Soft stop: a loop ends once its estimated token use crosses this. 0 means no budget; the two hard stops above still apply.')}
        value={tokenBudget}
        defaultValue={DEFAULTS.loopTokenBudget}
        spec={{ min: 0 }}
        unit={t('tokens (0 = off)')}
        disabled={!enabled}
        onCommit={(n) => updateSettings({ loopTokenBudget: n })}
      />
      <NumberRow
        label={t('Max concurrent loops')}
        hint={t('How many loops may advance at once. 1 keeps parallel loops from flooding your provider.')}
        value={maxConcurrent}
        defaultValue={DEFAULTS.loopMaxConcurrent}
        spec={{ min: 1 }}
        unit={t('loops')}
        disabled={!enabled}
        onCommit={(n) => updateSettings({ loopMaxConcurrent: n })}
      />
      <NumberRow
        label={t('Runaway floor')}
        hint={t('The soonest a loop may schedule its next turn. Prevents a tight self-scheduling spin.')}
        value={minIntervalSeconds}
        defaultValue={DEFAULTS.loopMinIntervalSeconds}
        spec={{ min: 1 }}
        unit={t('seconds')}
        disabled={!enabled}
        onCommit={(n) => updateSettings({ loopMinIntervalSeconds: n })}
      />
    </SettingsSection>
  )
}

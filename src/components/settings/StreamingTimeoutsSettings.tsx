import { t } from '@/lib/i18n'
import { NumberRow, SettingsSection } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'

// The time-budget caps of the turn-execution stack, as one section of the Engine page.
// Numbers are stored in settings.json (milliseconds) and read fresh by the matching
// back-end services (provider/registry.ts, mcp-manager.ts) on every call, so no IPC
// patch is needed. Main clamps a non-zero value to a 5 s floor; 0 turns a cap off.

const DEFAULTS = {
  streamInactivitySec: 60,
  mcpCallTimeoutSec: 120
}

const SPEC = { min: 5, zeroMeansOff: true }

function secondsToMsOrZero(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0
  return Math.round(sec * 1000)
}

function msToSeconds(ms: number | undefined, fallback: number): number {
  if (ms == null) return fallback
  if (ms <= 0) return 0
  return Math.max(0, Math.round(ms / 1000))
}

export function StreamingTimeoutsSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const streamInactivitySec = msToSeconds(settings.streamInactivityMs, DEFAULTS.streamInactivitySec)
  const mcpCallTimeoutSec = msToSeconds(settings.mcpCallTimeoutMs, DEFAULTS.mcpCallTimeoutSec)

  return (
    <SettingsSection
      label={t('Streaming and timeouts')}
      description={t('These caps stop a stalled provider or a hung MCP server from holding a turn open forever. 0 turns a cap off; anything below 5 seconds is raised to 5.')}
    >
      <NumberRow
        label={t('Stream inactivity timeout')}
        hint={t('How long the reply stream may go without receiving anything before DUIN aborts it and retries.')}
        value={streamInactivitySec}
        spec={SPEC}
        unit={t('seconds (0 = off)')}
        defaultValue={DEFAULTS.streamInactivitySec}
        onCommit={(sec) => updateSettings({ streamInactivityMs: secondsToMsOrZero(sec) })}
      />
      <NumberRow
        label={t('MCP tool call timeout')}
        hint={t('The longest a single MCP tool call may take. Tools that report progress reset the clock; 0 uses the MCP default.')}
        value={mcpCallTimeoutSec}
        spec={SPEC}
        unit={t('seconds (0 = off)')}
        defaultValue={DEFAULTS.mcpCallTimeoutSec}
        onCommit={(sec) => updateSettings({ mcpCallTimeoutMs: secondsToMsOrZero(sec) })}
      />
    </SettingsSection>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { PanelState } from '@/components/ui/PanelState'
import { SettingsLoadError, SettingsLoading, SettingsRow, SettingsSection } from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { panelError, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import {
  breakerLine,
  governFactLine,
  rungLabel,
  trippedCapabilities,
  undoConfirmMessage,
  undoableActions,
  type BreakerCap,
  type GovernActionRow,
  type GovernFactRow,
  type ImprovementRow
} from './governance-helpers'

// Governance — the Automations hub tab for what the governor has done and what it may still
// do. Two surfaces, both monitoring: the capability BREAKER (a capability drops a rung the
// moment one of its actions is reverted, and only the operator can re-arm it) and the
// governor's RECORD (the rules its jury ruled on, the writes that can still be undone, and
// the improvements it would like to make to itself). Read-only apart from Re-arm and Undo.
//
// Lived under Settings → Automations until 2026-09-03; nothing here is a setting.

type AuditData = {
  generatedAt: number
  facts: GovernFactRow[]
  actions: GovernActionRow[]
  undoTarget: string | null
}

const autonomyApi = (): typeof window.api.brain.autonomy | undefined => window.api?.brain?.autonomy
const governApi = (): typeof window.api.brain.govern | undefined => window.api?.brain?.govern

const MUTED = 'text-[12px] text-[var(--text-muted)]'

export function GovernancePanel(): React.ReactElement {
  return (
    <div className="flex flex-col gap-6 p-3">
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        {t('What the governor has done on its own, and the two things you can do about it: re-arm a capability it tripped, or undo a change it made.')}
      </p>
      <CapabilityBreaker />
      <GovernanceRecord />
    </div>
  )
}

/**
 * The capability breaker.
 *
 * The governor trips a capability the instant it takes an unhandled miss and never restores
 * one. The restore path existed but had no caller anywhere in the renderer, so a tripped
 * capability stayed tripped forever and the only way back was a hand-written POST. Re-arm
 * restores the capability's floor rung in one step, because the question this answers is
 * "have you looked at it and is it fit to run", not "what grade has it earned".
 */
function CapabilityBreaker(): React.ReactElement | null {
  const [caps, setCaps] = useState<PanelStatus<BreakerCap[]>>(panelLoading())
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await query<{ capabilities: BreakerCap[] }>(t('the capability breaker'), autonomyApi()?.state)
    setCaps(r.ok ? panelReady(r.data.capabilities) : panelError(r.error, r.cause))
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!autonomyApi()) return null // desktop-only surface

  const rearm = async (c: BreakerCap): Promise<void> => {
    setBusy(c.id)
    try {
      const data = await invoke<{ ok: boolean; reason?: string }>(t('re-arm'), () =>
        window.api.brain.autonomy.rearm(c.id)
      )
      if (data.ok) toast.success(tf('{name} is armed again.', { name: c.title }))
      else toast.error(tf('Re-arm refused: {reason}', { reason: data.reason ?? t('no reason given') }))
    } catch (e) {
      toast.error(describeError(e, t('Could not re-arm that capability.')))
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <SettingsSection
      label={t('Capability breaker')}
      description={t('A capability drops a rung the moment one of its actions is reverted. Nothing moves it back on its own: re-arming is yours, and it restores the capability fully.')}
    >
      <PanelState
        state={caps}
        loading={<SettingsLoading what={t('the capability breaker')} />}
        error={(message, retry) => (
          <SettingsLoadError what={t('the capability breaker')} message={message} onRetry={retry} />
        )}
        empty={<p className={MUTED}>{t('Nothing is tripped — every capability is at its most autonomous allowed setting.')}</p>}
        isEmpty={(list) => trippedCapabilities(list).length === 0}
        onRetry={() => void load()}
      >
        {(list) => (
          <>
            {trippedCapabilities(list).map((c) => (
              <SettingsRow
                key={c.id}
                label={c.title}
                hint={breakerLine(c)}
                control={
                  <Button size="sm" disabled={busy === c.id} onClick={() => void rearm(c)}>
                    {busy === c.id ? t('Re-arming…') : tf('Re-arm to {rung}', { rung: rungLabel(c.floorRung) })}
                  </Button>
                }
              />
            ))}
          </>
        )}
      </PanelState>
    </SettingsSection>
  )
}

function GovernanceRecord(): React.ReactElement | null {
  const [audit, setAudit] = useState<PanelStatus<AuditData>>(panelLoading())
  const [proposals, setProposals] = useState<PanelStatus<ImprovementRow[]>>(panelLoading())
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const api = governApi()
    const [a, p] = await Promise.all([
      query<AuditData>(t('the governor audit'), api?.audit),
      query<{ shadow: boolean; proposals: ImprovementRow[] }>(t('proposed improvements'), api?.improvements)
    ])
    setAudit(a.ok ? panelReady(a.data) : panelError(a.error, a.cause))
    setProposals(p.ok ? panelReady(p.data.proposals ?? []) : panelError(p.error, p.cause))
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!governApi()) return null // desktop-only surface

  const undo = async (a: GovernActionRow): Promise<void> => {
    // The demote is the part the button does not show, so it is confirmed for.
    if (typeof window.confirm === 'function' && !window.confirm(undoConfirmMessage(a))) return
    setBusy(true)
    try {
      await invoke(t('undo'), () => window.api.brain.govern.undo(a.id))
      toast.success(t('Undone. The capability that made that change was demoted.'))
    } catch (e) {
      toast.error(describeError(e, t('Could not undo that action.')))
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <>
      <PanelState
        state={audit}
        loading={<SettingsLoading what={t('the governor audit')} />}
        error={(message, retry) => <SettingsLoadError what={t('the governor audit')} message={message} onRetry={retry} />}
        empty={null}
        isEmpty={() => false}
        onRetry={() => void load()}
      >
        {(data) => {
          const undoable = undoableActions(data.actions ?? [])
          return (
            <>
              <SettingsSection
                label={t('Adjudicated rules')}
                description={t('Which learned rules the jury confirmed, held, or reverted, and how strong each check was.')}
              >
                {data.facts.length === 0 ? (
                  <p className={MUTED}>{t('The jury has not ruled on any rule yet.')}</p>
                ) : (
                  data.facts.slice(0, 20).map((f) => <SettingsRow key={f.id} label={f.fact} hint={governFactLine(f)} />)
                )}
              </SettingsSection>

              <SettingsSection
                label={t('Reversible actions')}
                description={t('Changes the brain made on its own that you can still take back. Undo also demotes the capability that made the change.')}
              >
                {undoable.length === 0 ? (
                  <p className={MUTED}>
                    {t('Nothing is currently undoable — the brain has made no reversible write since the last undo.')}
                  </p>
                ) : (
                  undoable.map((a) => (
                    <SettingsRow
                      key={a.id}
                      label={
                        <>
                          {a.actionKind}
                          {a.id === data.undoTarget && (
                            <span className="ml-1.5 font-mono text-[10px] font-normal text-[var(--text-muted)]">
                              {t('(most recent)')}
                            </span>
                          )}
                        </>
                      }
                      hint={`${a.capabilityId} · ${new Date(a.ts).toLocaleString()}`}
                      control={
                        <Button size="sm" disabled={busy} onClick={() => void undo(a)}>
                          {busy ? t('Undoing…') : t('Undo')}
                        </Button>
                      }
                    />
                  ))
                )}
              </SettingsSection>
            </>
          )
        }}
      </PanelState>

      <SettingsSection
        label={t('Proposed improvements')}
        description={t('What DUIN would like to change about itself. Nothing here is applied.')}
      >
        <PanelState
          state={proposals}
          loading={<SettingsLoading what={t('proposed improvements')} />}
          error={(message, retry) => <SettingsLoadError what={t('proposed improvements')} message={message} onRetry={retry} />}
          empty={<p className={MUTED}>{t('The self-improvement pass has nothing to propose.')}</p>}
          onRetry={() => void load()}
        >
          {(list) => (
            <>
              {list.map((p) => (
                <SettingsRow
                  key={`${p.type}:${p.targetId}`}
                  label={
                    <>
                      <span className="mr-1.5 font-mono text-[11px] font-normal text-[var(--text-muted)]">{p.type}</span>
                      {p.target}
                    </>
                  }
                  hint={p.rationale}
                />
              ))}
            </>
          )}
        </PanelState>
      </SettingsSection>
    </>
  )
}

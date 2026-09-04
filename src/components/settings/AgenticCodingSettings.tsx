import { useEffect, useMemo } from 'react'
import { t, tf } from '@/lib/i18n'
import { SettingsPage, SettingsSection, ToggleRow } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { useSkillsStore } from '@/stores/skills-store'

// Coding mode is exactly two things: the coding contract role layered on every turn, and the
// bundled workflow skills that turn on with it. The title is drawn by SettingsDialog from the
// tab label ("Coding Mode"), so this page uses that one name and no other.

const BUNDLED_WORKFLOW_SKILL_IDS = new Set(['context', 'debug', 'fan-out', 'frontend-qa', 'plan', 'review', 'verify'])

export function AgenticCodingSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const skills = useSkillsStore((s) => s.skills)
  const loadSkills = useSkillsStore((s) => s.loadSkills)

  useEffect(() => {
    if (skills.length === 0) void loadSkills()
  }, [skills.length, loadSkills])

  // Only the bundled workflow skills are eligible — the contract role is "coding" and these are
  // its curated companions. Custom skills stay reachable from the regular skill panel.
  const workflowSkills = useMemo(() => skills.filter((s) => BUNDLED_WORKFLOW_SKILL_IDS.has(s.id)), [skills])

  const modeOn = settings.agenticCodingMode
  const selected = new Set(settings.agenticCodingSkills)

  const setSkill = (id: string, on: boolean): Promise<boolean> => {
    const current = settings.agenticCodingSkills
    const next = on ? (selected.has(id) ? current : [...current, id]) : current.filter((x) => x !== id)
    return updateSettings({ agenticCodingSkills: next })
  }

  return (
    <SettingsPage purpose={t('DUIN behaves as a coding assistant on every turn and turns on the skills below.')}>
      <ToggleRow
        label={t('Coding mode')}
        hint={t('Off by default. When off, DUIN answers as usual and none of the skills below turn on by themselves.')}
        checked={modeOn}
        onChange={(next) => updateSettings({ agenticCodingMode: next })}
      />

      <SettingsSection
        label={t('Skills that turn on with Coding mode')}
        description={t('Added to every turn while Coding mode is on. Skills you turned on yourself stay on, with no duplicates.')}
      >
        {workflowSkills.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            {tf('No bundled workflow skills are installed yet. Put the bundled {skills} SKILL.md files into your skills folder.', {
              skills: 'plan, context, verify'
            })}
          </p>
        ) : (
          workflowSkills.map((skill) => (
            <ToggleRow
              key={skill.id}
              label={skill.name}
              hint={
                <>
                  {skill.description}
                  {skill.description ? ' ' : ''}
                  <span className="font-mono text-[11px] uppercase tracking-wider">{skill.id}</span>
                </>
              }
              checked={selected.has(skill.id)}
              disabled={!modeOn}
              onChange={(next) => setSkill(skill.id, next)}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

import { t } from '@/lib/i18n'
import { SettingsSection } from '@/components/ui/settings'
import type { HookEvent } from '@/stores/hooks-store'

export interface HookTemplate {
  id: string
  /** English; rendered through t() and stored as the new hook's label. */
  label: string
  event: HookEvent
  /** English; rendered through t(). */
  description: string
  timeoutMs: number
  code: string
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: 'block-shell-in-prod',
    label: 'Block shell in prod',
    event: 'preToolUse',
    description: 'Stops destructive shell commands when the current folder looks production-like.',
    timeoutMs: 3000,
    code:
      'const command = String(args?.command ?? "")\n' +
      'const target = String(cwd ?? "")\n' +
      'const isProd = /prod|production|release/i.test(target)\n' +
      'const isRisky = /\\b(rm|del|Remove-Item|git\\s+reset)\\b/i.test(command)\n' +
      '\n' +
      'if (toolName === "shell_command" && isProd && isRisky) {\n' +
      '  throw `Blocked risky shell command in ${target}`\n' +
      '}\n' +
      '\n' +
      'log("shell command allowed", command.slice(0, 120))'
  },
  {
    id: 'log-tools-to-memory',
    label: 'Log tools to memory',
    event: 'postToolUse',
    description: 'Records a compact audit line for each tool call result.',
    timeoutMs: 5000,
    code:
      'const renderedArgs = JSON.stringify(args ?? {})\n' +
      'const renderedResult = String(result ?? "").slice(0, 160)\n' +
      'log(`[tool] ${toolName} ${renderedArgs} => ${renderedResult}`)'
  },
  {
    id: 'auto-format-on-write',
    label: 'Auto-format on write',
    event: 'postToolUse',
    description:
      'Detects file-writing tool results and leaves a formatter reminder in the hook log.',
    timeoutMs: 4000,
    code:
      'const name = String(toolName ?? "")\n' +
      'const command = String(args?.command ?? "")\n' +
      'const writesFile = /apply_patch|write|edit|Set-Content|Out-File/i.test(name + " " + command)\n' +
      '\n' +
      'if (writesFile) {\n' +
      '  log("format-check recommended after file write", { toolName, cwd })\n' +
      '}'
  }
]

// The template labels and descriptions above are looked up through t() at render time.
// Listed here as literals so the coverage test sees the keys.
function templateLabel(template: HookTemplate): string {
  switch (template.id) {
    case 'block-shell-in-prod':
      return t('Block shell in prod')
    case 'log-tools-to-memory':
      return t('Log tools to memory')
    case 'auto-format-on-write':
      return t('Auto-format on write')
    default:
      return t(template.label)
  }
}

function templateDescription(template: HookTemplate): string {
  switch (template.id) {
    case 'block-shell-in-prod':
      return t('Stops destructive shell commands when the current folder looks production-like.')
    case 'log-tools-to-memory':
      return t('Records a compact audit line for each tool call result.')
    case 'auto-format-on-write':
      return t('Detects file-writing tool results and leaves a formatter reminder in the hook log.')
    default:
      return t(template.description)
  }
}

interface HookTemplatesGalleryProps {
  activeEvent: HookEvent
  applyingId: string | null
  onApply: (template: HookTemplate) => void
  /** True while hooks are switched off under General: creating one is pointless. */
  disabled?: boolean
}

export function HookTemplatesGallery({
  activeEvent,
  applyingId,
  onApply,
  disabled
}: HookTemplatesGalleryProps): React.ReactElement {
  return (
    <SettingsSection
      label={t('Templates')}
      description={t('Create a ready-to-edit hook from a template. Templates for the selected event are outlined.')}
    >
      <div className="grid gap-2 md:grid-cols-3">
        {HOOK_TEMPLATES.map((template) => {
          const matchesEvent = template.event === activeEvent
          const applying = applyingId === template.id
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onApply(template)}
              disabled={disabled || applyingId !== null}
              aria-label={templateLabel(template)}
              className={
                'min-h-[86px] rounded-lg border bg-[var(--bg-primary)] p-3 text-left transition-colors disabled:opacity-50 ' +
                (matchesEvent
                  ? 'border-[var(--accent)]'
                  : 'border-[var(--panel-border)] hover:border-[var(--accent)]')
              }
            >
              <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                {templateLabel(template)}
              </span>
              <span className="mt-1 block font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
                {template.event} / {template.timeoutMs} ms
              </span>
              <span className="mt-1 block text-[12px] leading-snug text-[var(--text-muted)]">
                {applying ? t('Creating…') : templateDescription(template)}
              </span>
            </button>
          )
        })}
      </div>
    </SettingsSection>
  )
}

import { t, tf } from '@/lib/i18n'
import { useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import {
  NumberField,
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { toast } from '@/stores/toast-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import {
  useHooksStore,
  type Hook,
  type HookEvent,
  type HookLanguage,
  type HookSampleContext
} from '@/stores/hooks-store'
import { HookTemplatesGallery, type HookTemplate } from './HookTemplatesGallery'
import { HookTestRunner } from './HookTestRunner'

// Every event main can fire (hooks-event-parity.test.ts pins this list against the
// main-process union). loopStarted / loopIterationDone used to be offered here but
// nothing ever fired them, so they are gone from both sides.
const EVENT_OPTIONS: HookEvent[] = [
  'sessionStart',
  'promptSubmit',
  'preToolUse',
  'postToolUse',
  'agentStop',
  'automationStarted',
  'automationDone',
  'workflowStarted',
  'workflowFinished'
]

const OFFERED = new Set<string>(EVENT_OPTIONS)

function eventDescription(event: HookEvent): string {
  switch (event) {
    case 'sessionStart':
      return t('Runs once when DUIN starts.')
    case 'promptSubmit':
      return t('Runs when you send a message. Bindings: promptBody, conversationId.')
    case 'preToolUse':
      return t('Runs before any tool. Bindings: toolName, args, conversationId. Throw to block the call; the thrown message reaches the model as the tool result.')
    case 'postToolUse':
      return t('Runs after a tool returns. Bindings: toolName, args, result, conversationId. A throw here is logged but cannot undo the call.')
    case 'agentStop':
      return t('Runs when a reply finishes streaming. Bindings: conversationId.')
    case 'automationStarted':
      return t('Runs when a scheduled automation begins. Bindings: sourceId, label, promptBody.')
    case 'automationDone':
      return t('Runs when an automation finishes. Bindings: sourceId, label.')
    case 'workflowStarted':
      return t('Runs when a workflow run begins. Bindings: sourceId, label.')
    case 'workflowFinished':
      return t('Runs when a workflow run ends. Bindings: sourceId, label.')
    default:
      return ''
  }
}

const NEWLINE = String.fromCharCode(10)

const STARTER_TEMPLATE: Record<HookEvent, string> = {
  sessionStart: '// DUIN session started.\nlog("session started at", new Date().toISOString())',
  promptSubmit: '// Inspect or log the submitted prompt.\nlog("prompt:", promptBody?.slice(0, 80))',
  preToolUse:
    '// Block dangerous shell commands.\nif (toolName === "shell_command" && /rm\\s+-rf/.test(args?.command ?? "")) {\n  throw "rm -rf blocked by hook"\n}',
  postToolUse: '// Log every tool call.\nlog(toolName, "->", (result ?? "").slice(0, 120))',
  agentStop: '// Notify on completion.\nlog("run finished for", conversationId)',
  automationStarted: '// A scheduled automation started.' + NEWLINE + 'log("automation start:", label)',
  automationDone: '// A scheduled automation finished.' + NEWLINE + 'log("automation done:", label)',
  workflowStarted: '// A workflow run started.' + NEWLINE + 'log("workflow start:", label)',
  workflowFinished: '// A workflow run finished.' + NEWLINE + 'log("workflow done:", label)'
}

const DEFAULT_TIMEOUT_MS = 5000
/** One range for the timeout field. The old number box (100–60000) and slider (500–30000) disagreed. */
const TIMEOUT_SPEC = { min: 100, max: 60000 }

interface EditorState {
  hookId: string | null
  event: HookEvent
  label: string
  code: string
  language: HookLanguage
  timeoutMs: number
  enabled: boolean
}

function emptyEditor(event: HookEvent): EditorState {
  return {
    hookId: null,
    event,
    label: '',
    code: STARTER_TEMPLATE[event] ?? '',
    language: 'js',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    enabled: true
  }
}

function editorFromHook(h: Hook): EditorState {
  return {
    hookId: h.id,
    event: h.event,
    label: h.label,
    code: h.command,
    language: h.language,
    timeoutMs: h.timeoutMs,
    enabled: h.enabled
  }
}

/** True when the editor holds exactly what is saved (or the untouched starter). */
function sameEditor(a: EditorState, b: EditorState): boolean {
  return (
    a.hookId === b.hookId &&
    a.event === b.event &&
    a.label === b.label &&
    a.code === b.code &&
    a.timeoutMs === b.timeoutMs &&
    a.enabled === b.enabled
  )
}

const BINDINGS: Array<{ name: string; meaning: () => string }> = [
  { name: 'event', meaning: () => t('the event name') },
  { name: 'conversationId', meaning: () => t('the conversation the event belongs to') },
  { name: 'toolName', meaning: () => t('the tool about to run, or that just ran') },
  { name: 'args', meaning: () => t('the arguments passed to that tool') },
  { name: 'result', meaning: () => t('what the tool returned (postToolUse only)') },
  { name: 'promptBody', meaning: () => t('the text you sent (promptSubmit only)') },
  { name: 'cwd', meaning: () => t('the working folder') },
  { name: 'sourceId / label', meaning: () => t('the automation or workflow run behind the event') },
  { name: 'log(...)', meaning: () => t('write a line to the hook log') }
]

export function HooksSettings(): React.ReactElement {
  const hooks = useHooksStore((s) => s.hooks)
  const loaded = useHooksStore((s) => s.loaded)
  const loadError = useHooksStore((s) => s.error)
  const lastTest = useHooksStore((s) => s.lastTest)
  const load = useHooksStore((s) => s.load)
  const create = useHooksStore((s) => s.create)
  const update = useHooksStore((s) => s.update)
  const remove = useHooksStore((s) => s.remove)
  const test = useHooksStore((s) => s.test)
  const clearLastTest = useHooksStore((s) => s.clearLastTest)
  const confirmDiscard = useUiStore((s) => s.confirmDiscard)
  // The master switch lives on General. hooks-runner treats `enableHooks === false` as a
  // hard disable, so this page must say so instead of letting "Run sample" report it as
  // a sandbox error.
  const hooksOff = useSettingsStore((s) => s.settings.enableHooks === false)

  const [activeEvent, setActiveEvent] = useState<HookEvent>('preToolUse')
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor('preToolUse'))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null)
  const labelId = useId()
  const bodyId = useId()

  useEffect(() => {
    void load()
  }, [load])

  const hooksForEvent = useMemo(
    () => hooks.filter((h) => h.event === activeEvent),
    [hooks, activeEvent]
  )

  // Hooks stored against an event this build no longer offers (the two loop events)
  // cannot be listed under any tab; say so rather than hide them silently.
  const unlistedCount = useMemo(() => hooks.filter((h) => !OFFERED.has(h.event)).length, [hooks])

  const countsByEvent = useMemo(() => {
    const counts = Object.fromEntries(EVENT_OPTIONS.map((e) => [e, 0])) as Record<HookEvent, number>
    for (const hook of hooks) if (hook.event in counts) counts[hook.event]++
    return counts
  }, [hooks])

  // The editor is a draft: dirty when it differs from the saved hook it was opened from,
  // or from the untouched starter for a new one. Registered with the dirty guard so a tab
  // switch (or closing Settings) asks before the code is dropped; saving or starting a new
  // hook makes the two equal again, which clears it.
  const baseline = useMemo<EditorState | null>(() => {
    if (!editor.hookId) return emptyEditor(editor.event)
    const saved = hooks.find((h) => h.id === editor.hookId)
    return saved ? editorFromHook(saved) : null
  }, [editor.hookId, editor.event, hooks])
  const dirty = baseline ? !sameEditor(editor, baseline) : true
  useDirtyGuard('settings:hooks:editor', 'the hook editor', dirty)

  const switchTab = (event: HookEvent): void => {
    if (event === activeEvent) return
    if (!confirmDiscard('settings:hooks:')) return
    setActiveEvent(event)
    setEditor(emptyEditor(event))
    clearLastTest()
  }

  const editHook = (hook: Hook): void => {
    if (hook.id === editor.hookId) return
    if (!confirmDiscard('settings:hooks:')) return
    setActiveEvent(hook.event)
    setEditor(editorFromHook(hook))
    clearLastTest()
  }

  const newHook = (): void => {
    if (!confirmDiscard('settings:hooks:')) return
    setEditor(emptyEditor(activeEvent))
    clearLastTest()
  }

  // The store toasts a refused write with the handler's reason and stays silent when the
  // operator cancelled the approval dialog, so nothing here toasts a second time.
  const save = async (): Promise<void> => {
    if (!editor.label.trim()) {
      toast.error(t('Give the hook a label first.'))
      return
    }
    if (!editor.code.trim()) {
      toast.error(t('The hook body is empty.'))
      return
    }
    setSaving(true)
    try {
      if (editor.hookId) {
        const ok = await update(editor.hookId, {
          event: editor.event,
          label: editor.label.trim(),
          command: editor.code,
          enabled: editor.enabled,
          language: editor.language,
          timeoutMs: editor.timeoutMs
        })
        if (ok) toast.success(t('Hook saved'))
      } else {
        const created = await create({
          event: editor.event,
          label: editor.label.trim(),
          command: editor.code,
          language: editor.language,
          timeoutMs: editor.timeoutMs
        })
        if (created) {
          toast.success(t('Hook created'))
          setEditor(editorFromHook(created))
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (context: HookSampleContext): Promise<void> => {
    setTesting(true)
    try {
      await test({
        code: editor.code,
        event: editor.event,
        context,
        timeoutMs: editor.timeoutMs
      })
    } finally {
      setTesting(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!editor.hookId) return
    if (!window.confirm(tf('Delete the hook "{name}"?', { name: editor.label }))) return
    const ok = await remove(editor.hookId)
    if (ok) {
      toast.success(t('Hook deleted'))
      setEditor(emptyEditor(activeEvent))
    }
  }

  const toggleEnabled = async (hook: Hook): Promise<void> => {
    const ok = await update(hook.id, { enabled: !hook.enabled })
    if (ok && editor.hookId === hook.id) {
      setEditor((state) => ({ ...state, enabled: !hook.enabled }))
    }
  }

  const applyTemplate = async (template: HookTemplate): Promise<void> => {
    if (!confirmDiscard('settings:hooks:')) return
    setApplyingTemplateId(template.id)
    clearLastTest()
    try {
      const created = await create({
        event: template.event,
        label: template.label,
        command: template.code,
        language: 'js',
        timeoutMs: template.timeoutMs
      })
      if (!created) return
      setActiveEvent(template.event)
      setEditor(editorFromHook(created))
      toast.success(tf('Created {name}', { name: template.label }))
    } finally {
      setApplyingTemplateId(null)
    }
  }

  const isNew = editor.hookId === null

  return (
    <SettingsPage
      purpose={t('Small scripts that run at session start, before and after each tool call, and when an agent stops.')}
    >
      {hooksOff && (
        <SettingsRow
          tone="warning"
          label={t('Hooks are switched off')}
          hint={
            <>
              {t('Nothing here runs until you turn them on under')}{' '}
              <SettingsLink tab="general">{t('General → Hooks')}</SettingsLink>
            </>
          }
        />
      )}

      <HookTemplatesGallery
        activeEvent={activeEvent}
        applyingId={applyingTemplateId}
        disabled={hooksOff}
        onApply={(template) => void applyTemplate(template)}
      />

      <SettingsSection
        label={t('Hooks by event')}
        description={t('Pick an event to see the hooks attached to it. Creating or editing a hook always asks you first.')}
      >
        <div
          role="tablist"
          aria-label={t('Hook events')}
          className="flex flex-wrap gap-1 rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-1"
        >
          {EVENT_OPTIONS.map((event) => {
            const active = event === activeEvent
            const count = countsByEvent[event]
            return (
              <button
                key={event}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchTab(event)}
                className={
                  'rounded px-3 py-1 font-mono text-[12px] transition-colors ' +
                  (active
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] ring-1 ring-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')
                }
                title={eventDescription(event)}
              >
                {event}
                <span className="ml-1.5 inline-block min-w-[1.25rem] rounded-full bg-[var(--bg-secondary)] px-1.5 text-center text-[11px] text-[var(--text-muted)]">
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-[260px_1fr] gap-3">
          <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)]">
            <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-2 py-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                {tf('{n} hooks', { n: hooksForEvent.length })}
              </span>
              <Button size="sm" onClick={newHook} disabled={hooksOff}>
                {t('New')}
              </Button>
            </div>
            <div className="max-h-[420px] overflow-y-auto p-1">
              {loadError ? (
                <div className="p-1">
                  <SettingsLoadError what={t('your hooks')} message={loadError} onRetry={() => void load()} />
                </div>
              ) : !loaded ? (
                <div className="px-2 py-3">
                  <SettingsLoading what={t('your hooks')} />
                </div>
              ) : hooksForEvent.length === 0 ? (
                <div className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                  {t('No hooks for this event yet.')}
                </div>
              ) : (
                hooksForEvent.map((hook) => {
                  const active = editor.hookId === hook.id
                  return (
                    <div
                      key={hook.id}
                      className={
                        'mb-1 flex items-center gap-2 rounded px-2 py-1 text-[12px] ' +
                        (active
                          ? 'bg-[var(--bg-secondary)] ring-1 ring-[var(--accent)]'
                          : 'hover:bg-[var(--bg-secondary)]')
                      }
                    >
                      <Toggle
                        checked={hook.enabled}
                        disabled={hooksOff}
                        onChange={() => void toggleEnabled(hook)}
                        aria-label={tf('{name} enabled', { name: hook.label })}
                      />
                      <button type="button" onClick={() => editHook(hook)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate font-medium text-[var(--text-primary)]">{hook.label}</span>
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">
                          {hook.language === 'shell' ? t('shell') : 'JS'} · {hook.timeoutMs} ms
                        </span>
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
            <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
              {eventDescription(editor.event)}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor={labelId} className="text-[11px] text-[var(--text-muted)]">
                  {t('Label')}
                </label>
                <Input
                  id={labelId}
                  value={editor.label}
                  onChange={(event) => setEditor((state) => ({ ...state, label: event.target.value }))}
                  placeholder={t('block-rm-rf')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-muted)]">{t('Timeout')}</span>
                <NumberField
                  aria-label={t('Timeout')}
                  value={editor.timeoutMs}
                  spec={TIMEOUT_SPEC}
                  unit={t('ms')}
                  defaultValue={DEFAULT_TIMEOUT_MS}
                  onCommit={(next) => setEditor((state) => ({ ...state, timeoutMs: next }))}
                />
              </div>
            </div>

            {editor.language === 'shell' && (
              <p className="mt-2 rounded-md border border-[var(--warning)]/60 bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--warning)]">
                {t('This older hook runs as a shell command. Edits keep it that way; new hooks run in the JavaScript sandbox.')}
              </p>
            )}

            <label htmlFor={bodyId} className="mt-3 block text-[11px] text-[var(--text-muted)]">
              {t('Body (JS)')}
            </label>
            <textarea
              id={bodyId}
              value={editor.code}
              onChange={(event) => setEditor((state) => ({ ...state, code: event.target.value }))}
              spellCheck={false}
              className="mt-1 h-[200px] w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />

            <details className="mt-2 text-[12px]">
              <summary className="cursor-pointer text-[var(--text-secondary)]">{t('Bindings')}</summary>
              <ul className="mt-1 space-y-0.5 text-[var(--text-muted)]">
                {BINDINGS.map((b) => (
                  <li key={b.name}>
                    <code className="font-mono text-[var(--text-primary)]">{b.name}</code> — {b.meaning()}
                  </li>
                ))}
              </ul>
            </details>

            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={saving || (isNew && hooksOff)}
                title={isNew && hooksOff ? t('Hooks are switched off under General.') : undefined}
              >
                {saving ? t('Saving…') : isNew ? t('Create') : t('Save')}
              </Button>
              {!isNew && (
                <Button variant="danger" onClick={() => void handleDelete()}>
                  {t('Delete')}
                </Button>
              )}
              <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                <Toggle
                  checked={editor.enabled}
                  disabled={hooksOff}
                  onChange={(v) => setEditor((state) => ({ ...state, enabled: v }))}
                  aria-label={t('Hook enabled')}
                />
                {t('Enabled')}
              </span>
            </div>

            <HookTestRunner
              key={editor.event}
              event={editor.event}
              language={editor.language}
              code={editor.code}
              timeoutMs={editor.timeoutMs}
              testing={testing}
              lastTest={lastTest}
              disabled={hooksOff}
              onRun={(context) => void runTest(context)}
              onClear={clearLastTest}
            />
          </div>
        </div>

        {unlistedCount > 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {tf('{n} hooks are attached to events that no longer fire and are not shown.', { n: unlistedCount })}
          </p>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

import { t } from '@/lib/i18n'
import type { ChannelCredential } from './channel-types'

// One credential slot. Controlled: the pane owns the draft, this owns the presentation.

// Copied rather than imported from ChannelsSettings, which keeps its own module-local
// `inputCls` unexported. A shared style module for two consts would be the wrong trade,
// and reaching into the pane this component is meant to be composed INTO is worse.
const inputCls =
  'w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none'

/**
 * What the box shows when it is empty.
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so the
 * judgement is unit-tested through helpers rather than by rendering — the same
 * convention as ChannelsSettings' secretPlaceholder, which this generalises.
 *
 * The case that forced it: a stored SECRET. The value never leaves the main process, so
 * an empty box is all this component CAN render — and an empty box sitting next to a row
 * reporting "credentials are in place" reads as a bug, so the operator clears it and
 * re-pastes a token that was already fine. The placeholder therefore carries two facts
 * the field cannot show: that a value is stored, and that typing REPLACES it rather than
 * appending to it. That outranks the spec's own placeholder here — the spec placeholder
 * describes what to paste, which is not the question being asked once something is
 * already stored.
 *
 * A TEXT field needs none of this: it renders its stored value, so the box is not empty
 * and there is nothing to explain.
 */
export function fieldPlaceholder(field: ChannelCredential): string {
  if (field.kind === 'secret' && field.hasValue) return t('Stored — type to replace it')
  return field.placeholder ?? ''
}

export function ChannelFieldInput({
  field,
  value,
  onChange,
  onSubmit,
  disabled
}: {
  field: ChannelCredential
  value: string
  onChange: (v: string) => void
  /** Enter-to-save. Optional so the component stays usable in a form that has its own
   *  submit; the channels pane relies on it, because a token is pasted and the natural
   *  next keystroke is Enter, not a reach for the button. */
  onSubmit?: () => void
  disabled?: boolean
}): React.ReactElement {
  const inputId = `channel-cred-${field.keychainKey}`

  return (
    <div className="flex-1 space-y-1">
      <label htmlFor={inputId} className="block text-[11px] text-[var(--text-secondary)]">
        {field.label}
      </label>
      <input
        id={inputId}
        className={inputCls}
        // 'secret' is the write-only kind, so mask it. 'text' shows what is stored —
        // that is the whole distinction ChannelCredential.kind carries.
        type={field.kind === 'secret' ? 'password' : 'text'}
        // A channel token is not a login. Browser autofill offering the operator's saved
        // passwords here is noise at best and a mis-save at worst.
        autoComplete="off"
        spellCheck={false}
        placeholder={fieldPlaceholder(field)}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) onSubmit()
        }}
      />
      {field.help && <p className="text-[10px] text-[var(--text-muted)]">{field.help}</p>}
    </div>
  )
}

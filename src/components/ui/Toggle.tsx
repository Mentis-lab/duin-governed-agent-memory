// Shared on/off Toggle — the single switch primitive for every boolean setting.
// Replaces the previously scattered mix (bordered/borderless iOS switches, themed
// and OS-blue checkboxes). Canonical look is the bordered iOS switch: a pill track
// that fills with the accent when on, and a white thumb that slides across.
//
// Control only — callers own the label/row markup. `onChange` receives the NEXT
// boolean value (not a DOM event).

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  'aria-label'?: string
  id?: string
  className?: string
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  id,
  className = '',
  'aria-label': ariaLabel
}: ToggleProps): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
      className={`h-5 w-9 shrink-0 rounded-full border transition-colors ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--panel-border)] bg-[var(--bg-primary)]'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

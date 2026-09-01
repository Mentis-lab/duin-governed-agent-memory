import { cn } from '@/duin/lib/utils'
import { isMac, modifierLabel } from '@/lib/platform'

// Renders a shortcut string (e.g. "Ctrl+`", "Ctrl+Shift+G") as styled key-caps so
// EVERY key is clearly visible — including the ones that vanish as plain text
// (backtick, comma). Was: raw mono text, where `Ctrl+\`` read as "Ctrl+" with no
// visible key. Split on '+', render each token in its own <kbd>.

// Human-readable labels for keys that are hard to read as a bare glyph.
const KEY_LABEL: Record<string, string> = {
  '`': '`',
  ',': ',',
  ' ': 'Space',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  ctrl: 'Ctrl',
  cmd: 'Cmd',
  shift: 'Shift',
  alt: 'Alt'
}

function labelFor(k: string): string {
  // Modifiers first: on a Mac the combos are written "Ctrl+N" throughout the codebase,
  // but the key that fires them is Command. shortcut-resolver already accepts either
  // (`e.ctrlKey || e.metaKey`), so the binding works — only the LABEL was lying.
  const mod = modifierLabel(k)
  if (mod !== k) return mod
  return KEY_LABEL[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k)
}

// Pure: a shortcut string -> the readable key-cap labels, in order.
// "Ctrl+`" -> ["Ctrl", "`"]; "Ctrl+Shift+G" -> ["Ctrl","Shift","G"]; "ArrowUp" -> ["↑"].
export function shortcutParts(combo: string): string[] {
  const parts = combo
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map(labelFor)
  // macOS renders modifier glyphs adjacent (⌘⇧G), not as separate caps with '+'
  // between them. Collapse the leading glyph run into one cap so it reads native.
  if (!isMac()) return parts
  const glyphs: string[] = []
  while (parts.length > 1 && /^[⌘⌥⇧]$/.test(parts[0])) glyphs.push(parts.shift() as string)
  return glyphs.length ? [glyphs.join('') + parts.join('')] : parts
}

export function ShortcutKeys({ combo, className }: { combo: string; className?: string }) {
  const keys = shortcutParts(combo)
  if (keys.length === 0) return null
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={combo}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-1 font-mono text-[11px] leading-none text-[var(--text-secondary)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

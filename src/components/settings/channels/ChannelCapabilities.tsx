import { t } from '@/lib/i18n'
import type { ChannelCapability } from './channel-types'

// What a channel can do beyond exchanging text, as a chip row.
//
// These are the DERIVED capabilities (claimed AND implemented) that the main process
// stamps onto the definition — see channel-types' ChannelDefinition.capabilities. That
// makes the wire ids honest but not readable: 'directory' and 'edit' mean nothing to
// someone deciding whether Telegram will do what they need.

/**
 * The wire id in human words.
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so the
 * judgement is unit-tested through helpers rather than by rendering (the convention
 * ChannelsSettings' channelStatusLine established).
 *
 * 'directory' is the one that needed a real translation rather than a title-case of the
 * id: the word means "the channel can enumerate the conversations it is in", and shown
 * raw it reads as a filesystem directory — the wrong idea entirely.
 */
export function capabilityLabel(cap: ChannelCapability): string {
  switch (cap) {
    case 'threads':
      return t('Threads')
    case 'reactions':
      return t('Reactions')
    case 'typing':
      return t('Typing indicator')
    case 'files':
      return t('File uploads')
    case 'directory':
      return t('Browse conversations')
    case 'edit':
      return t('Edit messages')
    default: {
      // Unreachable while the union is fully covered. Typing the fall-through as `never`
      // makes a NEW ChannelCapability a compile error here rather than a chip that
      // silently renders its raw wire id at the operator.
      const unhandled: never = cap
      return String(unhandled)
    }
  }
}

/**
 * Nothing at all for an empty set — no container, no "None".
 *
 * An empty array is a REAL answer here, not missing data: the derived set is empty when
 * an adapter implements nothing beyond plain text. But "None" would spend a line saying
 * what absence already says, and an empty container leaves a gap that reads as a row
 * still loading. Both are louder than the fact deserves.
 */
export function ChannelCapabilities({
  capabilities
}: {
  capabilities: ChannelCapability[]
}): React.ReactElement | null {
  if (capabilities.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {capabilities.map((cap) => (
        <span
          key={cap}
          className="rounded border border-[var(--panel-border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-muted)]"
        >
          {capabilityLabel(cap)}
        </span>
      ))}
    </div>
  )
}

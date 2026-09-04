import { t } from '@/lib/i18n'
import type { ChannelDefinition, ChannelIngress } from './channel-types'

// What it takes to get this channel running, before the operator has typed anything.
//
// The definition already carries setupSteps / docsUrl / ingress / needsPublicUrl and
// nothing rendered them, so the pane asked for a token and left the operator to find
// out elsewhere where that token comes from — and, for a webhook channel, to find out
// by silence that inbound was never going to work at all.

/**
 * How the channel receives messages, in words that answer the only question the
 * operator actually has: "do I need to expose something to the internet?"
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so the
 * judgement is unit-tested through helpers rather than by rendering (the convention
 * ChannelsSettings' channelStatusLine established).
 *
 * 'websocket' and 'webhook' are wire words; neither survives into the copy. They differ
 * by exactly one operator-visible consequence — whether the connection is dialled OUT
 * or delivered IN — so that consequence is what the label states.
 */
export function ingressLabel(ingress: ChannelIngress): string {
  switch (ingress) {
    case 'websocket':
      return t('Connects outward — no public URL needed')
    case 'poll':
      return t('Polls for messages — no public URL needed')
    case 'webhook':
      return t('Needs a public HTTPS endpoint')
    case 'local':
      return t('Reads a local source')
    default: {
      // Unreachable while the union is fully covered. Typing the fall-through as `never`
      // makes a NEW ChannelIngress a compile error here rather than a blank line where
      // the public-URL answer should be.
      const unhandled: never = ingress
      return String(unhandled)
    }
  }
}

export function ChannelSetupSteps({
  definition
}: {
  definition: ChannelDefinition
}): React.ReactElement {
  const { setupSteps, docsUrl, needsPublicUrl, ingress } = definition

  return (
    <div className="mt-2 space-y-2">
      <p className="text-[11px] text-[var(--text-muted)]">{ingressLabel(ingress)}</p>

      {/* Prominent on purpose. A webhook channel with no reachable endpoint is the
          worst-looking failure this pane can produce: it configures, it enables, it
          goes green, replies go out — and inbound never arrives, with nothing on
          screen to explain it. The warning has to land BEFORE the token is pasted,
          which is why it sits with the setup steps and not in the error slot. */}
      {needsPublicUrl && (
        <div className="rounded border border-[var(--warning)] bg-[var(--warning)]/10 px-2 py-1.5">
          <p className="text-[11px] font-medium text-[var(--text-primary)]">
            {t('It cannot receive messages without a public HTTPS endpoint.')}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
            {t(
              'Outbound still works, so replies go out and nothing comes back — a channel that looks connected and is deaf. Put it behind a reachable HTTPS URL before you rely on it for inbound.'
            )}
          </p>
        </div>
      )}

      {setupSteps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[11px] text-[var(--text-muted)]">
          {/* Index keys: a fixed, ordered list off a static definition. It never
              reorders or filters, so there is nothing for a stable key to protect. */}
          {setupSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}

      {docsUrl && (
        <a
          href={docsUrl}
          onClick={(e) => {
            // Electron: a plain navigation would replace the app window. Hand it to the
            // OS browser instead — same idiom as ApiKeyModal's provider docs link.
            e.preventDefault()
            window.api?.artifact?.openExternal?.(docsUrl)
          }}
          className="inline-block text-[11px] font-medium text-[var(--accent)] hover:underline"
        >
          {t('Setup guide →')}
        </a>
      )}
    </div>
  )
}

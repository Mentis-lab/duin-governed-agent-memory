// Channel gateway — the lifecycle that turns the registry + per-channel state
// into live connections. startGateway() start()s every channel that is BOTH
// operator-enabled (channels-store) AND configured (has its secret), wiring each
// with a ChannelContext whose onMessage runs the DE-PRIVILEGED inbound path
// (handleInbound → pairing gate → de-privileged turn → reply). stopGateway()
// tears them all down on quit.
//
// SECURITY: every inbound turn goes through handleInbound, which authorizes the
// sender (deny-first) BEFORE any brain turn and runs the turn without an exec
// token. The gateway adds NO trust of its own — it only decides which channels
// are live, never who may talk to them.

import { listChannels } from './index'
import { isChannelEnabled, recordChannelStarted, recordChannelError } from './channels-store'
import { handleInbound } from './channel-runtime'
import type { ChannelAdapter, ChannelContext } from './channel-adapter'
import { messageOf } from '../guarded'

let started = false

/** Build the runtime context for one adapter: inbound messages flow through the
 *  de-privileged handleInbound path. Errors are swallowed so one bad message
 *  can't kill an adapter's receive loop. */
function contextFor(adapter: ChannelAdapter): ChannelContext {
  return {
    onMessage: async (msg): Promise<void> => {
      try {
        await handleInbound(adapter, msg)
      } catch (e) {
        recordChannelError(adapter.id, messageOf(e))
      }
    }
  }
}

/**
 * Start every enabled + configured channel. Idempotent: a second call is a
 * no-op. A channel that throws on start() is recorded as errored but never
 * blocks the others. Safe to call with no channels enabled (does nothing).
 */
export async function startGateway(): Promise<void> {
  if (started) return
  started = true
  for (const ch of listChannels()) {
    if (!isChannelEnabled(ch.id) || !ch.isConfigured()) continue
    try {
      await ch.start(contextFor(ch))
      recordChannelStarted(ch.id)
    } catch (e) {
      recordChannelError(ch.id, messageOf(e))
    }
  }
}

/** Stop every channel and reset, so a subsequent startGateway() re-starts them. */
export async function stopGateway(): Promise<void> {
  started = false
  for (const ch of listChannels()) {
    try {
      await ch.stop()
    } catch (e) {
      console.debug('[gateway] stop failed for', ch.id, messageOf(e))
    }
  }
}

/** Restart one channel to apply an enable/disable or config change at runtime. */
export async function restartChannel(id: string): Promise<void> {
  const ch = listChannels().find((c) => c.id === id)
  if (!ch) return
  try {
    await ch.stop()
  } catch (e) {
    console.debug('[gateway] restart-stop failed for', id, messageOf(e))
  }
  if (isChannelEnabled(id) && ch.isConfigured()) {
    try {
      await ch.start(contextFor(ch))
      recordChannelStarted(id)
    } catch (e) {
      recordChannelError(id, messageOf(e))
    }
  }
}

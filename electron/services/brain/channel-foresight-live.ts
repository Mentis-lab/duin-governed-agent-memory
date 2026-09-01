// channel-foresight-live — the real-deps wrapper that makes the channel→foresight
// bridge runnable. Kept SEPARATE from channel-foresight-sync (the tested core) so the
// heavy LLM/provider + index imports don't load into the unit tests. Call this on
// connector sync / reindex with the notes dir; it writes channel-anchors.jsonl (keyless)
// + channel-futures.jsonl (key-gated) so a connected channel produces live forecasts.
//
// WIRING (the one remaining edge, deploy/coordination-gated): call
//   refreshChannelForesight(readSettings().localBrainNotesDir)
// after a connector sync (connections-store) or in refreshNotesExtraction once the notes
// dir is threaded there. Safe no-op if the dir is null or no channel docs are indexed.
import { bridgeChannelForesight } from './channel-foresight-sync'
import { extractTemporal } from './notes-extract'
import { groupChunksByFile } from './extraction-util'
import { allChunks, SRC_PREFIX } from '../local-brain/index-store'

export function refreshChannelForesight(notesDir: string | null): Promise<{ anchors: number; streams: number }> {
  return bridgeChannelForesight(
    notesDir,
    extractTemporal,
    // Reassemble multi-chunk src/ notes into one doc so title/track resolve from the
    // full note (frontmatter + H1), not just the last chunk.
    () => groupChunksByFile(allChunks().filter((c) => c.file.startsWith(SRC_PREFIX)))
  )
}

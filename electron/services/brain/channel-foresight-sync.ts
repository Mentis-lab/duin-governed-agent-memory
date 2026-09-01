// channel-foresight-sync — the orchestration that makes the channel→foresight bridge
// LIVE: run the LLM temporal extraction over the ingested channel (`src/`) docs, keep
// the channel-sourced decisions/commitments, and write them as foresight streams
// (channel-futures.jsonl). Called on connector sync / reindex. Deps are INJECTED (the
// real extractor `extractTemporal` + `allChunks` at the call site) so this stays
// testable without loading the provider/LLM chain. Key-gated: no model → extract
// returns null → we leave channel-futures untouched (structural-only, as before).
import { extractedToStreams, writeChannelFutures, channelEventsToAnchors, writeChannelAnchors } from './channel-foresight-bridge'
import { trackOf } from './predicted-risks-native'
import type { ExtractedData } from './types'

const SRC = 'src/'

/** Best title for a synthetic channel note: its H1 (`synthNoteText` prepends one),
 *  else the first non-frontmatter line. */
export function docTitle(text: string): string {
  const lines = (text || '').split(/\r?\n/)
  for (const l of lines) {
    const t = l.trim()
    if (t.startsWith('# ')) return t.slice(2).trim().slice(0, 120)
  }
  for (const l of lines) {
    const t = l.trim()
    if (t && !t.includes(':') && t !== '---') return t.slice(0, 120)
  }
  return 'channel item'
}

/** Extract → filter to channel items → map to streams → write channel-futures.jsonl.
 *  Returns the number of channel streams written (0 if key-gated or no channel data). */
export async function bridgeChannelForesight(
  vaultDir: string | null,
  extract: () => Promise<ExtractedData | null>,
  channelDocs: () => { file: string; text: string }[]
): Promise<{ anchors: number; streams: number }> {
  if (!vaultDir) return { anchors: 0, streams: 0 }
  const docs = channelDocs()

  // KEYLESS: dated channel events → anchor timeline (no model needed). Always runs.
  const anchors = writeChannelAnchors(vaultDir, channelEventsToAnchors(docs, (t) => trackOf(t) ?? ''))

  // KEY-GATED: LLM-extracted channel decisions/commitments → streams.
  const ex = await extract()
  if (!ex) return { anchors, streams: 0 } // no model → keyless anchors only, don't clobber streams
  const byFile = new Map(docs.map((d) => [d.file, d]))
  const channelEx: ExtractedData = {
    commitments: ex.commitments.filter((c) => c.note.startsWith(SRC)),
    decisions: ex.decisions.filter((d) => d.note.startsWith(SRC)),
    risks: []
  }
  const resolve = (id: string): { title: string; track?: string } | null => {
    const d = byFile.get(id)
    if (!d) return null
    return { title: docTitle(d.text), track: trackOf(d.text) ?? '' }
  }
  const streams = writeChannelFutures(vaultDir, extractedToStreams(channelEx, resolve))
  return { anchors, streams }
}

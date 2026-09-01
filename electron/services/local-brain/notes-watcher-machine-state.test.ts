import { describe, it, expect } from 'vitest'
import { isMachineStatePath } from './notes-watcher'

// The self-triggered construction loop, pinned.
//
// DUIN materializes promoted memory as .md files under the vault's `.brain/` dir. Those files
// are watched and indexed on purpose — a promoted concept must be retrievable. But they also
// armed the CONSTRUCTION trigger, which is a full LLM pass over the vault, whose own output is
// more `.brain/` writes. With no human in the loop that ran every CONSTRUCT_MIN_GAP_MS forever:
// measured on the live vault, 57 rewritten files in three days while idle, ~1,000-1,700 new
// entity nodes per day, and a matching share of the extraction quota burn.
describe('isMachineStatePath', () => {
  it('matches DUIN state dirs on BOTH separators (chokidar is native on Windows)', () => {
    expect(isMachineStatePath('D:\\Sample-brain\\.brain\\memory\\concept-of_10.md')).toBe(true)
    expect(isMachineStatePath('/home/theo/Sample-brain/.brain/memory/concept.md')).toBe(true)
    expect(isMachineStatePath('D:\\Sample-brain\\.duin\\_state\\claim-ledger.jsonl')).toBe(true)
    expect(isMachineStatePath('/vault/.duin/routines/x.py')).toBe(true)
  })

  it('does NOT match operator content, including notes that merely mention the word', () => {
    expect(isMachineStatePath('D:\\Sample-brain\\03 Projects\\DUIN\\Design.md')).toBe(false)
    expect(isMachineStatePath('/vault/notes/brain-dump.md')).toBe(false)
    expect(isMachineStatePath('/vault/my.brain.notes/real.md')).toBe(false)
    expect(isMachineStatePath('/vault/duin/content.md')).toBe(false) // no dot prefix = content
  })

  it('matches the dir itself as well as files under it', () => {
    expect(isMachineStatePath('/vault/.brain')).toBe(true)
    expect(isMachineStatePath('.brain/memory/x.md')).toBe(true)
  })
})

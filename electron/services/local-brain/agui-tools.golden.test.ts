import { describe, it, expect } from 'vitest'
import { AGUI_TOOLS, isSimpleAguiTool } from './agui-tools'

// GOLDEN byte-parity net (Phase-0 #1). Locks every simple tool's model-facing `out` string and its
// TOOL_CALL_END summary to the EXACT strings the pre-registry if/else produced. A drift here
// mis-renders a tool card (or the model-facing result) on every turn — so these are frozen, and any
// change to the dispatch collapse must keep them green.

const out = (name: string, r: unknown): string => AGUI_TOOLS[name].out(r as never)
const end = (name: string, r: unknown): string => AGUI_TOOLS[name].end(r as never)

describe('agui-tools golden — model-facing out + card end summaries', () => {
  it('registry covers exactly the 17 simple tools', () => {
    expect(Object.keys(AGUI_TOOLS).sort()).toEqual([
      'create_dir', 'create_skill', 'delete_file', 'edit_file', 'glob_files', 'list_dir', 'move_file',
      'read_command', 'read_file', 'run_command', 'search_files', 'start_command', 'stop_command',
      'web_fetch', 'web_search', 'write_file', 'write_todos'
    ])
    expect(isSimpleAguiTool('render_artifact')).toBe(false) // special, stays inline
    expect(isSimpleAguiTool('spawn_agent')).toBe(false)
  })

  it('write_file', () => {
    expect(out('write_file', { ok: true, path: 'a/b.md' })).toBe('Wrote file to a/b.md')
    expect(end('write_file', { ok: true, path: 'a/b.md' })).toBe('Wrote file to a/b.md')
    expect(out('write_file', { ok: false, error: 'nope' })).toBe('Error: nope')
  })
  it('read_file', () => {
    const r = { ok: true, path: 'n.md', content: 'hello\nworld' }
    expect(out('read_file', r)).toBe('n.md:\nhello\nworld')
    expect(end('read_file', r)).toBe('Read n.md (11 chars)')
    expect(out('read_file', { ok: false, error: 'x' })).toBe('Error: x')
  })
  it('list_dir — pluralization + path', () => {
    expect(end('list_dir', { ok: true, path: '.', entries: ['a', 'b', 'c'] })).toBe('3 entries in .')
    expect(end('list_dir', { ok: true, path: 'd', entries: ['only'] })).toBe('1 entry in d')
    expect(out('list_dir', { ok: true, path: 'd', entries: ['a', 'b'] })).toBe('d/\na\nb')
  })
  it('edit_file / delete_file / create_dir / move_file', () => {
    expect(out('edit_file', { ok: true, path: 'p' })).toBe('Edited p')
    expect(out('delete_file', { ok: true, path: 'p' })).toBe('Deleted p')
    expect(out('create_dir', { ok: true, path: 'p' })).toBe('Created folder p')
    expect(out('move_file', { ok: true, from: 'a', to: 'b' })).toBe('Moved a → b')
    expect(end('move_file', { ok: true, from: 'a', to: 'b' })).toBe('Moved a → b')
  })

  // A colliding move destroys-and-tombstones a BYSTANDER the model never named. These lock the
  // stamp: the clean-move strings above stay byte-identical (no `displaced` key ⇒ same bytes as the
  // pre-registry if/else), but a displacement MUST be visible in both surfaces. Without this the
  // two cases rendered identically and the loss was unattributable.
  it('move_file — a displaced destination is reported to the model AND the tool card', () => {
    const collided = { ok: true, from: '00 Inbox/meeting-notes.md', to: '01 Projects/Acme/meeting-notes.md', displaced: '.trash/meeting-notes.1770000000000.md' }

    const modelFacing = out('move_file', collided)
    expect(modelFacing).toContain('Moved 00 Inbox/meeting-notes.md → 01 Projects/Acme/meeting-notes.md')
    // The model is told a second file existed, and where its contents went.
    expect(modelFacing).toContain('already existed at 01 Projects/Acme/meeting-notes.md')
    expect(modelFacing).toContain('.trash/meeting-notes.1770000000000.md')
    // It must NOT read as a clean success — that was the whole defect.
    expect(modelFacing).not.toBe('Moved 00 Inbox/meeting-notes.md → 01 Projects/Acme/meeting-notes.md')

    // The operator watching the tool card sees it too, not just the model.
    expect(end('move_file', collided)).toBe(
      'Moved 00 Inbox/meeting-notes.md → 01 Projects/Acme/meeting-notes.md (displaced prior file → .trash/meeting-notes.1770000000000.md)'
    )
  })

  it('delete_file — surfaces the tombstone so "Deleted" does not read as unrecoverable', () => {
    const r = { ok: true, path: '00 Inbox/draft.md', trashed: '.trash/draft.md' }
    expect(out('delete_file', r)).toBe('Deleted 00 Inbox/draft.md (recoverable at .trash/draft.md)')
    expect(end('delete_file', r)).toBe('Deleted 00 Inbox/draft.md → .trash/draft.md')
  })
  it('search_files — capped marker + match pluralization', () => {
    expect(out('search_files', { ok: true, matches: ['a:1: x', 'b:2: y'], capped: false })).toBe('a:1: x\nb:2: y')
    expect(out('search_files', { ok: true, matches: ['a:1: x'], capped: true })).toBe('a:1: x\n[…more matches capped…]')
    expect(out('search_files', { ok: true, matches: [], capped: false })).toBe('No matches.')
    expect(end('search_files', { ok: true, matches: ['a'], capped: false })).toBe('1 match')
    expect(end('search_files', { ok: true, matches: ['a', 'b'], capped: false })).toBe('2 matches')
  })
  it('glob_files', () => {
    expect(out('glob_files', { ok: true, results: ['a.md', 'b.md'] })).toBe('a.md\nb.md')
    expect(out('glob_files', { ok: true, results: [] })).toBe('No files match.')
    expect(end('glob_files', { ok: true, results: ['a'] })).toBe('1 file')
    expect(end('glob_files', { ok: true, results: ['a', 'b'] })).toBe('2 files')
  })
  it('run_command', () => {
    expect(out('run_command', { ok: true, output: 'done' })).toBe('done')
    expect(end('run_command', { ok: true, output: 'hello' })).toBe('ran (5 chars out)')
  })
  it('web_fetch', () => {
    const r = { ok: true, url: 'https://x', content: 'abcde' }
    expect(out('web_fetch', r)).toBe('https://x:\nabcde')
    expect(end('web_fetch', r)).toBe('fetched https://x (5 chars)')
  })
  it('web_search', () => {
    expect(out('web_search', { ok: true, results: 'r1\n\nr2' })).toBe('r1\n\nr2')
    expect(end('web_search', { ok: true, results: 'abcde' })).toBe('searched (5 chars)')
  })
  it('write_todos', () => {
    expect(out('write_todos', { ok: true, rendered: '[ ] a\n[x] b' })).toBe('Task list updated:\n[ ] a\n[x] b')
    expect(end('write_todos', { ok: true, rendered: 'x' })).toBe('todos updated')
  })
  it('start_command / read_command / stop_command', () => {
    expect(out('start_command', { ok: true, id: 'ab12' })).toBe(
      'Started background command with id ab12. Poll its output with read_command("ab12") and end it with stop_command("ab12").'
    )
    expect(end('start_command', { ok: true, id: 'ab12' })).toBe('started ab12')
    expect(out('read_command', { ok: true, status: 'running', output: 'log' })).toBe('[running]\nlog')
    expect(end('read_command', { ok: true, status: 'exited(0)', output: '' })).toBe('exited(0)')
    expect(out('stop_command', { ok: true })).toBe('Background command stopped.')
    expect(end('stop_command', { ok: true })).toBe('stopped')
  })
  it('create_skill — success reports the id + path; card omits the path', () => {
    const r = { ok: true, id: 'bd-follow-up', path: '/skills/bd-follow-up/SKILL.md' }
    expect(out('create_skill', r)).toBe('Created skill "bd-follow-up" → /skills/bd-follow-up/SKILL.md (now in the Skills panel)')
    expect(end('create_skill', r)).toBe('Created skill "bd-follow-up" (now in the Skills panel)')
    expect(out('create_skill', { ok: false, error: 'already exists' })).toBe('Error: already exists')
  })
  it('every tool renders an error uniformly as "Error: <msg>"', () => {
    for (const name of Object.keys(AGUI_TOOLS)) {
      expect(out(name, { ok: false, error: 'boom' })).toBe('Error: boom')
      expect(end(name, { ok: false, error: 'boom' })).toBe('Error: boom')
    }
  })
})

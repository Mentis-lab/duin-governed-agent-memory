import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUiStore } from './ui-store'
import { useBrainStore } from './brain-store'

// U3 — the WIRING half: every dismissal path must consult the registry. Before
// this, none of them did; there was no registry to consult.

let answer = false
const confirmSpy = vi.fn((_msg: string) => answer)

beforeEach(() => {
  confirmSpy.mockClear()
  answer = false
  vi.stubGlobal('window', { confirm: confirmSpy })
  useUiStore.setState({ dirtyPanes: {}, settingsOpen: false })
  useBrainStore.setState({ detailNode: null })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('closeSettings', () => {
  it('closes without asking when nothing is dirty', () => {
    useUiStore.setState({ settingsOpen: true })
    useUiStore.getState().closeSettings()
    expect(useUiStore.getState().settingsOpen).toBe(false)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('KEEPS the dialog open when the operator cancels the discard', () => {
    // Esc / backdrop / X used to destroy a BRAIN.md · SOUL.md · ME.md · GOALS.md
    // draft with no confirm at all.
    useUiStore.setState({ settingsOpen: true })
    useUiStore.getState().markDirty('settings:foundations:SOUL.md', 'the SOUL.md editor')
    useUiStore.getState().closeSettings()
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(useUiStore.getState().settingsOpen).toBe(true)
    expect(useUiStore.getState().dirtyPanes['settings:foundations:SOUL.md']).toBeTruthy()
  })

  it('closes and drops ONLY the settings registrations when confirmed', () => {
    answer = true
    useUiStore.setState({ settingsOpen: true })
    useUiStore.getState().markDirty('settings:foundations:SOUL.md', 'the SOUL.md editor')
    useUiStore.getState().markDirty('brain:note-editor', 'the note editor')
    useUiStore.getState().closeSettings()
    expect(useUiStore.getState().settingsOpen).toBe(false)
    expect(useUiStore.getState().dirtyPanes).toEqual({ 'brain:note-editor': 'the note editor' })
  })

  it('toggleSettings closed is a dismissal too', () => {
    useUiStore.setState({ settingsOpen: true })
    useUiStore.getState().markDirty('settings:foundations:ME.md', 'the ME.md editor')
    useUiStore.getState().toggleSettings()
    expect(useUiStore.getState().settingsOpen).toBe(true)
  })
})

describe('brain setDetail', () => {
  const node = { id: 'DUIN/Notes/b.md', label: 'B' } as never

  it('switches freely when the editor is clean', () => {
    useBrainStore.getState().setDetail(node)
    expect(useBrainStore.getState().detailNode).toBe(node)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('REFUSES to switch away from an unsaved note when the operator cancels', () => {
    // The verified loss: BrainExplorerPanel's detailNode effect calls
    // setEditing(false) unconditionally, so clicking a [[wikilink]] inside your
    // own unsaved paragraph discarded it.
    useUiStore.getState().markDirty('brain:note-editor', 'the note editor')
    useBrainStore.getState().setDetail(node)
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(useBrainStore.getState().detailNode).toBeNull()
  })

  it('switches and clears the registration when confirmed', () => {
    answer = true
    useUiStore.getState().markDirty('brain:note-editor', 'the note editor')
    useBrainStore.getState().setDetail(node)
    expect(useBrainStore.getState().detailNode).toBe(node)
    expect(useUiStore.getState().dirtyPanes['brain:note-editor']).toBeUndefined()
  })

  it('does not ask about a dirty SETTINGS pane', () => {
    useUiStore.getState().markDirty('settings:foundations:ME.md', 'the ME.md editor')
    useBrainStore.getState().setDetail(node)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useBrainStore.getState().detailNode).toBe(node)
  })
})

describe('confirmDiscard on a host with no window.confirm', () => {
  it('refuses rather than auto-answering "discard"', () => {
    // A detached surface has no confirm; an unanswerable question must never be
    // answered in favour of destroying work.
    vi.stubGlobal('window', {})
    useUiStore.getState().markDirty('brain:note-editor', 'the note editor')
    expect(useUiStore.getState().confirmDiscard('brain:')).toBe(false)
  })
})

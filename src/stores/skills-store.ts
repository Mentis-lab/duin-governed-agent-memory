import { create } from 'zustand'
import type { Skill } from '@/lib/types'
import { toast } from '@/stores/toast-store'

/**
 * Which skills are enabled, PERSISTED across launches.
 *
 * Until 2026-07-21 this lived only in memory: a user enabled a skill, quit DUIN, and reopened to
 * find it off again with no indication anything had been forgotten. That made the toggle unusable
 * for anything long-running even once it was correctly wired to the engine — a control you must
 * re-set every launch is a control you stop trusting.
 *
 * Ids are validated against the loaded skill list on every read/refresh, so a deleted or renamed
 * skill cannot resurrect itself or wedge a stale id into the chat payload.
 */
const ACTIVE_SKILLS_KEY = 'duin.skills.activeIds.v1'

function readActiveIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage?.getItem(ACTIVE_SKILLS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // unreadable/corrupt -> start clean rather than throwing at store construction
  }
}

function writeActiveIds(ids: string[]): void {
  try {
    window.localStorage?.setItem(ACTIVE_SKILLS_KEY, JSON.stringify(ids))
  } catch {
    // ignore quota / unavailable — an unpersisted toggle still works for this session
  }
}

export interface SkillCreateInput {
  name: string
  description: string
  content: string
  /** Customize C3/C4: optional tool allowlist (glob patterns). */
  allowedTools?: string[]
  /** Customize C3/C4: optional per-skill model override. */
  model?: string
  /** Customize C3/C4: when false the skill is manual-only. */
  autoInvoke?: boolean
  /** Customize C4: when true, scaffold a directory-mode skill. */
  directoryMode?: boolean
  /** Customize C4: when directoryMode + this, write a reference.md stub. */
  scaffoldReference?: boolean
}

export interface SkillUpdateInput {
  name: string
  description: string
  content: string
  allowedTools?: string[]
  model?: string
  autoInvoke?: boolean
}

interface SkillsState {
  skills: Skill[]
  activeSkillIds: string[]
  loadSkills: () => Promise<void>
  setSkillsFromEvent: (skills: Skill[]) => void
  toggleSkill: (id: string) => void
  setActiveSkillIds: (ids: string[]) => void
  createSkill: (input: SkillCreateInput) => Promise<void>
  updateSkill: (id: string, input: SkillUpdateInput) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  activeSkillIds: readActiveIds(),

  loadSkills: async () => {
    if (!window.api) return
    const result = await window.api.skills.list()
    if (result.success) {
      const skills = (result.data as Skill[]) ?? []
      // Prune here too, not only in setSkillsFromEvent: this is the path that runs at startup, so
      // it is where a persisted id for a since-deleted skill would otherwise survive. An unknown id
      // is harmless downstream (resolveActiveSkills drops it) but it would show as an enabled skill
      // that does nothing — the precise illusion this work exists to remove.
      get().setSkillsFromEvent(skills)
    }
  },

  setSkillsFromEvent: (skills: Skill[]) => {
    const valid = new Set(skills.map((s) => s.id))
    set((state) => {
      const activeSkillIds = state.activeSkillIds.filter((id) => valid.has(id))
      // Persist the PRUNED set: a deleted skill must not linger in localStorage and reappear the
      // next time the list is slow to load.
      if (activeSkillIds.length !== state.activeSkillIds.length) writeActiveIds(activeSkillIds)
      return { skills, activeSkillIds }
    })
  },

  toggleSkill: (id: string) => {
    set((state) => {
      const activeSkillIds = state.activeSkillIds.includes(id)
        ? state.activeSkillIds.filter((x) => x !== id)
        : [...state.activeSkillIds, id]
      writeActiveIds(activeSkillIds)
      return { activeSkillIds }
    })
  },

  setActiveSkillIds: (ids: string[]) => {
    writeActiveIds(ids)
    set({ activeSkillIds: ids })
  },

  createSkill: async (input) => {
    if (!window.api) return
    const result = await window.api.skills.create(input)
    if (result.success) {
      toast.success(`Skill "${input.name}" created`)
    } else {
      toast.error(`Failed to create skill: ${result.error}`)
    }
    await get().loadSkills()
  },

  updateSkill: async (id, input) => {
    if (!window.api) return
    const result = await window.api.skills.update(id, input)
    if (!result.success) toast.error(`Failed to save skill: ${result.error}`)
    await get().loadSkills()
  },

  deleteSkill: async (id) => {
    if (!window.api) return
    const name = get().skills.find((s) => s.id === id)?.name ?? 'Skill'
    const result = await window.api.skills.delete(id)
    if (result.success) {
      // The handler archives the prior bytes before unlinking, so say so — the bare
      // `deleted` toast read as irreversible and gave a mis-targeted delete (the list
      // shows near-identical names) no hint that the skill is still recoverable.
      const archivePath = (result.data as { archivePath?: string } | null)?.archivePath
      toast.success(
        archivePath ? `Skill "${name}" deleted — copy kept at ${archivePath}` : `Skill "${name}" deleted`
      )
    } else {
      toast.error(`Failed to delete skill: ${result.error}`)
    }
    set((state) => {
      const activeSkillIds = state.activeSkillIds.filter((x) => x !== id)
      // PERSIST the removal. Every other mutation in this store calls writeActiveIds;
      // delete updated only the in-memory list, so the deleted id stayed in
      // localStorage. Recreate a skill with the same id later and it came back
      // already-active, silently, because the stale entry had never been cleared.
      if (activeSkillIds.length !== state.activeSkillIds.length) writeActiveIds(activeSkillIds)
      return { activeSkillIds }
    })
    await get().loadSkills()
  }
}))

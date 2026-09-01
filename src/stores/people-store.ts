import { create } from 'zustand'
import { type Person, loadPeople, savePeople, newPersonId } from '@/lib/people'

interface PeopleState {
  people: Person[]
  add: (p: Omit<Person, 'id'>) => void
  /** Add a person while PRESERVING a supplied id (e.g. a brain graph node id),
   *  so a derived person promoted to a manual entry keeps the id graph-focus
   *  relies on. No-op if the id is already tracked. */
  track: (p: Person) => void
  update: (id: string, patch: Partial<Person>) => void
  remove: (id: string) => void
}

export const usePeopleStore = create<PeopleState>((set, get) => ({
  people: loadPeople(),
  add: (p) => {
    const next = [...get().people, { ...p, id: newPersonId() }]
    savePeople(next)
    set({ people: next })
  },
  track: (p) => {
    if (!p.id || get().people.some((x) => x.id === p.id)) return
    const next = [...get().people, p]
    savePeople(next)
    set({ people: next })
  },
  update: (id, patch) => {
    const next = get().people.map((x) => (x.id === id ? { ...x, ...patch } : x))
    savePeople(next)
    set({ people: next })
  },
  remove: (id) => {
    const next = get().people.filter((x) => x.id !== id)
    savePeople(next)
    set({ people: next })
  }
}))

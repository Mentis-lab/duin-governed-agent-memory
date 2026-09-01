// people.ts — DUIN's People model: the relationships your second brain holds
// for you. Who you track, what you OWE them, and when you last touched base.
// v1 persists to localStorage (renderer-only, zero setup); the documented
// upgrade path is a SQLite store + auto-population from notes-extraction
// (people + owed-items mentioned in your notes).

export interface Person {
  id: string
  name: string
  /** Role / org — e.g. "Tencent Japan" or "PMO". */
  role?: string
  /** Which track/stream this person belongs to (links to the brain graph). */
  track?: string
  /** What you OWE them right now (a reply, a decision, a deliverable). Empty = clear. */
  owed?: string
  /** ISO date (YYYY-MM-DD) of last contact. */
  lastContact?: string
}

const KEY = 'duin.people.v1'

export function loadPeople(): Person[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? (parsed as Person[]).filter((p) => p && p.id && p.name) : []
  } catch {
    return []
  }
}

export function savePeople(people: Person[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(people))
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function newPersonId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `person-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  }
}

/**
 * Sort for the People view (PURE): people you OWE first (the nudge), then by
 * oldest last-contact (who you've gone quiet on), then by name. This is what
 * makes People a brain surface, not just a contact list.
 */
export function sortedByOwed(people: Person[]): Person[] {
  return [...people].sort((a, b) => {
    const ao = a.owed?.trim() ? 1 : 0
    const bo = b.owed?.trim() ? 1 : 0
    if (ao !== bo) return bo - ao
    const ac = a.lastContact || ''
    const bc = b.lastContact || ''
    if (ac !== bc) return ac.localeCompare(bc) // oldest contact first
    return a.name.localeCompare(b.name)
  })
}

/** Count of people you currently owe something — drives a badge. */
export function owedCount(people: Person[]): number {
  return people.filter((p) => p.owed?.trim()).length
}

/** A person DUIN derived from the brain graph/notes (id = graph node id). */
export interface DerivedPersonInput {
  id: string
  name: string
  note?: string
  mentions?: number
}

/**
 * Merge manual people with people DUIN derived from the brain (PURE). Manual
 * entries are authoritative; a derived person is appended ONLY when it isn't
 * already tracked manually — matched by id OR by case-insensitive name (so a
 * "Jordan" you added by hand isn't duplicated by the constructed
 * `person:jordan` entity). Derived entries carry their graph id so clicking
 * focuses the right node. Order: manual first, then derived.
 */
export function mergeDerivedPeople(manual: Person[], derived: DerivedPersonInput[]): Person[] {
  const seenIds = new Set(manual.map((p) => p.id))
  const seenNames = new Set(manual.map((p) => p.name.trim().toLowerCase()))
  const extra: Person[] = []
  for (const d of derived) {
    const nameKey = d.name.trim().toLowerCase()
    if (!d.id || !nameKey) continue
    if (seenIds.has(d.id) || seenNames.has(nameKey)) continue
    seenIds.add(d.id)
    seenNames.add(nameKey)
    extra.push({ id: d.id, name: d.name })
  }
  return [...manual, ...extra]
}

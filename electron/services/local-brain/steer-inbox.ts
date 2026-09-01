// steer-inbox.ts — Composer STEERING: a pure, in-memory mailbox of user text injected INTO a
// running turn. The gap it closes: today a message typed while the model is mid-turn can only be
// QUEUED as a whole new turn — it can't nudge the turn already in flight ("actually, skip the
// tests", "focus on the auth module"). This inbox lets a between-round drain in the server round
// loop (server.ts) pull pending steer text and splice it in as a role:user message at the CLEAN
// round boundary (after that round's tool_result messages are pushed), so a user message never
// splits an assistant tool_calls/tool_result pair.
//
// PURE + self-contained (no I/O, no server deps) so it unit-tests against its invariants exactly.
// One SteerInbox is composed onto each RunState (agui-run.ts), which delegates pushSteer /
// drainSteers / hasPendingSteer to it. The steer beacon (a separate POST, mirroring the Stop
// beacon) calls pushSteer; the round loop calls hasPendingSteer + drainSteers.

// Idempotency ledger cap. A re-delivered steer (client retry, double-fire) carries the same
// steerId and must inject at most once; we remember seen ids to dedup. Bounded so a long turn's
// steer stream can't grow the Set unbounded — oldest-first eviction, FIFO.
const MAX_SEEN_IDS = 512

export class SteerInbox {
  // Pending steer texts, oldest→newest; drained (and cleared) at the round seam.
  private steers: string[] = []
  // Ids already accepted, for idempotency. A repeat id is a no-op (never a second inject).
  private seenSteerIds = new Set<string>()

  /** Whether any steer text is waiting to be injected. */
  get hasPendingSteer(): boolean {
    return this.steers.length > 0
  }

  /** How many steer texts are currently buffered (post any dedup). */
  get pendingCount(): number {
    return this.steers.length
  }

  /**
   * Buffer a steer for the next round-boundary drain. Empty/whitespace text is ignored. When `id`
   * is supplied it is idempotent — a repeat id is dropped (returns false) so a client retry can't
   * double-inject. Returns true when the text was newly buffered.
   */
  pushSteer(text: string, id?: string): boolean {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t) return false
    if (id) {
      if (this.seenSteerIds.has(id)) return false
      this.seenSteerIds.add(id)
      // FIFO-evict the oldest remembered id when over the cap (Set preserves insertion order).
      if (this.seenSteerIds.size > MAX_SEEN_IDS) {
        const oldest = this.seenSteerIds.values().next().value
        if (oldest !== undefined) this.seenSteerIds.delete(oldest)
      }
    }
    this.steers.push(t)
    return true
  }

  /** Return and CLEAR every pending steer text (oldest→newest). The seen-id ledger is kept so a
   *  late duplicate of an already-drained steer still can't re-inject. */
  drainSteers(): string[] {
    const out = this.steers
    this.steers = []
    return out
  }
}

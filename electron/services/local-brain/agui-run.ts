import { messageOf } from '../guarded'
import { SteerInbox } from './steer-inbox'
// agui-run.ts — turn-survival + bounded frame-replay ring for resumable /agui SSE streams
// (Architecture reconciled-plan step 3, the pure core). The gap it closes: today a client that
// drops mid-turn (sleep, network blip, reload) LOSES the turn — the server aborts on socket close
// and the model's in-flight output is gone. This is the state machine that lets a reconnecting
// client replay what it missed instead.
//
// A RunState buffers the frames a turn emits, each keyed by a MONOTONIC id, so a reconnect with a
// Last-Event-ID can `replayAfter(lastId)`. The ring is BOUNDED by a frame AND a byte cap so a long
// turn can't grow memory unbounded — but eviction drops the OLDEST frame ONLY when it has already
// been delivered to the current subscriber. An un-delivered frame is never dropped (the client has
// not seen it yet), so bounding memory never costs correctness.
//
// PURE + self-contained (no I/O, no server deps) so it unit-tests against its invariants exactly.
// It IS wired into the live loop (server.ts handleAgui: mint runId → capture on emit → close→detach
// +30s grace instead of close→abort → replay on reconnect, in BOTH SSE clients, with a Stop beacon
// for deliberate aborts). DUIN_TURN_RESUME is now DEFAULT ON; set it to 0 to restore close→abort.

export interface RunFrame {
  id: number
  data: string
  bytes: number
}

export interface RunStateOpts {
  maxFrames?: number
  maxBytes?: number
}

// Defaults: a normal turn emits a few hundred delta frames; 2000 frames / 4 MB comfortably holds a
// large turn's undelivered tail while bounding a pathological one.
const DEFAULT_MAX_FRAMES = 2000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export class RunState {
  readonly runId: string
  private frames: RunFrame[] = []
  private nextId = 1
  private bytes = 0
  private deliveredUpTo = 0 // highest frame id confirmed written to the current subscriber
  private terminal = false
  private subscriber: symbol | null = null // single-subscriber token (a reconnect supersedes)
  private writer: ((bytes: string) => boolean) | null = null // where the current subscriber's bytes go
  private readonly maxFrames: number
  private readonly maxBytes: number

  constructor(runId: string, opts: RunStateOpts = {}) {
    this.runId = runId
    this.maxFrames = Math.max(1, opts.maxFrames ?? DEFAULT_MAX_FRAMES)
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES)
  }

  get isTerminal(): boolean {
    return this.terminal
  }
  /** The id of the most recently emitted frame (0 before the first emit). */
  get lastId(): number {
    return this.nextId - 1
  }
  /** How many frames are currently buffered (post-eviction). */
  get size(): number {
    return this.frames.length
  }
  /** Current buffered byte total (post-eviction). */
  get byteSize(): number {
    return this.bytes
  }

  /** Append a frame, assign the next monotonic id, enforce the caps. Returns the stored frame. */
  emit(data: string): RunFrame {
    const frame: RunFrame = { id: this.nextId++, data, bytes: Buffer.byteLength(data, 'utf8') }
    this.frames.push(frame)
    this.bytes += frame.bytes
    this.evict()
    return frame
  }

  /** Drop the oldest frames while over a cap — but ONLY frames already delivered to the subscriber.
   *  An undelivered frame at the head stops eviction (it must still reach the client). */
  private evict(): void {
    while (
      this.frames.length > 0 &&
      (this.frames.length > this.maxFrames || this.bytes > this.maxBytes) &&
      this.frames[0].id <= this.deliveredUpTo
    ) {
      const dropped = this.frames.shift() as RunFrame
      this.bytes -= dropped.bytes
    }
  }

  /** The still-buffered frames with id > lastId — what a reconnecting client missed. Marks them
   *  delivered (the caller is about to write them to the reattached subscriber). */
  replayAfter(lastId: number): RunFrame[] {
    const out = this.frames.filter((f) => f.id > lastId)
    if (out.length) this.markDelivered(out[out.length - 1].id)
    return out
  }

  /** Confirm frames up to `id` have been written to the subscriber (so they become evictable).
   *  Monotonic — a lower id never rewinds delivery. */
  markDelivered(id: number): void {
    if (id > this.deliveredUpTo) {
      this.deliveredUpTo = id
      this.evict()
    }
  }

  /** Claim the single subscriber slot with the writer that receives this run's bytes; returns a
   *  token. A new attach supersedes the prior one, so a mid-turn reconnect cleanly redirects output
   *  to the new connection (single-subscriber invariant). The writer is optional so existing
   *  callers/tests that only need the token still work. */
  attach(writer?: (bytes: string) => boolean): symbol {
    const token = Symbol('agui-sub')
    this.subscriber = token
    this.writer = writer ?? null
    return token
  }

  /** Release the subscriber slot iff `token` still owns it (a superseded token is a no-op). */
  detach(token: symbol): void {
    if (this.subscriber === token) {
      this.subscriber = null
      this.writer = null
    }
  }

  /** Write bytes to the CURRENTLY-attached subscriber (the reconnect-aware target). Returns false
   *  when nobody is attached (the turn keeps running; frames are still buffered in the ring). */
  write(bytes: string): boolean {
    return this.writer ? this.writer(bytes) : false
  }

  /** Whether `token` is the current subscriber (a superseded writer should stop emitting). */
  isCurrent(token: symbol): boolean {
    return this.subscriber === token
  }

  /** Whether anyone is attached. */
  get hasSubscriber(): boolean {
    return this.subscriber !== null
  }

  // Composer STEERING inbox (steer-inbox.ts). Holds user text injected INTO this running turn via
  // the steer beacon; the round loop drains it at the clean round seam. In-memory, per-run.
  private readonly steerInbox = new SteerInbox()

  /** Buffer a steer for injection at the next round boundary. Idempotent on `id` (a repeat is a
   *  no-op). Returns true when newly buffered. Called by the steer beacon (server.ts). */
  pushSteer(text: string, id?: string): boolean {
    return this.steerInbox.pushSteer(text, id)
  }

  /** Return + CLEAR the pending steer texts (oldest→newest) for the round loop to splice in. */
  drainSteers(): string[] {
    return this.steerInbox.drainSteers()
  }

  /** Whether any steer is waiting to be injected. */
  get hasPendingSteer(): boolean {
    return this.steerInbox.hasPendingSteer
  }

  private doneListeners: Array<() => void> = []
  private abortFn: (() => void) | null = null

  /** Register how to abort the underlying turn (the handler's turnAbort). Lets a Stop beacon on a
   *  SEPARATE request stop THIS run immediately instead of waiting out the disconnect grace. */
  setAbort(fn: () => void): void {
    this.abortFn = fn
  }

  /** Deliberately abort this run's turn now (Stop button, via the beacon). Idempotent + safe. */
  abort(): void {
    const fn = this.abortFn
    if (fn) {
      try {
        fn()
      } catch (e) { console.debug('[agui-run] aborting must never throw:', messageOf(e)) }
    }
  }

  /** Mark the turn terminal (RUN_FINISHED / RUN_ERROR emitted) and wake any reconnect parked on it. */
  done(): void {
    if (this.terminal) return
    this.terminal = true
    const ls = this.doneListeners
    this.doneListeners = []
    for (const l of ls) {
      try {
        l()
      } catch (e) { console.debug('[agui-run] a listener must not break done():', messageOf(e)) }
    }
  }

  /** Resolves when the turn goes terminal — lets a reconnected subscriber park until the run
   *  finishes (already-terminal resolves immediately). */
  whenDone(): Promise<void> {
    return this.terminal ? Promise.resolve() : new Promise<void>((resolve) => this.doneListeners.push(resolve))
  }
}

// The live run registry. Bounded so a burst of turns can't grow it unbounded; terminal runs are
// evicted first, then oldest-first (Map preserves insertion order).
export const MAX_SESSIONS = 64
export const SESSIONS = new Map<string, RunState>()

/** Register a fresh run under `runId` (replaces any prior run with that id). */
export function createRun(runId: string, opts?: RunStateOpts): RunState {
  const rs = new RunState(runId, opts)
  SESSIONS.set(runId, rs)
  evictSessions()
  return rs
}

export function getRun(runId: string): RunState | undefined {
  return SESSIONS.get(runId)
}

export function dropRun(runId: string): void {
  SESSIONS.delete(runId)
}

/** Keep SESSIONS under the ceiling: evict terminal runs oldest-first, then any runs oldest-first. */
function evictSessions(): void {
  if (SESSIONS.size <= MAX_SESSIONS) return
  for (const [id, rs] of SESSIONS) {
    if (SESSIONS.size <= MAX_SESSIONS) break
    if (rs.isTerminal) SESSIONS.delete(id)
  }
  for (const id of SESSIONS.keys()) {
    if (SESSIONS.size <= MAX_SESSIONS) break
    SESSIONS.delete(id)
  }
}

/** Whether mid-turn resume is switched on. Default ON: a dropped connection detaches + graces
 *  (clients auto-reconnect and replay), and a deliberate Stop aborts immediately via the Stop
 *  beacon. DUIN_TURN_RESUME=0 restores the old close→abort, byte-identical streaming hot path. */
export function turnResumeEnabled(): boolean {
  return process.env.DUIN_TURN_RESUME !== '0'
}

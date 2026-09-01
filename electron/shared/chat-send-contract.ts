// chat-send-contract.ts — THE single source of truth for what the composer sends on `chat:send`,
// and what happens to each field on the way to the brain.
//
// WHY THIS FILE EXISTS (the defect it prevents):
// The chat payload used to be declared THREE times, independently — the preload request type
// (preload.ts), the transport options (duin-bridge.ts DuinStreamOptions), and the literal /agui POST
// body (duin-bridge.ts buildAguiBody). Nothing related them. So when `activeSkillIds` was validated,
// sent across IPC, and then never forwarded, NOTHING failed: not the typechecker, not a test, not the
// runtime. The value simply evaporated at the `if (!rawBypass) { … return }` branch in ipc/chat.ts,
// and the Skills toggle silently changed nothing on the default chat path. The 2026-07-20 UI/engine
// coherence audit found three live instances of this exact shape.
//
// THE FIX: every key of ChatSendRequest must be classified below. CHAT_SEND_DISPOSITION is typed
// `Record<ChatSendKey, Disposition>`, so ADDING A FIELD TO THE REQUEST WITHOUT SAYING WHERE IT GOES
// IS A COMPILE ERROR. A field may legitimately be renderer-only or transformed — but that has to be
// a decision someone wrote down, not an omission nobody noticed.
//
// See PLANNING/DUIN_UI_ENGINE_COHERENCE_2026-07-20.md §5A ("the transport cliff").

/** Graph node a conversation is pinned to. */
export interface ChatContextRef {
  id: string
  label: string
  kind: string
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/**
 * The composer's permissions pill. Mirrors `src/lib/mode-cycle.ts:PermissionsMode` — defined here
 * (rather than imported across the src/electron boundary) so the renderer contract and the main-side
 * classification share one type without a cross-tsconfig import. Forwarded to the /agui body, where
 * the brain maps it to an enforcement posture (see agui-approval.resolveTurnPosture / pillToPosture).
 */
export type PermissionsMode = 'default' | 'auto-review' | 'full'

/**
 * The language a turn asks the assistant to REPLY in. Only the three EXPLICIT choices ride the wire;
 * the settings-level 'auto' (follow the OS locale for the UI, pin nothing for the reply) is
 * represented by OMITTING the field — so a turn that carries no language produces byte-for-byte
 * today's request and the brain emits no directive. Forwarded to the /agui body, where the brain
 * renders it as a floor-tier response-language directive (see local-brain/language-directive.ts).
 */
export type LanguageChoice = 'en' | 'zh' | 'ja'

/**
 * A user-authored Skill (Customize → Skills), RESOLVED from its id to its body in the main process
 * and sent to the brain on the /agui body. Ids are resolved main-side rather than forwarded raw
 * because the skill store is a main-process concern — the brain should not need to know where
 * skills live on disk to honour one.
 */
export interface ResolvedSkill {
  name: string
  content: string
  description?: string
  /** Advisory only today — rendered into the block, not enforced at the gate. */
  allowedTools?: string[]
}

/**
 * One image attachment on a turn. `dataUrl` is a self-describing base64 `data:` URL, so the brain
 * needs no side-channel to know the encoding; `mimeType` is kept alongside it for validation and for
 * providers that want it stated separately.
 */
export interface VisionImage {
  mimeType: string
  dataUrl: string
}

/**
 * A `VisionImage` in its OpenAI wire form — the shape `buildAguiBody` folds into `messages`, and the
 * shape persisted in `messages.content_parts`. Kept alongside `VisionImage` so the wire form and the
 * stored form cannot drift apart: they are the same bytes at both ends of the round trip.
 *
 * Only non-text parts are stored. The text of a turn stays in `messages.content`, which remains the
 * single thing display / export / sanitization / FTS read.
 */
export type VisionContentPart = { type: 'image_url'; image_url: { url: string } }

/** Widen a stored image part back to the request shape. `mimeType` is recoverable from the data URL. */
export function partsToImages(parts: VisionContentPart[]): VisionImage[] {
  return parts.map((p) => ({
    mimeType: /^data:([^;,]+)/.exec(p.image_url.url)?.[1] ?? 'image/png',
    dataUrl: p.image_url.url
  }))
}

/** Narrow request images to the stored/wire part shape. */
export function imagesToParts(images: VisionImage[]): VisionContentPart[] {
  return images.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } }))
}

/**
 * What the renderer sends on `chat:send`. THE canonical shape — preload imports this type rather
 * than re-declaring it, so the renderer-facing contract and the classification below cannot drift.
 */
export interface ChatSendRequest {
  conversationId: string
  model: string
  content: string
  /** Skills the user has toggled on for this turn. */
  activeSkillIds: string[]
  /** Node the chat is scoped to, so the brain grounds on an exact note id, not a prose label. */
  context?: ChatContextRef
  /** Per-conversation reasoning-effort override for this turn. */
  reasoningEffort?: ReasoningEffort
  /**
   * The composer's permissions pill for this turn. Forwarded to the /agui body; the brain resolves
   * it against the env posture (env is a FLOOR — the pill may only TIGHTEN, never loosen). Absent /
   * garbled → the brain falls back to today's env-only posture. See agui-approval.resolveTurnPosture.
   */
  permissionsMode?: PermissionsMode
  /**
   * Response language for this turn. Forwarded to the /agui body; the brain injects a floor-tier
   * directive so the reply is written in this language regardless of the language of the retrieved
   * notes. Absent → no directive → byte-for-byte the old body (the settings-level 'auto' resolves to
   * absent). The main process fills it from the persisted `language` setting when a headless/loop
   * turn sends none.
   */
  language?: LanguageChoice
  /**
   * Vision attachments for this turn, as base64 `data:` URLs. Present ONLY when the resolved answer
   * model supports vision (see chat-store.sendMessage) — on a text-only model the image is instead
   * carried as an OCR text block inside `content`, so this field is absent and the body is
   * byte-for-byte the old shape.
   *
   * NOTE: this field rode the wire UNDECLARED until 2026-07-28. It evaded this very contract because
   * the renderer spreads it conditionally (`...(imgs.length ? { images } : {})`), and TypeScript's
   * excess-property check does not fire on a spread — only on a direct object literal. That is the
   * exact class of silent-drop defect this file exists to prevent, so it is declared here now.
   */
  images?: VisionImage[]
}

export type ChatSendKey = keyof ChatSendRequest

/**
 * What the renderer sends on `chat:steer` — composer STEERING. This is a SEPARATE channel from
 * `chat:send` (it does not start a turn), so it is NOT part of CHAT_SEND_DISPOSITION. The main
 * process resolves `conversationId` to the FOREGROUND streaming run's runId and fires a steer beacon
 * at the brain, which injects `text` into that running turn at its next round boundary. `steerId`
 * makes the beacon idempotent so a client retry injects at most once.
 */
export interface ChatSteerRequest {
  conversationId: string
  text: string
  steerId?: string
}

/** What becomes of one request field on the default (brain) path. */
export type Disposition =
  /** Copied onto the /agui POST body under `bodyField`, unchanged. */
  | { kind: 'forwarded'; bodyField: string }
  /** Reaches the brain, but reshaped first (so a name-match check would not find it). */
  | { kind: 'transformed'; bodyField: string; note: string }
  /**
   * Deliberately NOT sent to the brain. `reason` must say why. `openDefect` marks a field that is
   * not-forwarded by ACCIDENT rather than by design — it is a known gap, recorded here so it is
   * visible in the type system instead of being invisible in a branch.
   */
  | { kind: 'not-forwarded'; reason: string; openDefect?: string }

/**
 * EXHAUSTIVE classification. The Record type is the enforcement: a new key on ChatSendRequest with
 * no entry here fails `npm run typecheck`.
 */
export const CHAT_SEND_DISPOSITION: Record<ChatSendKey, Disposition> = {
  conversationId: {
    kind: 'transformed',
    bodyField: 'threadId',
    note: 'the conversation id IS the brain thread id; renamed on the wire'
  },
  content: {
    kind: 'transformed',
    bodyField: 'messages',
    note: 'folded into the messages array as the final user turn (with prior history when present)'
  },
  model: { kind: 'forwarded', bodyField: 'model' },
  context: { kind: 'forwarded', bodyField: 'context' },
  reasoningEffort: { kind: 'forwarded', bodyField: 'reasoningEffort' },
  permissionsMode: { kind: 'forwarded', bodyField: 'permissionsMode' },
  language: { kind: 'forwarded', bodyField: 'language' },
  images: {
    kind: 'transformed',
    bodyField: 'messages',
    note:
      'Folded into the messages array rather than sent as a sibling field: buildAguiBody rewrites the ' +
      'LAST user message from a plain string into the OpenAI multimodal form ' +
      '[{type:"text",text}, {type:"image_url",image_url:{url:dataUrl}}, …]. Absent → the message stays ' +
      'a plain string and the body is byte-for-byte the pre-vision shape.'
  },
  activeSkillIds: {
    kind: 'transformed',
    bodyField: 'skills',
    note:
      'Ids are RESOLVED main-side (listSkills + getSkillContent) into ResolvedSkill bodies and sent ' +
      'as `skills`, because the skill store is a main-process concern. The brain injects them as a ' +
      'floor-tier ACTIVE SKILLS block in agui-grounding, so an explicitly-enabled skill is never ' +
      'dropped under context-budget pressure.'
  }
}

/** Keys copied verbatim onto the /agui body. Derived, so it cannot drift from the table. */
export const FORWARDED_KEYS = (Object.keys(CHAT_SEND_DISPOSITION) as ChatSendKey[]).filter(
  (k) => CHAT_SEND_DISPOSITION[k].kind === 'forwarded'
)

/** Keys that do NOT reach the brain, each with a recorded reason. */
export const NOT_FORWARDED_KEYS = (Object.keys(CHAT_SEND_DISPOSITION) as ChatSendKey[]).filter(
  (k) => CHAT_SEND_DISPOSITION[k].kind === 'not-forwarded'
)

/** Known gaps — non-empty means a field is dropped by accident, not by design. */
export const OPEN_TRANSPORT_DEFECTS = NOT_FORWARDED_KEYS.filter((k) => {
  const d = CHAT_SEND_DISPOSITION[k]
  return d.kind === 'not-forwarded' && !!d.openDefect
})

/** Compile-time: every forwarded key must be a real field on the request. */
export type ForwardedKey = Extract<
  ChatSendKey,
  'model' | 'context' | 'reasoningEffort' | 'permissionsMode' | 'language'
>

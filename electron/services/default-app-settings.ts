// SP-1 (Sweet Spot Phase, 2026-06-10) — the canonical AppSettings defaults.
//
// Before this phase the default object was maintained BY HAND in two places —
// `src/stores/settings-store.ts` (renderer) and `electron/ipc/settings.ts`
// (main) — and had drifted on two keys: the renderer said `agentMode: 'auto'`
// (L8) while main said `'single'`, and main was missing
// `includePastReasoningInContext` entirely. Because `settings:get` merges
// `{...defaults, ...data}` main-side, the MAIN values silently won for any key
// the user never set. That is defect D1 in PLANNING/SP_BASELINE.md.
//
// This module is now the single source of truth for the main process. The
// renderer cannot import across the tsconfig project boundary (web includes
// `src/**` only; node includes `electron/**` only — see the WC-8 precedent of
// source-reading parity tests), so `src/stores/settings-store.ts` keeps a
// literal copy that `default-app-settings.test.ts` locks byte-for-byte against
// this object. Change a default here → the parity test names the renderer line
// that must move with it.
//
// Era values (Sweet Spot Phase §4 decision register):
//   agentMode 'single'  — the Opus 4.5-era product never auto-fanned a turn
//                         into a planner→coder→reviewer pipeline. 'auto' and
//                         'multi' remain one click away in Settings → Agents.
//   proofGate 'off'     — no trust-pill machinery on default turns.
//   toolSurface 'full'  — the model gets its full tool set every turn, like
//                         the era product. 'lazy' remains the MCP-heavy opt-in.

// UB-7 (Unburdening Phase, 2026-06-10) — `agentMode`, `agentRoster`,
// `proofGate`, and `agenticCodingComposer` retired with the pipeline, proof
// machinery, and composer excisions. Stale keys in existing settings.json
// files are inert: nothing reads them.
export interface DefaultAppSettings {
  theme: 'dark'
  themePreset: string
  themeMode: 'light' | 'dark'
  /** Brain graph color scheme id ('default' | 'aurora' | 'precious' | 'ember').
   *  Mirrors AppSettings.brainGraphScheme; kept as a string to avoid a
   *  cross-tsconfig import. */
  brainGraphScheme: string
  /** Recall-style brain-graph force + depth controls. Four force axes normalized
   *  0..100 (50 = today's d3-force defaults) + a 1..5 N-hop focus depth. Mirrors
   *  AppSettings.brainGraphLayout. */
  brainGraphLayout: {
    nodeSpacing: number
    linkLength: number
    linkForce: number
    centerForce: number
    connectionDepth: number
  }
  fontSize: number
  /** Chat transcript reading size in px (see src/styles/apply-theme applyChatFontSize). */
  chatFontSize: number
  /** Extra absolute paths the sandboxed shell may WRITE to, beyond the vault and
   *  $TMPDIR. Empty by default — the sandbox stays deny-by-default and only the
   *  operator can widen it. See sandbox/darwin.ts and sandbox/linux.ts. Used only in
   *  confined mode (fullComputerAccess=false). */
  sandboxWritePaths: string[]
  /** Full computer access. OFF by default: a fresh install is CONFINED to the vault + active
   *  workspace + sandboxWritePaths, with host-exec and irreversible file ops behind the
   *  exec-token gate and per-action approvals. When the operator turns it on (Settings →
   *  General → Computer access, or the onboarding toggle) the agent's file tools, file browser,
   *  and sandboxed shell are UNCONFINED — DUIN acts anywhere on the machine, on every turn
   *  including inbound channels, with no folder to pre-declare. The catastrophic-command floor
   *  and .trash reversibility hold in BOTH modes. Mirrors AppSettings.fullComputerAccess. */
  fullComputerAccess: boolean
  /** Response language. 'auto' = emit NO reply-language directive (byte-identical default);
   *  'en' | 'zh' | 'ja' pin the assistant's user-visible prose. Mirrors AppSettings.language. */
  language: 'auto' | 'en' | 'zh' | 'ja'
  defaultModel: string
  /** Background model — the LLM for DUIN's OWN structured work (note extraction, conversation
   *  titles), separate from the chat model. '' = Auto (each provider's designated fast model,
   *  registry EXTRACTION_DEFAULT); a model id pins it. Mirrors AppSettings.backgroundModel. */
  backgroundModel: string
  /** F3 — the LLM that powers the brain's language ("engine"). 'auto' = resolve
   *  (BYO key → Ollama → keyless). The brain is the harness; this is just its engine. */
  brainEngine: string
  /** DUIN — endpoint of the agent/DUIN brain (AG-UI). Empty string = use
   *  the DUIN_BRAIN_URL env var / localhost default. */
  brainUrl: string
  /** DUIN — optional live graph endpoint for the Brain view. Empty = the
   *  bundled demo graph. */
  brainGraphUrl: string
  /** DUIN — folder of notes the built-in local brain indexes. Empty = the
   *  demo graph; no notes indexed. */
  localBrainNotesDir: string
  sidebarCollapsed: boolean
  artifactPanelWidth: number
  minimizeToTray: boolean
  autoCheckUpdates: boolean
  aiGeneratedTitles: boolean
  modelConfig: Record<string, unknown>
  customModels: unknown[]
  toolSurface: 'lazy' | 'full'
  agenticCodingMode: boolean
  agenticCodingSkills: string[]
  snipEnabled: boolean
  snipVerbose: boolean
  safeSeedLength: number
  includePastReasoningInContext: boolean
  // Loop Phase LP-7 — autonomous loops, OFF by default (deliberate past-era
  // extension; power machinery is opt-in, never default).
  loopsEnabled: boolean
  loopMaxIterations: number
  loopMaxWallclockMs: number
  loopTokenBudget: number
  loopMaxConcurrent: number
  loopMinIntervalSeconds: number
  // Headless agentic executor kill switch — when OFF, background runs
  // (loops/automations) NEVER execute tools unattended. Default OFF: autonomous
  // tool use (writing your files without you watching) is opt-in, never default.
  backgroundAutonomy: boolean
  // Release M11 — has the operator consented to DUIN sending vault content to a CLOUD model
  // on its own (boot-time extraction→construction, edit-driven rebuilds)? Default false.
  // Recorded by settings:saveProviderKey the moment a key is saved after the disclosure line
  // (key modal / Settings → API keys / onboarding). backgroundAutonomy also authorizes the
  // same work; a local (Ollama) route needs neither. See brain/cloud-consent.ts.
  cloudExtractionConsent: boolean
  // Scheduled cron automations, separately. `backgroundAutonomy` stays the master
  // kill switch, but it also arms the self-improve tick — so turning it on for THAT
  // silently armed every enabled cron to dispatch billable agents, which is the
  // coupling behind the "QA every-min" runaway. Cron dispatch now needs its own
  // deliberate yes; the master switch can still stop everything.
  automationsEnabled: boolean
  // Master kill-switch for lifecycle hooks (they run code). Default ON — hooks are
  // core to agent work. The RCE boundary is CREATE-TIME approval: hooks:create/update/
  // test each require a native main-process confirmation the renderer can't fake, so an
  // injected script cannot silently persist or run a hook. Set false to hard-disable.
  enableHooks: boolean
  // OCR (image & scanned-doc text extraction). Default ON now that OCR is proven:
  // it's best-effort (no bundled models → empty text, never a crash), so on-by-
  // default is safe and makes pasted screenshots searchable out of the box. The
  // `DUIN_OCR` env var still overrides this (e.g. `DUIN_OCR=0` force-off for debug).
  ocrEnabled: boolean
  // OCR engine. 'tesseract' (Tier-1 default) or 'paddle' (local PP-OCRv5, higher
  // CJK quality when its models are present). `DUIN_OCR_ENGINE` env overrides.
  ocrEngine: 'tesseract' | 'paddle'
  // TTS (text→speech OUTPUT modality). Default OFF: synthesis needs an OpenAI key
  // or a locally-installed `edge-tts` binary, so voice-out is opt-in. The `DUIN_TTS`
  // env var still overrides this (see tts-service.ttsEnabled).
  ttsEnabled: boolean
  // TTS backend. 'openai' (uses the existing OpenAI key) or 'edge' (zero-key local
  // `edge-tts` subprocess). `DUIN_TTS_PROVIDER` env overrides.
  ttsProvider: 'openai' | 'edge'
  // Proactive — the DEFAULT outbound destination for scheduled / agent-initiated
  // sends (the send_message tool with no explicit channel, and cron delivery).
  // {kind,target}; kind 'push' = OS notification, which needs no external creds,
  // so the safe default reaches the user without any channel wiring.
  homeChannel: { kind: string; target: string }
  // Ingest — RSS/Atom feed URLs the `rss` source adapter pulls on each sync.
  // Empty by default (no feeds → the adapter is unconfigured, pulls nothing).
  rssFeeds: string[]
  // Proactive approval loop (#1) — the DESIGNATED OPERATOR per channel. ONLY this
  // (channelId,userId) identity's reply may approve an AFK-gated action pushed to the
  // home channel; any other paired user's "yes" is refused + audited. Empty by
  // default (unset → no channel approval is possible; the gate stays fail-closed).
  // NOTE: "approved to chat" (pairing-store) is deliberately NOT the same as this
  // operator designation — approving a gated action needs this stronger identity.
  operator: { channelId: string; userId: string }
  // Proactive approval loop (#1) — how long an unanswered channel approval waits
  // before defaulting to DENY. 5 minutes by default.
  approvalTimeoutMs: number
  // Proactive watch/notify (#2) — event-driven push on real internal signals
  // (forecast resolving / calibration drift / new high-priority task / job fail).
  // Each watcher is INDIVIDUALLY enable-flagged and default OFF: a fresh install
  // pushes nothing until the operator opts a specific watcher in. driftThreshold =
  // |observed−expected| a confidence tier must exceed to fire a drift notice;
  // debounceMs coalesces a burst; quietHours (local-clock hours, start===end =
  // disabled, may wrap midnight) suppresses notices overnight.
  watchers: {
    forecast: boolean
    calibration: boolean
    task: boolean
    jobFail: boolean
    driftThreshold: number
    debounceMs: number
    quietHours: { start: number; end: number }
  }
  /** RAG block — partial by design (see the value comment). Only keys whose default must be
   *  stated main-side live here; the rest default at their read sites. */
  rag: { multiQueryRewrite: boolean }
}

export const DEFAULT_APP_SETTINGS: DefaultAppSettings = {
  theme: 'dark',
  themePreset: 'duin-warm',
  themeMode: 'dark', // cold-start default = warm dark (duin-warm preset, dark variant)
  // Brain graph color scheme — 'default' preserves the original DUIN palette.
  brainGraphScheme: 'default',
  // Brain graph force + depth (Recall-style). 50 = today's d3-force defaults on
  // every axis (so an untouched graph is identical); depth 2 = 2-hop focus.
  brainGraphLayout: { nodeSpacing: 50, linkLength: 50, linkForce: 50, centerForce: 50, connectionDepth: 2 },
  fontSize: 14,
  // 12px matches the surrounding UI chrome, which is why the transcript was pinned
  // there — it is now a floor the user can move rather than a constant they cannot.
  chatFontSize: 12,
  // Empty: the shell can write to the vault and $TMPDIR and nothing else. Writing a
  // project outside the vault is a legitimate thing to want, and until now there was
  // no way to allow it short of turning the sandbox off entirely (DUIN_SANDBOX=0),
  // which is a far bigger concession than "also let me write to ~/code".
  sandboxWritePaths: [],
  // Full computer access OFF by default (public build, release decision D6 2026-09-01). A fresh
  // install is CONFINED: file tools, the file browser, and the shell act only inside the vault,
  // the active workspace, and sandboxWritePaths; host-exec and irreversible file ops go through
  // the exec-token gate and per-action approvals, and an inbound channel turn can never run a
  // command. The operator turns it on in Settings → General → Computer access (or the onboarding
  // toggle), which makes DUIN a general computer-use agent — read/write/move/delete ANYWHERE, on
  // every turn including inbound channels. The 2026-08-22 "full access from cold start" directive
  // was for the owner's own machine; his install keeps it via the persisted setting, not via the
  // default. The catastrophic-command screen (format / rm -rf / / diskpart / shutdown) and the
  // .trash reversibility hold in BOTH modes. sandboxWritePaths above applies only when this is
  // false. The reader (sandbox/operator-write-paths.ts) is FAIL-CLOSED: missing or unreadable
  // resolves to confined.
  fullComputerAccess: false,
  // Language default 'auto' — emits no reply-language directive, so a fresh install is
  // byte-for-byte today's behaviour until the operator picks a language.
  language: 'auto',
  // DUIN — the brain is the default model for new conversations.
  defaultModel: 'duin-brain',
  // Background model '' = Auto: extraction/titles resolve per provider (registry
  // EXTRACTION_DEFAULT) for whatever key the operator has — no provider is assumed.
  backgroundModel: '',
  // F3 — engine powering the brain's language. 'auto' = resolve (key→Ollama→keyless).
  brainEngine: 'auto',
  brainUrl: '',
  brainGraphUrl: '',
  localBrainNotesDir: '',
  sidebarCollapsed: false,
  artifactPanelWidth: 420,
  minimizeToTray: false,
  autoCheckUpdates: true,
  aiGeneratedTitles: false,
  modelConfig: {},
  customModels: [],
  toolSurface: 'full',
  agenticCodingMode: false,
  agenticCodingSkills: ['plan', 'context', 'verify'],
  snipEnabled: true,
  snipVerbose: false,
  safeSeedLength: 8192,
  includePastReasoningInContext: true,
  loopsEnabled: false,
  loopMaxIterations: 25,
  loopMaxWallclockMs: 1800000,
  loopTokenBudget: 500000,
  loopMaxConcurrent: 1,
  loopMinIntervalSeconds: 30,
  backgroundAutonomy: false,
  // Release M11 — unattended cloud extraction is opt-in; set true by saving a provider key
  // after the disclosure (ipc/settings.ts saveProviderKey). See brain/cloud-consent.ts.
  cloudExtractionConsent: false,
  automationsEnabled: false,
  enableHooks: true,
  // OCR default-on (proven + best-effort). Env var (DUIN_OCR / DUIN_OCR_ENGINE)
  // still overrides the persisted setting; see rag/loaders/ocr.ts.
  ocrEnabled: true,
  ocrEngine: 'tesseract',
  // TTS default-off (opt-in; needs a key or the edge-tts binary). Env DUIN_TTS /
  // DUIN_TTS_PROVIDER still override the persisted values (see tts-service).
  ttsEnabled: false,
  ttsProvider: 'openai',
  // Proactive — default outbound channel. OS push needs no external credential.
  homeChannel: { kind: 'push', target: '' },
  // Ingest — RSS/Atom feeds for the `rss` source adapter. Empty = unconfigured.
  rssFeeds: [],
  // Proactive approval loop — designated operator (empty = unset → no channel
  // approval possible) + the AFK approval timeout before default-deny.
  operator: { channelId: '', userId: '' },
  approvalTimeoutMs: 300000,
  // Proactive watch/notify (#2) — watchers opt-in EXCEPT jobFail. Tuning:
  // driftThreshold 0.25, 5-min coalesce window, quiet-hours disabled (start===end).
  // jobFail defaults ON (QA 2026-08-24, F3): it only speaks when something broke — with it off,
  // a drained provider account failed the background extraction 705 times over ~2 weeks and
  // "Needs you" said "All caught up" throughout. The Notifications pane already calls this one
  // "the most useful one to leave on"; now the default agrees with the copy.
  watchers: {
    forecast: false,
    calibration: false,
    task: false,
    jobFail: true,
    driftThreshold: 0.25,
    debounceMs: 300000,
    quietHours: { start: 0, end: 0 }
  },
  // RAG — only the keys whose default must be STATED in the main process. Everything else in the
  // rag block resolves its own default at the read site (resolveRerankMode, `?? 8` etc.), and a
  // persisted rag block replaces this one wholesale ({...defaults, ...data} is shallow).
  // multiQueryRewrite is here because it gates a per-turn model call: with the planner now wired
  // (ipc/chat.ts), "unset" would be an ACCIDENTAL default rather than a chosen one. Off is the
  // choice — the rewrite buys recall on under-specified queries at the cost of a planner
  // round-trip on every turn, so it stays the operator's opt-in via Settings → RAG.
  rag: { multiQueryRewrite: false }
}

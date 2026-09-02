# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/Mentis-lab/duin-governed-agent-memory/security/advisories/new)
(the **Security** tab of the repository → **Report a vulnerability**). If that is unavailable
to you, mention `@Mentis-lab` in a minimal public issue that does not contain the details and a
maintainer will open a private channel. There is no security email address yet.

Include the affected version, platform and OS version, a reproduction, and the impact. We
acknowledge reports as promptly as we can and coordinate a fix and disclosure timeline with
you. Do not open a public issue for an unpatched vulnerability.

## Supported versions

Security fixes target the latest release only. Pin to a release tag and update when fixes land.

## Threat model

DUIN is a single-tenant desktop application. It runs under your user account, for one operator
on one machine, and does not try to isolate one user's data from another's on the same OS
account. Any local process running as you can read the files it writes.

Three things distinguish it from an ordinary desktop app and shape this policy:

1. **It runs an agent that can act on your machine.** Under your approval it reads and writes
   files, runs shell commands, talks to MCP servers, and spawns subagents.
2. **It reads untrusted text and treats it as input.** Your notes, fetched web pages, channel
   messages and MCP results all reach the model. Prompt injection is a stated threat class here,
   not an edge case.
3. **It talks to model providers you configure.** When a key is connected, your question plus
   relevant note excerpts go to that provider.

## Process boundaries

- **Renderer sandboxed.** The main window runs with `sandbox: true`, `contextIsolation: true`
  and `nodeIntegration: false`. Artifact, browser and canvas windows are sandboxed too.
- **One preload bridge.** Privileged operations cross the `window.api` contextBridge; renderer
  code never calls `ipcRenderer.invoke` directly, and every handler returns a typed result.
- **Navigation pinned.** The window may not navigate away from the packaged renderer; new
  windows are denied and `http(s)` links open in the system browser.
- **Content-Security-Policy** restricts the renderer to its own bundle (script hashes;
  `style-src` allows inline styles).

## Local network surfaces

| Listener | Bind | Purpose | Auth |
| --- | --- | --- | --- |
| Brain server (`electron/services/local-brain/server.ts`) | `127.0.0.1:8799` (`DUIN_BRAIN_PORT`) | Chat over `/agui`, state reads under `/state/*`, `/graph`, `/debug/*` | A control-plane guard: any request whose `Host` is present and non-loopback is refused (DNS rebinding); every mutating verb (POST/PUT/PATCH/DELETE) and a short list of effectful GETs require a per-launch token (`x-duin-control`, held by the renderer, or `x-duin-exec`); a mutating request with a remote `Origin` is refused. Reads are tokenless so diagnostics work. |
| `/exec/*` on the same port | `127.0.0.1:8799` | External agents pairing with the brain (`/exec/mcp` is an MCP mount) | Bearer principals with hashed tokens; an unpaired caller can only request pairing, which you approve in the app; rate limited; 1 MB body cap. |
| OAuth callbacks | `127.0.0.1:9876`, `127.0.0.1:9877` | GitHub and MCP OAuth flows | One-shot `state`; only listening during a flow. |
| Webhook ingress | `127.0.0.1:9377` | Inbound webhooks for channels | Off by default (`DUIN_WEBHOOK_INGRESS=1`); HMAC or token when on. |

Nothing binds `0.0.0.0`. No inbound surface is reachable from the network. The `duin://` link
scheme is not registered with the OS; it is an in-app convention.

## Secrets at rest

- API keys, OAuth tokens and channel credentials are stored in `keys.json` under the app's
  user-data directory, encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on
  Windows, Secret Service on Linux). The file is written with mode `0600`.
- Where `safeStorage` is unavailable (Linux without a secret service), DUIN refuses to store a
  key as plaintext unless you consent in a dialog. Consent is per provider and per session.
- Tokens never reach the renderer. `git push` uses a `GIT_ASKPASS` shim fed by a per-spawn
  environment variable, so tokens never appear on a command line or in `.git/config`.
- Child MCP processes receive an allowlisted environment, not the whole `process.env`.
- Conversations and the notes index are SQLite files in the user-data directory and are not
  encrypted. Use OS disk encryption if that matters to you.

## Agent capabilities and their defaults

These are the permissive surfaces and how a fresh public install ships.

| Surface | Default | Where |
| --- | --- | --- |
| **Full computer access** (read, write, move, delete anywhere; shell without prompts) | **Off.** The agent is confined to the vault, the active workspace and folders you grant. | Settings → General → Computer access |
| **Shell** (`run_command`, `start_command`) | Enabled, **prompts for approval**. Writes are confined by a kernel sandbox where one is available (macOS `sandbox-exec`, Linux `bwrap`, a Windows restricted-token backend that needs admin rights to initialize); otherwise the shell runs unconfined and a short list of elevated-risk shapes (a download piped into a shell or interpreter) is refused rather than prompted. | `DUIN_SANDBOX=0` disables the sandbox |
| **File tools** | Reads and in-vault writes are ungated. Deletes and moves go to `.trash/` and prompt. Writes outside the vault prompt and need a granted folder. | Settings → General |
| **Catastrophic-command screen** | Always on, in both access modes. A deny list for drive-root deletes, `format`/`mkfs`/`diskpart`, raw device writes, shutdown, disabling antivirus or the firewall, registry-hive deletes, shadow-copy deletion, boot-config deletion, fork bombs. It is a floor, not a sandbox. | `electron/services/local-brain/command-screen.ts` |
| **MCP servers** | Two seeds are present but **disabled**: a Node REPL (arbitrary JavaScript in a `vm`, with `fetch`) and Chrome via `npx -y @playwright/mcp`. Enabling either runs code with your privileges; the Chrome seed also downloads an npm package. Servers you add prompt with a native dialog. | Customize → Connectors |
| **Hooks** | **On**, with a toggle. Three seeded JavaScript hooks (session audit, destructive-command guard, tool audit) run in a Node `vm` context that exposes no filesystem or network APIs. Node documents `vm` as not a security boundary, so the real boundary is the native dialog on hook creation and edit. Creating or editing a hook prompts with a native dialog. Legacy shell hooks inherit the full environment. | Settings → Hooks |
| **External executor** (`delegate_task`) | Enabled, **requires approval** on every call, and refuses under the unattended posture. Runs the DeepSeek Harness as a child process in an isolated git worktree; needs a DeepSeek key. | Settings → Executors |
| **Background autonomy, loops, automations** | **Off.** Unattended model work (vault-wide extraction, recurring checks) is gated behind these switches or an explicit consent. | Settings → Loops, Settings → Automations |
| **Channels** (Telegram, Discord, Slack, Feishu, WeCom, DingTalk, Email) | Not started until configured. Pairing is deny-first; an inbound message never carries the execution token, so it cannot run shell commands or send mail on its own. | Settings → Channels |
| **Auto-update** | **On**, notify-only (see below). | Settings → General |
| **Telemetry** | None. Crash reports are not uploaded. | |

## Prompt injection

Your notes, fetched pages, search results, channel messages and MCP tool results are untrusted
input. A note can contain instructions; a web page can contain instructions; DUIN reads both.
The mitigations are:

- **Approvals.** Host shell commands, deletes, moves, writes outside the vault, `send_email`,
  `spawn_agent`, `create_skill`, `delegate_task` and MCP tools with side effects ask you before
  they run. Read the prompt; it names the tool and its arguments.
- **A deny-first execution token.** Tools that can spawn a shell or do something irreversible
  need a per-launch token that only the trusted renderer holds. An inbound channel turn does not
  have it, so injected content arriving over a channel cannot reach host execution.
- **Per-action review and floors.** Unattended surfaces run through a fail-closed action
  reviewer, a rule-of-two session floor, and cost ceilings.
- **The catastrophic-command screen and the destructive-command hook**, in both access modes.

**Full computer access removes the approval modal for local operations.** With it on, a shell
command, a delete, a move or a write anywhere on disk that the model decides to make runs
without asking, including on turns that started from an inbound channel message. Only the
catastrophic screen, persisted denies and the external-effect gates (mail, MCP, spawning) still
apply. Turn it on only for a vault whose contents you trust completely.

Two more things to know:

- A vault's `BRAIN.md` (or `AGENTS.md` / `CLAUDE.md` as fallbacks) is read as operating
  instructions, and files under the vault's `.duin/` and `.brain/` folders are configuration and
  state. Treat a vault you did not author as untrusted: open it in a fresh DUIN profile and keep
  full computer access off.
- Skills (`resources/skills/`, `<userData>/skills/`) are injected into the system prompt when
  enabled. Only enable skills you have read.

## Auto-update

An installed DUIN checks GitHub Releases at launch and every six hours. Windows builds are
unsigned and macOS builds are ad-hoc signed, so the updater cannot verify a signature. Until
signing lands, updates are **notify-only**: DUIN tells you a release exists; you download it,
verify the SHA-512 from `latest.yml` against the file, and install it yourself. An identity
guard refuses any manifest whose artifacts are not `DUIN-*` builds. Turn the check off in
Settings → General.

## Known limitations

- Reads on the brain server (`/state/*`, `/graph`, `/debug/*` GETs) are tokenless; any local
  process under your account can read them.
- No Electron fuses and no asar integrity: `--inspect`, `--remote-debugging-port` and
  `NODE_OPTIONS` are honored by the binary.
- The conversation database is not encrypted, and the encryption section in Settings is
  hidden in this release because the SQLCipher binding is not bundled.
- The bundled encoder models are fetched from Hugging Face without a hash pin when a build lacks
  them.

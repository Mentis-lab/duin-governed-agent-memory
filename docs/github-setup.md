# GitHub setup

DUIN can clone repositories, push branches and open pull requests against GitHub. There are two
ways to authenticate. Public DUIN builds do not ship a GitHub OAuth App, so pick one of these.

---

## Bring your own OAuth App

Use this for a persistent connection where the GitHub authorize page shows *your* app name.

### 1. Register the OAuth App on GitHub

Visit **https://github.com/settings/developers** → **OAuth Apps** → **New OAuth App** and fill
the form:

| Field | Value |
| --- | --- |
| Application name | Anything you want to see on the authorize page |
| Homepage URL | Any valid URL |
| Authorization callback URL | `http://localhost:9876/callback` (exact match required) |
| Enable Device Flow | leave unchecked |

Click **Register application**.

### 2. Capture the credentials

On the OAuth App's settings page:

- Copy the **Client ID** (looks like `Iv1.abc123…`). It is not secret.
- Click **Generate a new client secret** and copy it immediately; GitHub shows it once.

### 3. Paste into DUIN

1. Open Settings → GitHub.
2. Under **Bring your own OAuth App**, paste the Client ID and Client Secret.
3. Click **Save client**, then connect.
4. Authorize in the browser tab that opens.

Scopes requested: `read:user` (your login and avatar) and `repo` (list, clone and push private
repositories, open PRs).

The credentials are encrypted with Electron `safeStorage`; where that is unavailable, DUIN asks
before storing them as plaintext (see the consent notes in `electron/services/keychain.ts`).

---

## Local `gh` CLI

If you already have the [GitHub CLI](https://cli.github.com) installed and authenticated:

```bash
gh auth login
```

In DUIN, choose the local `gh` CLI option in Settings → GitHub. DUIN shells out to
`gh auth token` whenever it needs a bearer token. No OAuth App registration on your end; `gh`
manages everything.

This path spawns a process per probe and depends on `gh` staying authenticated. The OAuth path
above is persistent.

---

## What gets stored, where

| Item | Location | Why |
| --- | --- | --- |
| Access token (OAuth) | `<userData>/keys.json`, encrypted with `safeStorage` | Required for any GitHub API call. |
| Your OAuth App Client ID and Secret | Same | Used to exchange the auth code at connect time. |
| Mode flag (`oauth` / `gh-cli` / `none`) | `<userData>/settings.json` | Plain; not secret. |
| Linked repo per project | `<userData>/lamprey.db`, table `project_github_repos` | Survives restarts. |

Tokens never reach the renderer process. They never appear in `git push` command-line
arguments or in `.git/config`: pushes route through a `GIT_ASKPASS` shim that reads the token
from a per-spawn environment variable (`electron/services/github-askpass.ts`).

---

## Troubleshooting

**"Browser opened but nothing happened after I authorized."**
The callback returns to `http://localhost:9876/callback`. If another process holds port 9876
(a second DUIN, the Google MCP OAuth flow, an unrelated dev server), the callback cannot bind.
Quit the other instance and retry. `netstat -ano | findstr :9876` (Windows) or `lsof -i :9876`
(macOS/Linux) shows the holder.

**"Push failed with 403 / Authentication failed."**
Your token may have been revoked at github.com → Settings → Applications, or the OAuth App's
scope was reduced. Disconnect in Settings → GitHub and reconnect.

**"Connect with DUIN" does nothing, or is missing.**
That button appears only in builds compiled with bundled OAuth credentials (below). Public
builds are not, so use the OAuth App or `gh` CLI path.

---

## For maintainers: building with bundled credentials

A build can embed its own OAuth App so users get a one-click connect. It is opt-in at build
time, and the public release workflow does not set these variables:

```bash
export LAMPREY_GITHUB_CLIENT_ID="Iv1.your-id"
export LAMPREY_GITHUB_CLIENT_SECRET="your-secret"
npx electron-vite build
```

The values are read at build time by `electron.vite.config.ts` and emitted as string-define
replacements in the main bundle. They are never read from the renderer; the renderer probes
`github:hasBundledClient` (a boolean) to decide which UI to show. If the variables are unset,
the bundle has empty-string defaults and Settings falls back to the two paths above. The
variable names are inherited from the upstream harness; see [legacy-names.md](legacy-names.md).

# FAQ

## Installing and running

**Windows says the installer is unrecognized. Is it safe?**
The Windows build is not code-signed yet, so SmartScreen warns on first run. Choose **More info
→ Run anyway**. Verify the download first: the `sha512` field in `latest.yml` on the release
page is the base64 SHA-512 of `DUIN-x64.exe` (the command is in the
[README](../README.md#download)). Signing is planned; until then updates are notify-only.

**macOS says the app is damaged or from an unidentified developer.**
The build is ad-hoc signed and not notarized. Right-click the app and choose **Open** the first
time. If macOS still refuses, run `xattr -d com.apple.quarantine /Applications/DUIN.app`.

**Is there a Linux build?**
CI produces an AppImage and a `.deb`, but the maintainers have not tested them. Reports of what
works and what does not are welcome as issues.

**Why is the installer so large?**
It bundles the on-device encoders (`multilingual-e5-small` for embedding and `bge-reranker-base`
for reranking, about 412 MB quantized) so semantic search works offline from the first launch.
A build made without `node scripts/fetch-bundled-models.mjs` is smaller and downloads them from
Hugging Face on first run instead (about 135 MB plus 280 MB).

**Does it work offline?**
Yes, for indexing, search, the note graph and keyless answers, once the encoders are on disk.
The update check and any model provider you connect need the network. Ollama on the same
machine works offline.

**What happens on first run with no internet?**
If your build has the bundled encoders, everything local works. If it does not, indexing waits
for the model download; search works once it completes.

**Port 8799 is already in use.**
Another DUIN (or `npm run dev`) is running; quit it. To run two instances, start the second
with a different `DUIN_BRAIN_PORT` and a separate user-data directory.

## Privacy and cost

**Does DUIN send my notes anywhere?**
Not on its own. With no key, nothing goes to a model provider. When you connect a key, your
question plus relevant note excerpts go to that provider on every turn, and DUIN's background
extraction (which builds the graph) sends note passages too. The full statement is in the
[README](../README.md#privacy-and-cloud-usage) and [SECURITY.md](../SECURITY.md).

**How much will a keyed account cost?**
A turn is several model calls, not one: the answer, a retrieval agent with up to a few tool
calls, and extraction of what is worth remembering. The first graph build after connecting a
key is a batched pass over the whole vault. Use a provider with a free tier or a small model
first, watch the cost meter in the app, and set a per-turn ceiling in Settings.

**Can I use a local model?**
Yes. Run [Ollama](https://ollama.com) and DUIN detects it. Quality depends on the model you
pull; small models struggle with tool use and extraction.

## Building from source

**`npm ci` fails on Windows with a path-length error (`MSB3491`, `MAX_PATH`, 260).**
Clone into a short path such as `C:\src\DUIN`, or enable long paths (set
`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` to `1` and reboot) and run
`git config --global core.longpaths true`.

**`vitest` fails to start on Windows with `spawn EPERM` while loading `vitest.config.ts`.**
The runner uses esbuild as its config transformer and spawns `node_modules/esbuild/bin/esbuild.exe`.
On Windows that binary is a frequent false positive for Defender and several endpoint
products, which block the spawn before any test runs. Pick one:

- Add an antivirus exclusion for the project's `node_modules/esbuild` directory (Defender:
  Settings → Virus & threat protection → Manage settings → Exclusions). This is the persistent fix.
- Run `node node_modules/esbuild/bin/esbuild --version` once from the repo root. If your AV uses
  an on-access prompt, allowing that invocation usually lifts the block.
- If the binary was quarantined, delete `node_modules/esbuild` and run `npm ci` again after the
  exclusion is in place.

If the EPERM path is outside `node_modules/esbuild`, the cause is different: check long-path
support or `npm cache verify`.

**Some SQLite tests show as skipped.**
Suites that open a real database are guarded by `describe.skipIf(!HAS_NATIVE_SQLITE)` and skip
when the `better-sqlite3` binding is built for Electron's ABI rather than your Node's, which is
the normal state after `npm ci`. To run them, rebuild the binding for Node
(`npm rebuild better-sqlite3 --build-from-source`, which needs Python and a C++ toolchain) and
run `npm test`. Treat a rising skip count as a failure, not a pass.

**`electron-builder` fails renaming `win-unpacked.tmp` (EPERM).**
An on-access scanner is holding the directory during the Electron download. Add an exclusion
for `dist/` or pass a pre-extracted Electron with `-c.electronDist=<dir>`.

**Do I need Python or a C++ compiler?**
Not for `npm ci`, `npm run dev`, `npm run build` or the tests: `better-sqlite3` ships prebuilt
bindings. You need them only to rebuild native modules yourself (the SQLite test suites above,
or a custom Electron ABI).

**`npm run dev` exits immediately.**
Quit any installed DUIN first; both use port 8799. Then check the terminal output for the
first error. If Electron itself failed to download during `npm ci`, run
`node node_modules/electron/install.js`.

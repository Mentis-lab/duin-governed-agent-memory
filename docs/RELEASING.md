# Releasing

How a version of DUIN gets from `main` to GitHub Releases. Maintainers only.

## Rules

1. **A version is tagged once.** Never move, delete and re-create, or re-point a `vX.Y.Z` tag.
   Installed apps compare versions, not commits; deleting a tag turns its release into a draft
   and strands anyone who already downloaded it. If a release is wrong, ship `X.Y.Z+1`.
2. **Public releases carry no prerelease suffix.** The updater in installed apps only considers
   a non-prerelease "latest" whose version is greater than the installed one. A tag with a
   hyphen (`v0.9.0-rc.1`) is published as a prerelease and is invisible to installed apps; use
   that for rehearsals.
3. **`package.json` `version` is the single source of the version.** Artifact names are
   versionless (`DUIN-x64.exe`); `latest.yml` carries the version the updater reads.
4. **Nothing ships from a dirty tree or a branch other than `main`.**

## Steps

1. **Green `main`.** CI (lint, test on Ubuntu and Windows) is green at the commit you will tag.
2. **Bump the version.** Edit `version` in `package.json` (`0.9.0`, no suffix).
3. **Update `CHANGELOG.md`.** Move the `[Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD`,
   add the compare/tag links at the bottom, and leave an empty `[Unreleased]`.
4. **Write the release notes.** `docs/release-notes/vX.Y.Z.md`: headline bullets, what is
   inside, known limitations, attribution. This becomes the GitHub release body.
5. **Commit.** `chore(release): vX.Y.Z` containing exactly the three files above.
6. **Tag and push.**

   ```bash
   git tag -a vX.Y.Z -m "DUIN vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Watch `build.yml`.** The tag push runs three jobs: Windows (NSIS + zip, about 30
   minutes), macOS (dmg + zip, ad-hoc signed) and Linux (AppImage + deb). Each fetches the
   bundled encoder models with `scripts/fetch-bundled-models.mjs` (cached by `actions/cache`)
   and attaches its artifacts to the release for the tag.
8. **Verify the release.** On the release page:
   - Windows: `DUIN-x64.exe`, `DUIN-x64.exe.blockmap`, `latest.yml`.
   - macOS: `DUIN-arm64.dmg`, `DUIN-arm64.zip`, `latest-mac.yml` and its blockmap.
   - Linux: the AppImage, the `.deb`, `latest-linux.yml`.
   - Open `latest.yml` and confirm `version:` equals `X.Y.Z` and `path:` names a `DUIN-`
     artifact. The updater refuses any manifest whose artifacts are not `DUIN-*` builds.
   - The release is **not** marked as a prerelease.
9. **Paste the release notes** from `docs/release-notes/vX.Y.Z.md` into the release body if
   the workflow did not.
10. **Smoke the installer** on at least one machine per platform you claim: install, choose a
    folder, ask a keyless question, connect a key, confirm the graph builds. Compare the
    `sha512` in `latest.yml` with the downloaded file.
11. **Announce.** Pin known limitations (unsigned installers, Linux untested, cloud cost
    expectations) in the announcement.

## Rehearsal

Tag `vX.Y.Z-rc.N` from the release candidate commit. The workflow publishes it as a
prerelease, which installed apps ignore. Verify the assets exactly as above, then delete the
rehearsal release and its tag: a prerelease nobody could have been offered is the one case
where deletion is safe.

## Secrets and knobs

| Name | Effect |
| --- | --- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | When present, the Windows job signs the installer and flips `signAndEditExecutable` on. Absent today: builds are unsigned. |
| `DUIN_REQUIRE_BUNDLED_MODELS=1` | Makes a missing encoder model fatal in `build:*` instead of a warning. Set in the release workflow. |
| `DUIN_MODEL_CACHE` | Where `fetch-bundled-models.mjs` stores the encoders; the workflow points it at a cached directory. |

macOS notarization (Apple Developer ID, `hardenedRuntime`, entitlements) and a Windows
code-signing certificate are not in place. Until they are, the README and SECURITY.md describe
the installers as unsigned and the updater as notify-only. When signing lands, update both
documents and the updater in the same release.

## Rolling back

There is no rollback of a published version. Fix forward: bump to `X.Y.Z+1`, note the
regression in the changelog, tag, and release. Delete a release only if it was never
non-prerelease and nobody could have installed it.

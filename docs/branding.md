# Branding: the name split, kept straight

> What this product is called, why three names appear in the tree, and the single source of
> truth for each. If you are about to rename anything, or a stray "Brainframe" or "lamprey"
> string confused you, read this first.

## The three names (lineage)

| Name | What it is | Status |
| --- | --- | --- |
| **lamprey-harness** | The MIT-licensed agent shell DUIN started from ([USS-Parks/Lamprey-Harness](https://github.com/USS-Parks/Lamprey-Harness), by Basho Parks). | **Upstream origin.** Credited in `NOTICE`; never the product name. Some on-disk identifiers still carry it: [legacy-names.md](legacy-names.md). |
| **Brainframe** | The first standalone rebrand of the harness (internal builds `0.1.0` and `0.2.0`, never published). | **Superseded interim name.** Do not use for the current product. |
| **DUIN** | The current product name. | **Current, and the only live product name.** |

So: **lamprey-harness → Brainframe → DUIN.** "Brainframe" is not a parallel brand; it is the
old name of *this* app. The `0.1.0` and `0.2.0` entries in [CHANGELOG.md](../CHANGELOG.md)
keep it because that is what those builds were called. Do not rewrite history.

## Single source of truth

The product name is hard-set in exactly **four** spots. Keep them in lockstep on any rename:

| Spot | File | Value |
| --- | --- | --- |
| Main-process name | `electron/brand.ts` → `PRODUCT_NAME` | `DUIN` |
| Renderer name | `src/lib/brand.ts` → `PRODUCT_NAME` | `DUIN` |
| Package and build name | `package.json` → `name` / `productName` | `duin` / `DUIN` |
| Installer identity | `electron-builder.yml` → `productName` / `appId` | `DUIN` / `com.duin.app` |

Everything user-visible derives from `brand.ts`. The tagline, the framework credit and the
public repository URL (`PRODUCT_REPO_URL`, which the Help menu links only when set) also live
in `src/lib/brand.ts`. The updater's artifact guard expects every release file to start with
`DUIN-`, so `productName` and the `artifactName` pattern in `electron-builder.yml` must stay
paired.

## Decision: Brainframe is retired (2026-07-02)

"Brainframe" is fully retired in favor of DUIN. There is no second SKU and no separate
open-source distribution name. It survives solely in the two historical changelog entries and
in the lineage note in `brand.ts`, nowhere as a live label. If a separate SKU is ever wanted, it
would need its own `brand.ts` value behind a build flag, and a new decision recorded here.

**DUIN is the operative name everywhere a live label is needed.**

// brand.ts — single source of truth for the product name in the MAIN process.
//
// Lineage: lamprey (MIT upstream) → Brainframe (interim, shipped 0.1.0–0.2.0) → DUIN
// (current). "Brainframe" is a superseded name, not a live brand — see
// ARCHITECTURE/BRANDING.md for the full story and the four hard-set spots.
//
// To rebrand the app, change PRODUCT_NAME here AND in src/lib/brand.ts (renderer),
// then update `productName` / `build.productName` / `build.appId` in package.json and
// electron-builder.yml. Those four spots are the only places the name is hard-set.
export const PRODUCT_NAME = 'DUIN'

// Public product repository, mirrored from src/lib/brand.ts (the renderer's copy). Settings →
// GitHub reads the latest release from it and stars it as the connected account; leave it
// empty in a private fork and those handlers answer that this build has no public repository.
export const PRODUCT_REPO_URL: string = 'https://github.com/Mentis-lab/duin-governed-agent-memory'

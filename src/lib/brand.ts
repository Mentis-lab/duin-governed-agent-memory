// brand.ts — single source of truth for the product name in the RENDERER process.
//
// Lineage: lamprey (MIT upstream) → Brainframe (interim) → DUIN (current). See
// ARCHITECTURE/BRANDING.md. Keep this in sync with electron/brand.ts (main process);
// that file lists all four spots to update when rebranding.
export const PRODUCT_NAME = 'DUIN'
export const PRODUCT_TAGLINE = 'A local-first second brain for your notes'
// DUIN is built on the open-source Lamprey-Harness (USS-Parks/Lamprey-Harness, MIT).
export const FRAMEWORK_CREDIT = 'Built on Lamprey-Harness'
// Public product repository. The Help menu's "View on GitHub" / "Report an issue" items
// render only when this is set (ARCHITECTURE/BRANDING.md #4); leave it empty in a private
// fork so no repo surfaces to the user.
export const PRODUCT_REPO_URL: string = 'https://github.com/Mentis-lab/DUIN'

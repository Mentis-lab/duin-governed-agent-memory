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

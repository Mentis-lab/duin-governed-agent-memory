// make-mac-icon — build the macOS app icon from the shared logo.
//
// WHY macOS NEEDS ITS OWN. resources/icon.png is the cream DUIN mark on a TRANSPARENT
// background. Windows shows it inside its own chrome so that reads fine, but macOS paints
// the icon straight onto the Dock, Finder, and Launchpad — where a near-white mark on
// nothing has no contrast at all against any light backdrop, and the icon effectively
// disappears. Reported as "the Mac icon is whiteish and doesn't contrast with the logo".
//
// So the mac icon gets an opaque plate: the same charcoal the splash screen uses
// (sampled, not guessed — rgb(18,19,23)), in the rounded-square grid Apple's icons follow.
// electron-builder converts the PNG to .icns and does NOT apply the mask itself, so the
// rounding has to be baked in or the app ships a hard-edged square among rounded ones.
//
//   node scripts/make-mac-icon.mjs

import sharp from 'sharp'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'resources', 'icon.png')
const OUT = join(root, 'resources', 'icon-mac.png')

// Sampled from resources/splash.png so the icon and the first frame the user sees are
// the same colour rather than two similar dark greys.
const PLATE = { r: 18, g: 19, b: 23 }

// Apple's macOS icon grid: a 1024 canvas with the rounded square inset, not filling it.
// The margin is what makes a Dock of icons look evenly sized instead of this one looming.
const CANVAS = 1024
const PLATE_SIZE = 824
const PLATE_INSET = (CANVAS - PLATE_SIZE) / 2
const CORNER_RADIUS = 185
// The mark sits inside the plate with its own breathing room.
const LOGO_SIZE = 560

const plateSvg = Buffer.from(
  `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
     <rect x="${PLATE_INSET}" y="${PLATE_INSET}" width="${PLATE_SIZE}" height="${PLATE_SIZE}"
           rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"
           fill="rgb(${PLATE.r},${PLATE.g},${PLATE.b})"/>
   </svg>`
)

const logo = await sharp(SRC)
  .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer()

const offset = Math.round((CANVAS - LOGO_SIZE) / 2)

await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }
})
  .composite([
    { input: plateSvg, top: 0, left: 0 },
    { input: logo, top: offset, left: offset }
  ])
  .png()
  .toFile(OUT)

const meta = await sharp(OUT).metadata()
console.log(
  `[mac-icon] wrote ${OUT} — ${meta.width}x${meta.height}, plate rgb(${PLATE.r},${PLATE.g},${PLATE.b})`
)

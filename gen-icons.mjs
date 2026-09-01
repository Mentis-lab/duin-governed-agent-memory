// Regenerate the DUIN app icon + splash from the new logo mark, using the repo's sharp.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const sharp = require('sharp')

// The mark on its dark brand ground (square) — good for an app icon / splash.
const SVG = `<svg width="512" height="512" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
<defs><clipPath id="c1"><circle cx="200" cy="200" r="150"/></clipPath></defs>
<rect x="0" y="0" width="400" height="400" rx="88" fill="#101013"/>
<circle cx="200" cy="200" r="150" fill="none" stroke="#ffffff" stroke-width="4.2"/>
<g clip-path="url(#c1)" fill="none" stroke="#ffffff" stroke-width="3.7" stroke-linecap="round">
<path d="M40,164 C113,144 157,144 200,164 C243,184 287,184 360,164"/>
<path d="M40,200 C113,222 157,222 200,200 C243,178 287,178 360,200"/>
<path d="M40,236 C113,216 157,216 200,236 C243,256 287,256 360,236"/>
<path d="M40,268 C113,290 157,290 200,268 C243,246 287,246 360,268"/>
</g>
<circle cx="200" cy="164" r="15" fill="none" stroke="#ffffff" stroke-width="2.8"/>
<circle cx="200" cy="164" r="7.4" fill="#ffffff"/>
</svg>`

const renderPng = (size) =>
  sharp(Buffer.from(SVG)).resize(size, size, { fit: 'contain' }).png().toBuffer()

// PNG-based ICO encoder (Vista+). Container of PNG images at several sizes.
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const bodies = []
  entries.forEach((e, i) => {
    const o = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.buf.length
    bodies.push(e.buf)
  })
  return Buffer.concat([header, dir, ...bodies])
}

const SIZES = [16, 32, 48, 64, 128, 256]
const pngs = await Promise.all(SIZES.map(async (s) => ({ size: s, buf: await renderPng(s) })))

writeFileSync('resources/icon.ico', buildIco(pngs))
writeFileSync('resources/icon.png', await renderPng(512))

// Splash: keep the existing aspect; logo centered on the dark ground.
const splashMeta = await sharp('resources/splash.png').metadata().catch(() => ({ width: 600, height: 400 }))
const sw = splashMeta.width || 600
const sh = splashMeta.height || 400
const mark = await renderPng(Math.round(Math.min(sw, sh) * 0.5))
const splash = await sharp({
  create: { width: sw, height: sh, channels: 4, background: { r: 16, g: 16, b: 19, alpha: 1 } }
})
  .composite([{ input: mark, gravity: 'center' }])
  .png()
  .toBuffer()
writeFileSync('resources/splash.png', splash)

console.log('ICONS OK: icon.ico (' + SIZES.join(',') + '), icon.png 512, splash ' + sw + 'x' + sh)

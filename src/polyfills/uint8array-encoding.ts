// Polyfill for the TC39 "Uint8Array to/from base64 and hex" methods, for engines older than
// Chromium ~140. pdfjs-dist 6.x calls these — `.toHex()` in its worker, `.toBase64()`/`.fromBase64()`
// on the main thread — and DUIN's bundled Chromium (134, Electron 35) ships without them, which
// crashed the Library PDF view with "a2.toHex is not a function". Guarded: no-op where the engine
// already provides them (so it becomes dead weight, not a conflict, once Electron is upgraded).
//
// Imported FIRST in the renderer entry (main.tsx) AND inside the pdf worker wrapper (pdf-worker.ts),
// because a worker has its own global scope the main-thread polyfill can't reach.
/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = Uint8Array.prototype as any
const ctor = Uint8Array as any

if (typeof proto.toHex !== 'function') {
  proto.toHex = function toHex(this: Uint8Array): string {
    let s = ''
    for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0')
    return s
  }
}

if (typeof ctor.fromHex !== 'function') {
  ctor.fromHex = function fromHex(hex: string): Uint8Array {
    const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1)
    const out = new Uint8Array(clean.length >> 1)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
    return out
  }
}

if (typeof proto.toBase64 !== 'function') {
  proto.toBase64 = function toBase64(this: Uint8Array): string {
    let bin = ''
    for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i])
    return btoa(bin)
  }
}

if (typeof ctor.fromBase64 !== 'function') {
  ctor.fromBase64 = function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
}

export {}

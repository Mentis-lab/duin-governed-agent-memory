import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// Electron-free filesystem tree primitive. Lives in its own module (no app /
// plugin-loader imports) so PURE consumers — the agent-system importer's unit
// tests — share ONE copy implementation without dragging the electron runtime
// into a node-only test environment.

/** True when `p` exists and is a directory; false on any error. */
export function isDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** True when `p` exists and is a regular file; false on any error. */
export function isFileSafe(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Read a UTF-8 file, returning '' on any failure (missing, unreadable). */
export function readSafe(p: string): string {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

/** Recursively copy a file/dir tree, creating parent dirs as needed. */
export function copyTree(src: string, dest: string): void {
  const stats = statSync(src)
  if (stats.isDirectory()) {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src)) {
      copyTree(join(src, entry), join(dest, entry))
    }
    return
  }
  if (!stats.isFile()) return
  if (!existsSync(join(dest, '..'))) {
    mkdirSync(join(dest, '..'), { recursive: true })
  }
  copyFileSync(src, dest)
}

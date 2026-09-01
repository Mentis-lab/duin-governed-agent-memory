// Terminal escape-sequence stripping, shared by every path that funnels
// tool/CLI output into text that is DISPLAYED rather than fed to a terminal.
//
// The pattern is written with the \u001b source escape rather than a literal ESC
// byte, so it stays visible in a diff and survives an editor that eats control
// characters.
//
// Scope is CSI sequences (ESC [ ... final byte) — what colour/bold/cursor
// output actually uses: \u001b[1m, \u001b[0m, \u001b[2K. This is byte-for-byte the
// pattern the snip pipeline has used since it shipped, so deduplicating onto
// this module is a pure refactor there.
//
// NOTE: src/lib/ansi.ts MIRRORS this for the renderer, which has no runtime
// import path across the process boundary (same arrangement as
// electron/brand.ts <-> src/lib/brand.ts). Change both together.

export const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Remove ANSI CSI escape sequences. Returns the input unchanged when clean. */
export function stripAnsi(input: string): string {
  // Fast path: almost every chunk contains no ESC at all, and this runs once
  // per streamed reasoning delta.
  if (!input.includes('\u001b')) return input
  return input.replace(ANSI_RE, '')
}

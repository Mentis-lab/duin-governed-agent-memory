// Renderer mirror of electron/shared/strip-ansi.ts. The renderer bundle has no
// runtime import path into electron/ (only the ambient LampreyAPI *type*), so
// this is a deliberate two-copy mirror — the same arrangement as
// electron/brand.ts <-> src/lib/brand.ts. Change both together.
//
// Main strips ANSI at ingest, so newly streamed reasoning is already clean.
// This copy exists for reasoning rows PERSISTED BEFORE that fix, which still
// carry raw escapes in SQLite and would otherwise keep rendering a stray "1m"
// forever.

export const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Remove ANSI CSI escape sequences. Returns the input unchanged when clean. */
export function stripAnsi(input: string): string {
  if (!input.includes('\u001b')) return input
  return input.replace(ANSI_RE, '')
}

// Native port of resources/brain/server.py :: _project_logo_url (5184) + its
// slug helper _logo_slug (5180).
//
// A project node in the brain graph renders AS an uploaded PNG when the project
// has one on disk. Python computes the URL as `/project-logos/<slug>.png` iff the
// file exists under _LOGO_DIR (dirname(server.py)/web/public/project-logos).
//
// The PHYSICAL logo directory is app-install-relative (tied to the sidecar's
// location), NOT vault-relative — and the deployed sidecar and the in-process
// native brain do not necessarily resolve the same dir. So this port keeps the
// byte-fragile part (the slug + the existence check) pure and takes `logoDir` by
// injection; the caller (brain-graph merge / route) supplies the dir the live-
// parity loop confirms matches the golden :8765.
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { CJK_CLASS } from './cjk-tokens'

/** Everything that is NOT [0-9A-Za-z] or CJK. The CJK side is the tokenizer's full class
 *  (kanji + KANA) rather than Python's bare ideograph range: a kana-only project name
 *  (レポート) stripped to '' and every such project shared the one 'project.png'. Kana is
 *  additive — the separators the Python range stripped (·, 《》, U+30FB) still strip. */
const LOGO_SLUG_STRIP_RE = new RegExp(`[^0-9A-Za-z${CJK_CLASS}]+`, 'g')

/** Port of server.py::_logo_slug — collapse every run of chars that is NOT
 *  [0-9A-Za-z] or CJK/kana into a single '-', strip edge '-', default 'project'.
 *  CJK and kana are preserved verbatim (so a CJK-named project keeps its name),
 *  unlike _slug which strips them. The class comes from the shared CJK_CLASS, which
 *  is wider than the old hardcoded U+4E00–U+9FFF — kana-only names used to strip to
 *  empty and collide on the shared fallback id. */
export function logoSlug(name: string): string {
  return (
    String(name)
      .replace(LOGO_SLUG_STRIP_RE, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

/** Port of server.py::_project_logo_url. Returns `/project-logos/<slug>.png` iff
 *  that PNG exists under `logoDir`, else null. `logoDir` is the physical
 *  project-logos directory (…/web/public/project-logos). */
export function projectLogoUrl(logoDir: string, name: string): string | null {
  const fn = logoSlug(name) + '.png'
  return existsSync(join(logoDir, fn)) ? `/project-logos/${fn}` : null
}

/** Port of save_project_logo — store raw PNG bytes as <slug>.png under logoDir. */
export function saveProjectLogo(logoDir: string, project: string, data: Buffer): Record<string, unknown> {
  project = (project || '').trim()
  if (!project) return { ok: false, error: 'project required' }
  if (!data || data.length === 0) return { ok: false, error: 'empty file' }
  mkdirSync(logoDir, { recursive: true })
  const fn = logoSlug(project) + '.png'
  writeFileSync(join(logoDir, fn), data)
  return { ok: true, project, logo: `/project-logos/${fn}` }
}

/** Port of clear_project_logo — remove a project's logo. */
export function clearProjectLogo(logoDir: string, project: string): Record<string, unknown> {
  const fn = logoSlug(project) + '.png'
  const p = join(logoDir, fn)
  if (existsSync(p)) rmSync(p, { force: true })
  return { ok: true, project }
}

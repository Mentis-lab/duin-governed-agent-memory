// create_project (native) — create a new project folder + hub note so it shows on the Projects
// page, then stage the tracks it carries via the cascade. Port of create_project (server.py:7385).
//
// Deterministic write + runCascadeProject (background). NB: Python also fires _reproject_async
// (project_futures eager-refresh + scout). The native path SKIPS the project_futures half — that
// engine is unported, and a freshly-created project (BRAIN.md only, no streams/tasks) has nothing
// to project yet; the standing future model auto-discovers it on the next cadence reprojection. The
// generative side-effect that matters (cascade_project → staged tracks) is preserved.

import { writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { runCascadeProject } from './cascade-creators-native'
import { type GenerateFn } from './cascade-native'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface CreateProjectResult {
  ok: boolean
  error?: string
  name?: string
}

/**
 * Create a project folder (legacy `03 Projects/<name>` if that root exists, else a top-level arena
 * `<name>`) + a BRAIN.md hub note, then fire the track-proposal cascade. Port of create_project.
 */
export function createProject(base: string | null, rawName: string, deps: { generate: GenerateFn }): CreateProjectResult {
  const name = (rawName || '').trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, error: 'invalid name' }
  if (!base) return { ok: false, error: 'no vault' }

  // Legacy vault keeps `03 Projects/<name>`; a DUIN arena-first vault (no 03 Projects) makes the
  // project a top-level ARENA folder, matching how it already discovers projects.
  const legacyRoot = join(base, '03 Projects')
  const d = isDir(legacyRoot) ? join(legacyRoot, name) : join(base, name)
  if (isDir(d)) return { ok: false, error: 'a project with that name already exists' }

  try {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'BRAIN.md'), `---\ntype: project-hub\ncreated-by: duin\n---\n\n# ${name} — Project Hub\n`, 'utf-8')
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'create failed' }
  }
  // Generative cascade: propose the tracks the project carries → judge → stage for review.
  void runCascadeProject(base, name, { generate: deps.generate })
  return { ok: true, name }
}

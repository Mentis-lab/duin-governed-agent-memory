import { app } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join, sep } from 'path'
import { tmpdir } from 'os'
import JSZip from 'jszip'
import { listSkillFiles, skillRoot } from './skill-files'
import type { LoadedSkill } from './skill-loader'

// Skill packages are .zip files whose ROOT is a single directory named for the skill:
//
//   my-skill.zip
//   └── my-skill/
//       ├── SKILL.md
//       ├── references/notes.md
//       └── scripts/run.py
//
// That is the shape the Skills API and claude.ai both accept, so a package exported
// here round-trips to either without repacking.

/** The Skills API rejects uploads above 30 MB uncompressed; refuse locally rather
 *  than hand the user a package they cannot upload anywhere. */
const MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024

function skillIdOf(skill: LoadedSkill): string {
  // Strip a plugin namespace (`<pluginId>:<skillId>`) — a package directory name has
  // to satisfy the spec's `[a-z0-9-]` rule, and `:` is not a legal path char anyway.
  const id = skill.id.includes(':') ? skill.id.slice(skill.id.indexOf(':') + 1) : skill.id
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'skill'
}

/** Write `skill` and everything bundled with it to `destZip`. Returns the file count. */
export async function exportSkillZip(skill: LoadedSkill, destZip: string): Promise<number> {
  const id = skillIdOf(skill)
  const root = skillRoot(skill.filePath)
  const files = listSkillFiles(skill.filePath)

  let total = 0
  for (const f of files) total += f.size
  if (total > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `This skill is ${(total / 1024 / 1024).toFixed(1)} MB uncompressed — over the 30 MB package limit.`
    )
  }

  const zip = new JSZip()
  const folder = zip.folder(id)
  if (!folder) throw new Error('Could not build the package')

  let written = 0
  for (const entry of files) {
    // `SKILL.md` is the canonical spelling in a package even when the directory
    // holds a lowercase `skill.md`.
    const source =
      entry.path === 'SKILL.md'
        ? root
          ? join(root, basename(skill.filePath))
          : skill.filePath
        : join(root ?? dirname(skill.filePath), ...entry.path.split('/'))
    try {
      folder.file(entry.path, readFileSync(source))
      written++
    } catch (err) {
      console.error('[skill-package] skipping unreadable file', source, err)
    }
  }
  if (written === 0) throw new Error('Nothing to export — the skill has no readable files')

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  writeFileSync(destZip, buf)
  return written
}

/** Zip-slip guard: a package entry must land inside the staging dir. A crafted
 *  `../../../.bashrc` path would otherwise let an imported package write anywhere the
 *  app can write. */
function safeJoin(base: string, relPath: string): string | null {
  const target = join(base, ...relPath.split('/').filter((s) => s && s !== '.'))
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** Unpack a package into a fresh temp directory shaped like a skills folder, so
 *  `importSkillsFromDir` can apply its normal validation and never-overwrite rule.
 *  The caller owns the returned directory and must remove it. */
export async function unpackSkillZip(zipPath: string): Promise<string> {
  const size = statSync(zipPath).size
  // A zip bomb is still bounded by what we write below, but refuse the obvious case early.
  if (size > MAX_UNCOMPRESSED_BYTES) {
    throw new Error('That package is larger than the 30 MB limit.')
  }
  const zip = await JSZip.loadAsync(readFileSync(zipPath))
  const staged = mkdtempSync(join(tmpdir(), 'duin-skill-pkg-'))

  const entries = Object.values(zip.files).filter((f) => !f.dir)
  if (entries.length === 0) throw new Error('That package is empty.')

  // A package whose root is `SKILL.md` (no wrapping directory) still imports — nest it
  // under the zip's own basename so the importer sees a directory-mode skill.
  const hasTopLevelSkillMd = entries.some((f) => f.name.toLowerCase() === 'skill.md')
  const wrapper = hasTopLevelSkillMd ? basename(zipPath).replace(/\.zip$/i, '') || 'skill' : ''

  let bytes = 0
  let written = 0
  for (const entry of entries) {
    const rel = wrapper ? `${wrapper}/${entry.name}` : entry.name
    const target = safeJoin(staged, rel)
    if (!target) {
      console.warn('[skill-package] refusing path outside the package root:', entry.name)
      continue
    }
    const content = await entry.async('nodebuffer')
    bytes += content.length
    if (bytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('That package expands past the 30 MB limit.')
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written++
  }
  if (written === 0) throw new Error('That package had no importable files.')
  return staged
}

/** Where a caller should stage packages when it needs a stable location. */
export function packageStagingDir(): string {
  const dir = join(app.getPath('userData'), 'skill-packages')
  mkdirSync(dir, { recursive: true })
  return dir
}

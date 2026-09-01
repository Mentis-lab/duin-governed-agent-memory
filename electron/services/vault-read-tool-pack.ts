// vault-read-tool-pack.ts — safe, read-only file tools so a headless agent can
// READ the vault before writing (the harness had only apply_patch/write +
// sandbox-bypass shell, neither usable read-only unattended). Both are
// workspace-JAILED (resolvePathWithinWorkspace rejects `..`, absolutes, and the
// root itself) and read-only (risks: ['read'], requiresApproval: false), so they
// need no approval and can never escape the vault or mutate anything.

import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { toolRegistry } from './tool-registry'
import { resolvePathWithinWorkspace } from './apply-patch-tool'
import { messageOf } from './guarded'

const MAX_BYTES = 200_000

toolRegistry.registerNative(
  {
    id: 'read_file',
    name: 'read_file',
    title: 'Read file',
    description:
      'Read a UTF-8 text file from the workspace. The path must be RELATIVE to the workspace ' +
      'root and resolve inside it (no "..", no absolute paths). Returns the file content ' +
      '(truncated at 200 KB). Read-only.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  async (args, ctx) => {
    const root = ctx.workspacePath ?? process.cwd()
    const p = resolvePathWithinWorkspace(root, String((args as { path?: unknown }).path ?? ''))
    if (!p) return { result: 'Error: path must be a workspace-relative file inside the root', status: 'error' }
    try {
      const txt = readFileSync(p, 'utf-8')
      return txt.length > MAX_BYTES ? txt.slice(0, MAX_BYTES) + '\n…[truncated at 200 KB]' : txt
    } catch (e) {
      return { result: `Error: ${(e as Error).message}`, status: 'error' }
    }
  }
)

toolRegistry.registerNative(
  {
    id: 'list_dir',
    name: 'list_dir',
    title: 'List directory',
    description:
      'List the entries of a workspace directory. The path must be RELATIVE to the workspace ' +
      'root (use "." for the root) and resolve inside it. Directories are suffixed with "/". ' +
      'Read-only.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path, or "." for the root.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  async (args, ctx) => {
    const root = resolve(ctx.workspacePath ?? process.cwd())
    const rel = String((args as { path?: unknown }).path ?? '.').trim()
    const dir = rel === '.' || rel === '' || rel === './' ? root : resolvePathWithinWorkspace(root, rel)
    if (!dir) return { result: 'Error: path must be a workspace-relative directory inside the root', status: 'error' }
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => {
          if (e.isDirectory()) return e.name + '/'
          let size = ''
          try {
            size = ` (${statSync(resolve(dir, e.name)).size}b)`
          } catch (e) { console.debug('[vault-read-tool-pack] ignore:', messageOf(e)) }
          return e.name + size
        })
        .sort()
      return entries.join('\n') || '(empty directory)'
    } catch (e) {
      return { result: `Error: ${(e as Error).message}`, status: 'error' }
    }
  }
)

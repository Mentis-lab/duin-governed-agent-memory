/**
 * Windows Sandbox (.wsb) config generator — the containment outer wall for unattended
 * computer-use (Phase 2). Windows Sandbox is free on Win10 Pro, hypervisor/kernel-isolated,
 * disposable, and runs real native Windows apps — so a compromised agent inside it cannot
 * touch the host filesystem or spawn a host shell, and loses all state on close.
 *
 * Two host-facing risks the config must close by DEFAULT:
 *   - networking is ON by default in Sandbox → an exfiltration path. Default it OFF here.
 *   - mapped folders are the only host-persistent channel → default them READ-ONLY, minimal.
 *
 * Pure string builder — unit-tested; no Electron/child-process here. The caller writes the
 * returned XML to a .wsb file and launches it with WindowsSandbox.exe.
 */

export interface SandboxMappedFolder {
  hostFolder: string
  /** Default true. A writable mapping is a host-persistence + exfil surface — opt in explicitly. */
  readOnly?: boolean
  sandboxFolder?: string
}

export interface SandboxConfigOptions {
  /** Default false — networking is an exfil path and stays off unless explicitly enabled. */
  networking?: boolean
  /** Default []. Keep minimal; each writable mapping widens the host blast radius. */
  mappedFolders?: SandboxMappedFolder[]
  /** A command to run on sandbox logon (e.g. install + start the computer-use MCP executor). */
  logonCommand?: string
  memoryMB?: number
  /** Default false — no GPU passthrough unless a task needs it. */
  vGpu?: boolean
  /** Default false — clipboard redirection is a cross-boundary channel; keep it closed. */
  clipboardRedirection?: boolean
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function onOff(enabled: boolean): 'Enable' | 'Disable' {
  return enabled ? 'Enable' : 'Disable'
}

/**
 * Build a hardened Windows Sandbox `.wsb` configuration. Safe by default: networking off,
 * vGPU off, clipboard off, ProtectedClient on, and any mapped folder read-only unless the
 * caller explicitly opts a specific folder into write access.
 */
export function buildSandboxConfig(opts: SandboxConfigOptions = {}): string {
  const networking = opts.networking ?? false
  const vGpu = opts.vGpu ?? false
  const clipboard = opts.clipboardRedirection ?? false
  const folders = opts.mappedFolders ?? []

  const lines: string[] = ['<Configuration>']
  lines.push(`  <VGpu>${onOff(vGpu)}</VGpu>`)
  lines.push(`  <Networking>${onOff(networking)}</Networking>`)
  lines.push(`  <ClipboardRedirection>${onOff(clipboard)}</ClipboardRedirection>`)
  lines.push('  <ProtectedClient>Enable</ProtectedClient>')

  if (folders.length > 0) {
    lines.push('  <MappedFolders>')
    for (const f of folders) {
      const readOnly = f.readOnly ?? true // fail-safe: read-only unless explicitly writable
      lines.push('    <MappedFolder>')
      lines.push(`      <HostFolder>${xmlEscape(f.hostFolder)}</HostFolder>`)
      if (f.sandboxFolder) lines.push(`      <SandboxFolder>${xmlEscape(f.sandboxFolder)}</SandboxFolder>`)
      lines.push(`      <ReadOnly>${readOnly ? 'true' : 'false'}</ReadOnly>`)
      lines.push('    </MappedFolder>')
    }
    lines.push('  </MappedFolders>')
  }

  if (typeof opts.memoryMB === 'number' && opts.memoryMB > 0) {
    lines.push(`  <MemoryInMB>${Math.trunc(opts.memoryMB)}</MemoryInMB>`)
  }

  if (opts.logonCommand && opts.logonCommand.trim().length > 0) {
    lines.push('  <LogonCommand>')
    lines.push(`    <Command>${xmlEscape(opts.logonCommand)}</Command>`)
    lines.push('  </LogonCommand>')
  }

  lines.push('</Configuration>')
  return lines.join('\n') + '\n'
}

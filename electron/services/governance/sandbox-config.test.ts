import { describe, it, expect } from 'vitest'
import { buildSandboxConfig } from './sandbox-config'

describe('buildSandboxConfig — safe by default', () => {
  it('disables networking, vGPU, and clipboard by default; enables ProtectedClient', () => {
    const xml = buildSandboxConfig()
    expect(xml).toContain('<Networking>Disable</Networking>')
    expect(xml).toContain('<VGpu>Disable</VGpu>')
    expect(xml).toContain('<ClipboardRedirection>Disable</ClipboardRedirection>')
    expect(xml).toContain('<ProtectedClient>Enable</ProtectedClient>')
    expect(xml).not.toContain('<MappedFolders>')
    expect(xml.startsWith('<Configuration>')).toBe(true)
    expect(xml.trimEnd().endsWith('</Configuration>')).toBe(true)
  })

  it('maps a folder read-only by default (fail-safe)', () => {
    const xml = buildSandboxConfig({ mappedFolders: [{ hostFolder: 'C:\\work\\in' }] })
    expect(xml).toContain('<HostFolder>C:\\work\\in</HostFolder>')
    expect(xml).toContain('<ReadOnly>true</ReadOnly>')
  })

  it('honors an explicit writable mapping', () => {
    const xml = buildSandboxConfig({ mappedFolders: [{ hostFolder: 'C:\\out', readOnly: false }] })
    expect(xml).toContain('<ReadOnly>false</ReadOnly>')
  })

  it('can enable networking only when explicitly asked', () => {
    expect(buildSandboxConfig({ networking: true })).toContain('<Networking>Enable</Networking>')
  })

  it('includes and XML-escapes a logon command', () => {
    const xml = buildSandboxConfig({ logonCommand: 'cmd /c npx -y terminator-mcp-agent & echo "go"' })
    expect(xml).toContain('<LogonCommand>')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&quot;go&quot;')
    expect(xml).not.toContain('& echo') // raw ampersand must be escaped
  })

  it('escapes XML metacharacters in host paths', () => {
    const xml = buildSandboxConfig({ mappedFolders: [{ hostFolder: 'C:\\a&b<c>' }] })
    expect(xml).toContain('C:\\a&amp;b&lt;c&gt;')
  })

  it('includes MemoryInMB when provided and omits it otherwise', () => {
    expect(buildSandboxConfig({ memoryMB: 8192 })).toContain('<MemoryInMB>8192</MemoryInMB>')
    expect(buildSandboxConfig()).not.toContain('<MemoryInMB>')
  })
})

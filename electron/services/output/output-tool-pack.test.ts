import { describe, it, expect, vi } from 'vitest'

// Verify the PRODUCE tools register with the correct descriptors + gating posture.
// electron is mocked (node test env) so importing the pack — which runs
// registerNative as an import side effect — doesn't touch a real app.
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-output-tool-pack', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { toolRegistry } from '../tool-registry'
import { isGatedTool } from '../local-brain/agui-guard'
import './output-tool-pack'

function descriptor(id: string) {
  return toolRegistry.getDescriptors().find((d) => d.name === id)
}

describe('output-tool-pack registration', () => {
  it('registers generate_audio as an ungated network+write PRODUCE tool', () => {
    const d = descriptor('generate_audio')
    expect(d).toBeTruthy()
    // reversible local write (like image_generate) → NOT gated for approval
    expect(d?.requiresApproval).toBe(false)
    expect(d?.risks).toEqual(expect.arrayContaining(['network', 'write']))
    // schema requires text
    const schema = d?.inputSchema as { required?: string[] }
    expect(schema.required).toContain('text')
  })

  it('registers generate_pdf_document as an ungated write PRODUCE tool', () => {
    const d = descriptor('generate_pdf_document')
    expect(d).toBeTruthy()
    expect(d?.requiresApproval).toBe(false)
    expect(d?.risks).toEqual(expect.arrayContaining(['write']))
    const schema = d?.inputSchema as { required?: string[] }
    expect(schema.required).toContain('markdown')
  })

  it('keeps send_email GATED (irreversible send requires approval)', () => {
    // Regression guard: the PRODUCE additions must not relax the stage-1 send gate.
    const d = descriptor('send_email')
    expect(d?.requiresApproval).toBe(true)
  })

  it.each([
    ['generate_docx', 'blocks'],
    ['generate_xlsx', 'sheets'],
    ['generate_pptx', 'slides']
  ])('registers %s as an ungated write PRODUCE tool requiring %s', (id, requiredProp) => {
    const d = descriptor(id)
    expect(d).toBeTruthy()
    // Office docs are reversible LOCAL writes (like generate_pdf_document) → NOT gated.
    expect(d?.requiresApproval).toBe(false)
    expect(d?.risks).toEqual(expect.arrayContaining(['write']))
    const schema = d?.inputSchema as { required?: string[] }
    expect(schema.required).toContain(requiredProp)
  })

  it('does NOT put the office PRODUCE tools in the irreversible gate set', () => {
    // A de-privileged inbound turn (execToken:null) is denied gated tools; the office
    // generators must be reachable (reversible local writes), unlike send_email.
    for (const id of ['generate_docx', 'generate_xlsx', 'generate_pptx']) {
      expect(isGatedTool(id)).toBe(false)
    }
    expect(isGatedTool('send_email')).toBe(true)
  })
})

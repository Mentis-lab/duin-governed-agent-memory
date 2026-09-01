import { ipcMain } from 'electron'
import * as artifactSandbox from '../services/artifact-sandbox'
import { saveHtmlToVault, readVaultFile } from '../services/library-brain-bridge'
import {
  listArtifactFiles,
  readArtifactFile,
  persistArtifactFile
} from '../services/artifacts-files-store'

export function registerArtifactHandlers(): void {
  // The "Artifacts" surface reads the HTML/MD files the assistant created from
  // disk (userData/artifacts/**), not per-conversation in-memory chat state.
  ipcMain.handle('artifacts:listFiles', async () => {
    try {
      return { success: true, data: listArtifactFiles() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifacts:readFile', async (_event, path: string) => {
    try {
      const r = readArtifactFile(path)
      if (!r) return { success: false, error: 'File not found or outside the artifacts folder' }
      return { success: true, data: r }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Additive durable copy of an assistant-authored html/md artifact. Called
  // fire-and-forget from the artifact-open choke point; idempotent per content.
  ipcMain.handle('artifacts:persist', async (_event, type: string, content: string) => {
    try {
      return { success: true, data: { path: persistArtifactFile(type, content) } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:render', async (_event, type: string, content: string) => {
    try {
      artifactSandbox.render(type, content)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:hide', async () => {
    try {
      artifactSandbox.hide()
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:show', async () => {
    try {
      artifactSandbox.show()
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Save an HTML artifact into the vault as a first-class `page` node surface.
  ipcMain.handle('artifact:saveToLibrary', async (_event, name: string, html: string) => {
    try {
      const r = saveHtmlToVault(name, html)
      if (!r.ok) return { success: false, error: r.error }
      // `replaced` rides along so the toast can say a prior page was preserved — the
      // moment the user most needs to know something was replaced is the moment they
      // are being told the save succeeded.
      return {
        success: true,
        data: { path: r.path, title: r.title, ...(r.replaced ? { replaced: r.replaced } : {}) }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Read a vault file's raw content by relpath — used to re-open a `page` node's
  // HTML in the artifact workbench.
  ipcMain.handle('artifact:readVaultFile', async (_event, relpath: string) => {
    try {
      const content = readVaultFile(relpath)
      if (content == null) return { success: false, error: 'File not found or outside the vault' }
      return { success: true, data: content }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:resize', async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    try {
      artifactSandbox.setBounds(bounds)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:openInWindow', async (_event, type: string, content: string) => {
    try {
      artifactSandbox.openInWindow(type, content)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:getSource', async () => {
    try {
      return { success: true, data: artifactSandbox.getSource() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('artifact:getType', async () => {
    try {
      return { success: true, data: artifactSandbox.getType() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

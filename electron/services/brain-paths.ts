import { app } from 'electron'
import { join } from 'path'
/** Where brain-adjacent runtime assets (e.g. project logos) live. A neutral
 *  location, NOT the retired resources/brain python dir. */
export function brainAssetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'brain-assets') : join(app.getAppPath(), 'resources', 'brain-assets')
}

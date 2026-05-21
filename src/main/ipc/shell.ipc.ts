import { ipcMain, shell } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register(_deps: AppDeps): void {
  ipcMain.handle(CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_EXTERNAL_FILE, async (_event, filePath: string) => {
    try {
      const err = await shell.openPath(filePath)
      return { ok: err === '', error: err || undefined }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}

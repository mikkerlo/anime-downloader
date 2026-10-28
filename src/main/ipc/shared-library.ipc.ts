// Shared Library IPC (#574): export jobs. The work lives in
// `services/shared-library-export`; this router adds the folder pickers.

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

async function pickFolder(sender: Electron.WebContents, title: string): Promise<string | null> {
  // The sender's window, not the focused one: an unfocused window can still ask.
  const win = BrowserWindow.fromWebContents(sender)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

export function register(deps: AppDeps): void {
  const svc = deps.sharedLibraryExport

  ipcMain.handle(CHANNELS.EXPORT_PLAN, (_e, req: ExportPlanRequest) => svc.plan(req))
  ipcMain.handle(CHANNELS.EXPORT_START, (_e, req: ExportStartRequest) => svc.start(req))
  ipcMain.handle(CHANNELS.EXPORT_PAUSE, (_e, jobId: string) => svc.pause(jobId))
  ipcMain.handle(CHANNELS.EXPORT_RESUME, (_e, jobId: string) => svc.resume(jobId))
  ipcMain.handle(CHANNELS.EXPORT_CANCEL, (_e, jobId: string) => svc.cancel(jobId))
  ipcMain.handle(CHANNELS.EXPORT_LIST_JOBS, () => svc.list())
  ipcMain.handle(CHANNELS.EXPORT_PICK_TARGET, (e) =>
    pickFolder(e.sender, 'Choose a folder for the Shared Library')
  )
  ipcMain.handle(
    CHANNELS.EXPORT_LOCATE_TARGET,
    async (e, jobId: string): Promise<{ ok: boolean; reason: string | null }> => {
      const dir = await pickFolder(e.sender, 'Locate the Shared Library')
      if (!dir) return { ok: false, reason: null }
      const r = await svc.locate(jobId, dir)
      return r.ok ? { ok: true, reason: null } : { ok: false, reason: r.reason }
    }
  )
}

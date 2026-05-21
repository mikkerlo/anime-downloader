import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ store }: AppDeps): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const broadcastUpdateStatus = (data: Record<string, unknown>): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT_CHANNELS.UPDATE_STATUS, data)
    }
  }

  autoUpdater.on('update-available', (info) => {
    broadcastUpdateStatus({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    store.set('lastUpdateCheck', Date.now())
    broadcastUpdateStatus({ status: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    broadcastUpdateStatus({ status: 'ready' })
  })

  autoUpdater.on('error', (err) => {
    broadcastUpdateStatus({ status: 'error', error: err.message })
  })

  ipcMain.handle(CHANNELS.APP_VERSION, () => app.getVersion())

  ipcMain.handle(CHANNELS.UPDATE_CHECK, async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        broadcastUpdateStatus({
          status: 'error',
          error: 'Update check not available in development mode'
        })
      }
    } catch (err) {
      broadcastUpdateStatus({
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  ipcMain.handle(CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      broadcastUpdateStatus({
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  ipcMain.handle(CHANNELS.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall()
  })

  const lastCheck = (store.get('lastUpdateCheck') as number) || 0
  if (Date.now() - lastCheck > 24 * 60 * 60 * 1000) {
    autoUpdater.checkForUpdates().catch(() => {})
  }
}

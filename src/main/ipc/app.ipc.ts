import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { isPortableBuild, checkLatestRelease, RELEASES_LATEST_PAGE } from '../lib/manual-update'
import type { AppDeps } from './index'

export function register({ store }: AppDeps): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const broadcastUpdateStatus = (data: Record<string, unknown>): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(EVENT_CHANNELS.UPDATE_STATUS, data)
    }
  }

  // Windows portable can't self-update (no installer for the updater to swap
  // in), so its flow checks GitHub for a newer release and opens the release
  // page instead of driving electron-updater (#189, docs/auto-update.md).
  const manualUpdate = isPortableBuild()
  let manualReleaseUrl = RELEASES_LATEST_PAGE

  const checkForUpdateManually = async (): Promise<void> => {
    const result = await checkLatestRelease(app.getVersion())
    manualReleaseUrl = result.url
    if (result.status === 'available') {
      broadcastUpdateStatus({ status: 'available', version: result.version, manual: true })
    } else {
      store.set('lastUpdateCheck', Date.now())
      broadcastUpdateStatus({ status: 'up-to-date' })
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
      if (manualUpdate) {
        await checkForUpdateManually()
        return
      }
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
      if (manualUpdate) {
        await shell.openExternal(manualReleaseUrl)
        return
      }
      await autoUpdater.downloadUpdate()
    } catch (err) {
      broadcastUpdateStatus({
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  ipcMain.handle(CHANNELS.UPDATE_INSTALL, () => {
    if (manualUpdate) {
      void shell.openExternal(manualReleaseUrl)
      return
    }
    autoUpdater.quitAndInstall()
  })

  const lastCheck = (store.get('lastUpdateCheck') as number) || 0
  if (Date.now() - lastCheck > 24 * 60 * 60 * 1000) {
    if (manualUpdate) {
      checkForUpdateManually().catch(() => {})
    } else {
      autoUpdater.checkForUpdates().catch(() => {})
    }
  }
}

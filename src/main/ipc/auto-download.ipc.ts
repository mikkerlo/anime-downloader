import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import {
  getAutoDownloaderStatus,
  listSubscriptions,
  getSubscription,
  setSubscription
} from '../auto-downloader'
import type { AppDeps } from './index'

export function register({ store, runAutoDownloadTick }: AppDeps): void {
  ipcMain.handle(CHANNELS.AUTO_DL_GET_SUBSCRIPTION, (_event, animeId: number) => {
    return getSubscription(animeId)
  })

  ipcMain.handle(
    CHANNELS.AUTO_DL_SET_SUBSCRIPTION,
    async (
      _event,
      animeId: number,
      enabled: boolean,
      meta?: { malId: number; animeName: string }
    ) => {
      const sub = await setSubscription(animeId, enabled, meta)
      if (enabled && sub) {
        // Fire a tick shortly after subscribing so the user sees the system catch up
        // (forward-only stamp ensures nothing backfills, this just exercises the path).
        setTimeout(() => {
          void runAutoDownloadTick('manual')
        }, 1000)
      }
      return sub
    }
  )

  ipcMain.handle(CHANNELS.AUTO_DL_LIST_SUBSCRIPTIONS, () => listSubscriptions())

  ipcMain.handle(CHANNELS.AUTO_DL_TRIGGER, async () => {
    return runAutoDownloadTick('manual')
  })

  ipcMain.handle(CHANNELS.AUTO_DL_GET_STATUS, () => getAutoDownloaderStatus())

  ipcMain.handle(CHANNELS.AUTO_DL_GET_ENABLED, () => Boolean(store.get('autoDownloadEnabled')))

  ipcMain.handle(CHANNELS.AUTO_DL_SET_ENABLED, (_event, enabled: boolean) => {
    store.set('autoDownloadEnabled', Boolean(enabled))
    return Boolean(enabled)
  })
}

import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ store, coldStorageService }: AppDeps): void {
  ipcMain.handle(CHANNELS.GET_SETTING, (_event, key: string) => {
    if (key === 'downloadDir') return coldStorageService.getDownloadDir()
    return store.get(key)
  })

  ipcMain.handle(CHANNELS.SET_SETTING, (_event, key: string, value: unknown) => {
    store.set(key, value)
  })
}

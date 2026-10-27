import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ offlineService, broadcast }: AppDeps): void {
  offlineService.onChange((state) => broadcast(EVENT_CHANNELS.OFFLINE_STATE_CHANGED, state))

  ipcMain.handle(CHANNELS.OFFLINE_GET_STATE, (): OfflineState => offlineService.getState())

  ipcMain.handle(
    CHANNELS.OFFLINE_SET_MANUAL,
    (_event, on: boolean): OfflineState => offlineService.setManual(Boolean(on))
  )

  ipcMain.handle(CHANNELS.OFFLINE_RETRY, (): Promise<OfflineState> => offlineService.retryNow())
}

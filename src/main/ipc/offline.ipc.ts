import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ offlineService, broadcast, prepareOffline }: AppDeps): void {
  offlineService.onChange((state) => broadcast(EVENT_CHANNELS.OFFLINE_STATE_CHANGED, state))

  ipcMain.handle(CHANNELS.OFFLINE_GET_STATE, (): OfflineState => offlineService.getState())

  ipcMain.handle(
    CHANNELS.OFFLINE_SET_MANUAL,
    (_event, on: boolean): OfflineState => offlineService.setManual(Boolean(on))
  )

  ipcMain.handle(CHANNELS.OFFLINE_RETRY, (): Promise<OfflineState> => offlineService.retryNow())

  // Prepare for offline (#592). Progress goes out on
  // `EVENT_CHANNELS.PREPARE_OFFLINE_PROGRESS` from the service itself.
  ipcMain.handle(CHANNELS.PREPARE_OFFLINE_START, (): { runId: string } => {
    if (!prepareOffline) throw new Error('Prepare for offline is not available')
    return prepareOffline.start()
  })

  ipcMain.handle(CHANNELS.PREPARE_OFFLINE_CANCEL, (): boolean => prepareOffline?.cancel() ?? false)

  ipcMain.handle(
    CHANNELS.PREPARE_OFFLINE_GET_STATE,
    (): PrepareOfflineState =>
      prepareOffline?.getState() ?? { running: false, run: null, lastRun: null }
  )
}

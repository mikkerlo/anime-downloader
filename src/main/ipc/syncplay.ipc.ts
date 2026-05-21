import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { syncplay } from '../syncplay'
import type { SyncplayConfig, SyncplayFileInfo } from '../syncplay'
import type { AppDeps } from './index'

export function register({ store }: AppDeps): void {
  ipcMain.handle(CHANNELS.SYNCPLAY_CONNECT, (_event, cfg: SyncplayConfig) => {
    const persisted = store.get('syncplay') as Record<string, unknown>
    store.set('syncplay', {
      ...persisted,
      lastHost: cfg.host,
      lastPort: cfg.port,
      lastRoom: cfg.room,
      username: cfg.username,
      autoReconnect: Boolean(cfg.autoReconnect)
    })
    syncplay.connect(cfg)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_DISCONNECT, () => {
    syncplay.disconnect()
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_FILE, (_event, file: SyncplayFileInfo) => {
    syncplay.setFile(file)
  })

  ipcMain.handle(
    CHANNELS.SYNCPLAY_LOCAL_STATE,
    (_event, payload: { paused: boolean; position: number; cause: 'play' | 'pause' | 'seek' }) => {
      syncplay.sendLocalState(payload)
    }
  )

  ipcMain.handle(
    CHANNELS.SYNCPLAY_LOCAL_SNAPSHOT,
    (_event, snap: { position: number; paused: boolean }) => {
      syncplay.updateSnapshot(snap)
    }
  )

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_READY, (_event, isReady: boolean) => {
    syncplay.setReady(isReady)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_GET_STATUS, () => syncplay.getStatus())
}

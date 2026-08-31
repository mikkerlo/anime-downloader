import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { syncplay } from '../syncplay'
import { SyncplayPasswordVault } from '../syncplay-credentials'
import type { SyncplayConfig, SyncplayFileInfo } from '../syncplay'
import type { AppDeps } from './index'

export function register({ store }: AppDeps): void {
  const passwordVault = new SyncplayPasswordVault(store)

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
    // The join flows (WatchTogetherView, in-player join) never carry the
    // password — main owns it, so every entry point authenticates the same way
    // as Settings → Test connection (#216).
    const password = cfg.password || passwordVault.get()
    syncplay.connect({ ...cfg, password: password || undefined })
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_PASSWORD, (_event, password: string) => {
    passwordVault.set(typeof password === 'string' ? password : '')
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_HAS_PASSWORD, () => passwordVault.has())

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

  // Payload-free until #307, and the payload it gained is deliberately narrow.
  // The #288/#300 half of `playerClosed()` — the snapshot clock, the adoption
  // latch and the seek intent — still clears **unconditionally**, because the
  // renderer-side ordering invariant documented at `playerClosed()` makes that
  // safe and because gating it is exactly the #288 regression. What the
  // `playerSessionId` argument gates is only the half #307 adds: nulling
  // `currentFile` and putting `Set: {file: null}` on the wire, which no later
  // snapshot would undo if it landed on the wrong player. `undefined` — an
  // older renderer, or a mount that never announced — is unmatchable, so the
  // handler degrades to head's behaviour rather than clearing blindly.
  ipcMain.handle(CHANNELS.SYNCPLAY_PLAYER_CLOSED, (_event, playerSessionId?: string) => {
    syncplay.playerClosed(playerSessionId)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_SET_READY, (_event, isReady: boolean) => {
    syncplay.setReady(isReady)
  })

  ipcMain.handle(CHANNELS.SYNCPLAY_GET_STATUS, () => syncplay.getStatus())

  ipcMain.handle(CHANNELS.SYNCPLAY_GET_ROOM_USERS, () => syncplay.getRoomUsers())

  // A dedicated channel rather than a field on SYNCPLAY_GET_STATUS (#262):
  // `SyncplayStatus` is the connection-state shape the lifetime-scoped
  // `useSyncplayStore` caches for UI hydration, and a per-open, time-sensitive
  // playhead read served from that cache would be stale by construction.
  // The `canonicalName` argument scopes the answer to the file the caller is
  // opening (#272 review): main answers `null` unless the room's position was
  // reported for that same file, so a fresh mount for a different episode cannot
  // inherit the previous one's position through a push that has not landed yet.
  ipcMain.handle(CHANNELS.SYNCPLAY_GET_ROOM_POSITION, (_event, canonicalName: string) =>
    syncplay.getRoomPosition(canonicalName)
  )
}

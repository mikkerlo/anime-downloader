import { EVENT_CHANNELS } from '@shared/ipc/channels'
// `SyncplayStatus` below is the ambient one, wider than main's stored `SyncplayConnectionStatus`.
import type {
  SyncplayRemoteEpisode,
  SyncplayRemoteState,
  SyncplayRoomEvent,
  SyncplayRoomUser
} from '../syncplay'

/** Wire-trace frame, emitted only while the syncplay DEBUG flag is on. */
export interface SyncplayTraceEntry {
  dir: 'in' | 'out'
  keys: string
  msg: unknown
}

/**
 * The slice of `SyncplayClient` this module consumes. Narrower than the class
 * on purpose: the wiring only ever subscribes, so a test can hand it any
 * emitter rather than a fully-constructed client.
 */
export interface SyncplayBroadcastSource {
  on(event: 'connection-status', listener: (status: SyncplayStatus) => void): unknown
  on(event: 'remote-state', listener: (state: SyncplayRemoteState) => void): unknown
  on(event: 'room-users', listener: (users: SyncplayRoomUser[]) => void): unknown
  on(event: 'room-event', listener: (ev: SyncplayRoomEvent) => void): unknown
  on(event: 'remote-episode-change', listener: (ep: SyncplayRemoteEpisode) => void): unknown
  on(event: 'trace', listener: (entry: SyncplayTraceEntry) => void): unknown
}

/** Fan-out broadcaster to every renderer window (the `index.ts` `broadcastToAll`). */
export type SyncplayBroadcast = (channel: string, ...args: unknown[]) => void

/**
 * Bridges the six `SyncplayClient` events onto their `EVENT_CHANNELS`
 * broadcasts (#361 step 1).
 *
 * These six wirings used to sit inline in `bootstrap()` in `src/main/index.ts`,
 * which boots the app and is excluded from coverage collection
 * (`vitest.config.ts:28`), so nothing could import them and the six broadcast
 * channels appeared in no test at all. Both the emitter and the sink are
 * parameters so the pair can be driven in-process: `index.ts` passes the real
 * `syncplay` singleton and `broadcastToAll`, a test passes its own.
 *
 * Deliberately a plain function rather than a `register(deps: AppDeps)` router:
 * it registers no channel handlers, so `registerIpcRouters()`'s slow-handler
 * probe has nothing to wrap, and taking `AppDeps` would drag in twenty seams it
 * never reads. Hence the `-broadcasts.ts` suffix instead of `.ipc.ts`.
 */
export function registerSyncplayBroadcasts(
  client: SyncplayBroadcastSource,
  broadcast: SyncplayBroadcast
): void {
  client.on('connection-status', (status: SyncplayStatus) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_CONNECTION_STATUS, status)
  })
  client.on('remote-state', (state: SyncplayRemoteState) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE, state)
  })
  client.on('room-users', (users: SyncplayRoomUser[]) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_ROOM_USERS, users)
  })
  client.on('room-event', (ev: SyncplayRoomEvent) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_ROOM_EVENT, ev)
  })
  client.on('remote-episode-change', (ep: SyncplayRemoteEpisode) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_REMOTE_EPISODE_CHANGE, ep)
  })
  client.on('trace', (entry: SyncplayTraceEntry) => {
    broadcast(EVENT_CHANNELS.SYNCPLAY_TRACE, entry)
  })
}

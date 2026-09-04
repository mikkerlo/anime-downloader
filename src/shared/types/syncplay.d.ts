// Shared domain types — Syncplay (Watch Together).
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface SyncplayConnectConfig {
  host: string
  port: number
  room: string
  username: string
  password?: string
  autoReconnect: boolean
}

interface SyncplayFilePayload {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  duration: number
  /** True on the **first** file push of each `useSyncplayClient` mount (#236).
   *  Tells main "a new player is announcing itself", which neither the
   *  canonical name (stable across a re-push) nor snapshot staleness (a clock,
   *  wrong for `PLAYBACK_STALE_MS` after a close) can say.
   *  Renderer→main only — it never reaches the Syncplay wire.
   *
   *  Since #307 a same-episode reopen usually trips main's name check too, as a
   *  matching `playerClosed()` nulls `currentFile` first. That is redundancy,
   *  not a replacement: the file survives every close that does not match — a
   *  crash, a kill, a stale mount's close — and on those this flag is still the
   *  only honest signal. */
  newPlayer?: boolean
  /** Identifies the `useSyncplayClient` mount making this announcement (#307).
   *  One value per mount, carried by every push that mount sends (the duration
   *  re-push, the in-player translation switch, the transition-into-ready
   *  re-announce on a reconnect), so main can tell "the player that announced
   *  this file has closed" from "some older mount's close arrived late". Quoted
   *  back on `syncplayPlayerClosed`, where it gates the file clear and the
   *  outbound `Set: {file: null}` — and nothing else. Renderer→main only, like
   *  `newPlayer`: it never reaches the Syncplay wire. */
  playerSessionId?: string
}

interface SyncplayStatus {
  state:
    | 'idle'
    | 'connecting'
    | 'tls-probing'
    | 'tls-handshake'
    | 'hello-sent'
    | 'ready'
    | 'reconnecting'
    | 'disconnected'
  host?: string
  port?: number
  room?: string
  username?: string
  tls?: boolean
  error?: string
  /** Projection of main's `playbackAdopted` latch (#228) — "our local playback
   *  has converged with the room, so what we assert now reaches the wire".
   *  Never a stored field on the status object: it is overlaid in `setStatus()`
   *  / `getStatus()` from the latch itself, because `tearDown()` clears the
   *  latch without emitting a status and a mirrored copy would leak session 1's
   *  `true` into session 2's whole pre-adoption window. */
  playbackAdopted?: boolean
  /** Projection of `lastRoomState.paused` (#228) — the room's own pause flag as
   *  the server last reported it, recorded *above* `handleState()`'s echo
   *  guards. The renderer almost never sees the echo of its own pause (self-
   *  `setBy` and `setBy`-null states are dropped), so this is how it learns its
   *  pending pause has reached the room. Session-scoped by construction:
   *  `tearDown()` nulls `lastRoomState`. */
  roomPaused?: boolean
  /** *Which* de-adoption this is (#281) — `true` while `playbackAdopted` is
   *  false **and** the room's projected position lies past the end of the file
   *  we announced. `playbackAdopted: false` alone cannot tell "converging" from
   *  "the room is somewhere I cannot go", and the renderer needs the second
   *  answer for both halves of its pause rule: it must not arm the pending-pause
   *  hold in this state (the hold's terminator can never fire, because main is
   *  silent and the room will never pause for us), and it must refuse a room
   *  resume that would override a local user pause.
   *
   *  A projection like the two above, recomputed on every read rather than
   *  stored — see `statusProjection()` for why, and for why it is not read out
   *  of `isAdopted()`, which is a mutator. Fails open: no file, or a duration
   *  we cannot use, reads `false` and follows the room as before. */
  outOfFile?: boolean
}

interface SyncplayRemoteState {
  paused: boolean
  position: number
  setBy: string | null
  doSeek: boolean
}

interface SyncplayRoomUser {
  username: string
  file: { name: string; duration: number; size?: number } | null
  isReady?: boolean
  animeDlAppMeta?: {
    animeId: number
    malId: number | null
    episodeInt: string
    translationId: number | null
  }
}

interface SyncplayRoomEvent {
  level: 'info' | 'warn' | 'error' | 'chat'
  text: string
}

interface SyncplayRemoteEpisode {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  fromUser: string
}

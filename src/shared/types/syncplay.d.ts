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

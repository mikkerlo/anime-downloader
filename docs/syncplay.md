# Watch Together (Syncplay)

Two (or more) users watching the same anime together over the Internet, staying in lockstep on playback position. Compatible with the [Syncplay](https://syncplay.pl) protocol — connects to community servers (`syncplay.pl:8999` default) and interoperates with the reference `syncplay.pl` desktop client (mpv/VLC), so a friend can watch along from any player Syncplay supports.

## Module: `src/main/syncplay.ts`

Standalone TCP/TLS client. **TLS-only:** `net.Socket` opens the TCP connection, the very first message we send is the Syncplay TLS probe `{TLS:{startTLS:'send'}}` (the key must be `startTLS` — servers close the socket immediately on anything else), and only after the server replies `{TLS:{startTLS:'true'}}` and `tls.connect({ socket })` finishes its handshake (with `rejectUnauthorized` left at its default `true`) do we send the `Hello` message containing username/password. The server password travels as an **MD5 hex digest** (`md5Hex()` in the module) — Syncplay servers MD5 their own `--password` at startup and compare digests, so sending it plaintext is always rejected with "Wrong password supplied"; MD5 is the protocol's wire format, not a security claim, since the session is already inside TLS. Servers that do not support STARTTLS — or whose certificate fails verification against `host` — drop the connection with a clear error. Line-delimited JSON (each message is one JSON object followed by `\r\n`). All protocol-level concerns live here — the renderer only emits high-level playback events.

State machine: `idle → connecting → tls-probing → tls-handshake → hello-sent → ready → (reconnecting) → disconnected`. On transport error: exponential backoff reconnect, max 5 attempts. On protocol error (wrong password, bad handshake, server refused TLS, protocol garbage): abort without retry — a non-Syncplay server will not become one on retry. Garbage detection (#215) is pre-`ready` only: 5 JSON parse failures in one attempt, or 64 KB received without a single valid message (`GARBAGE_PARSE_FAILURE_LIMIT`/`GARBAGE_BYTE_CAP`), abort with "Server sent data that is not Syncplay protocol — is this a Syncplay server?"; post-`ready` a corrupt line keeps the skip-and-log behavior so a live session doesn't die on one bad frame. The counters deliberately survive the TLS upgrade — plaintext-phase garbage counts toward the same attempt's verdict.

**Per-socket vs per-session state:** `resetTransportState()` clears everything that belongs to one socket — `rxBuffer`, `tlsUpgraded`, the `ignoringOnTheFly` counters, `serverRtt`, the garbage-detection counters (#215) — and is called both by `tearDown()` and by the reconnect path in `onSocketClose()`. The reconnect path deliberately does *not* go through `tearDown()`, so it must reset this itself: a stale `tlsUpgraded` makes `handleTls()` treat the retry's probe reply as a spurious post-upgrade message, `tls.connect()` is never called again, and the client hangs in `tls-probing` until the server times it out (#216). Room membership and the readiness toggle survive a reconnect on purpose — the server sends a fresh `List` and `finishHandshake()` re-sends readiness.

**Password ownership:** the server password lives in main (`src/main/syncplay-credentials.ts`, `SyncplayPasswordVault`), persisted under the `syncplayPassword` store key — same treatment as `token` and `shikimoriCredentials`. Settings writes it with `syncplay:set-password` and can only ask *whether* one exists (`syncplay:has-password`); it is never read back into the renderer, so the input renders blank with a "saved" placeholder and a Clear button. `syncplay:connect` injects it into the outgoing config, which is the whole point: the join flows — the Watch Together view and the in-player join — send no password of their own and would otherwise connect unauthenticated (#216).

**Disconnect reasons (#213, #215):** the disconnected `status.error` is composed from the **last attempt only**, in precedence order: `lastServerError` (a non-escalated server `Error` frame, recorded only pre-`ready` and cleared in `finishHandshake()` — surfaced verbatim, e.g. `Room name is invalid`) → `lastSocketError` (the transport error, `Connection closed — connect ECONNREFUSED …`) → `closeReasonForPhase` (`PHASE_CLOSE_REASON`, keyed by `lastAttemptPhase` — the furthest phase the attempt reached, tracked in `setStatus()` against the five-phase whitelist and reset per attempt in `openSocket()`). An errorless close therefore always names its phase ("Server closed the connection during the TLS probe — …", "Connection to the server was lost") instead of a bare "Connection closed". The maxed-out variant prefixes `Max reconnect attempts reached — ` and uses each detail's short form (`no reply to TLS probe`, `connection lost`, …) so it stays one sentence. All three detail slots are per-attempt (reset in `openSocket()`, *not* `resetTransportState()`, which runs before the close handler composes the reason), and `status.error` is cleared (`error: undefined`) in the `openSocket()`, `finishHandshake()`, and user-`disconnect()` `idle` patches so a stale failure never renders next to a healthy or idle status. Per #119, "auto-reconnect disabled" is still never shown as a disconnect reason.

## File Identity

Syncplay clients identify "are we watching the same thing?" by file name + duration. We canonicalize our label to `"{animeName} - {episodeInt}"` so mpv/VLC users see a human-readable name, and duration is the HTML5 `<video>` `duration` rounded to the nearest second. For app-to-app sync (two instances of this app), we additionally stamp `features.animeDlAppMeta = { animeId, malId, episodeInt, translationId }` on outbound `Set.file` messages — the remote side uses this to auto-navigate when the other user advances to the next episode. Users on mpv/VLC don't emit this field, so auto-nav is a best-effort upgrade and the app falls back to identity-by-name for them.

## `ignoringOnTheFly` Bookkeeping

The protocol's anti-echo counter. Two independent counters (client-side and server-side) ride along on `State` messages. Local play/pause/seek increments `clientIgnoreCounter` and sends it on the next `State`; the server reflects the counter back. Until `pendingClientAck` drops to zero, inbound `State` messages that would override our local intent are dropped. This is the authoritative echo-suppression mechanism.

Belt-and-suspenders: the renderer also sets `suppressNextLocalEventUntil = Date.now() + 250` after applying a remote state, so any `play`/`pause`/`seeked` events fired synchronously by the HTMLMediaElement during the apply don't bounce back to the server in the brief window before the counter round-trip completes.

## Heartbeat + RTT Compensation

A 1 s heartbeat (`setInterval` in main) sends the current `{paused, position}` regardless of local user input — this is how a stable idle state propagates and stays calibrated. Position source is a renderer-pushed snapshot via unthrottled `syncplay:local-snapshot` IPC on 1 s cadence, so main never pokes into renderer video state.

Each outbound `State` stamps `clientLatencyCalculation = now / 1000`. The server echoes it back in its next `State`; `serverRtt = now − lastClientLatencyCalculation`. Inbound remote positions are shifted by `+ serverRtt / 2` before applying, to account for wire delay.

## Apply Rule

On inbound `State`, the renderer compares remote vs. local:
- `paused` differs → call `play()` / `pause()`.
- `state.doSeek === true` **or** `|remote.position − local.currentTime| > 3.0` → set `currentTime = remote.position`. The 3 s tolerance prevents drift jitter from causing constant micro-seeks.

## Readiness Gate (Buffer Sync)

When either user runs out of MSE buffer (HTML5 `waiting` event, or the MSE respawn path's `waitForBufferAhead`), the renderer calls `syncplay:set-ready(false)` which emits `Set: {ready: {isReady:false, manuallyInitiated:false}}`. Main tracks readiness per user from `Set: {user:{X:{isReady:{…}}}}` broadcasts and from `List` messages. A user dot turns amber in the popover's member list.

Renderer gates playback locally: if any room member (including self) is `isReady: false`, `applySyncplayReadyGate()` calls `v.pause()` even when the last remote `State` said `paused: false`. The last remote play intent is remembered in `syncplayLastRemotePlaying`; when the last not-ready user flips back to ready, the gate calls `v.play()` automatically. This keeps two app instances locked together when one falls behind on download/decode, rather than ping-ponging pause/play broadcasts.

## Remote Episode Auto-Nav

When the remote user advances to a new episode (detected by `features.animeDlAppMeta.episodeInt` change on inbound `Set.file`), main broadcasts `syncplay:remote-episode-change` with `{ animeId, episodeInt, translationId }`. PlayerView checks `animeId` against its current anime:
- **Match** — walks `goToEpisode('next'|'prev')` in a loop until `activeEpisodeIndex` reaches the target. Reuses the normal episode-switch path (including translation resolution).
- **Mismatch or episode not in list** — toast only. The app can't navigate to an anime that isn't loaded in the current view.

## Join Flow (WatchTogetherView, #213)

A dedicated **Watch Together** sidebar view lets a user join a room *before* opening the player. It connects with the saved server/username settings, renders the live member list (username, ready dot, current file) from the `useSyncplayStore` Pinia store, and — for members whose `Set.file` carried `animeDlAppMeta` — offers **"Join & watch"**: the room state is re-fetched at click time (the peer may have advanced episodes), then `useOpenEpisode` resolves the anime + a CDN stream for the peer's `(animeId, episodeInt, translationId)` and opens the built-in player. mpv/VLC peers (no app metadata) are listed but not auto-joinable.

Connection handoff: the room connection lives in main and outlasts view mounts. `useSyncplayClient` never assumes it owns the lifecycle — on mount it re-seeds the store and, if the session is already `ready`, immediately pushes the current file (the transition-into-ready watcher never fires in that case; without the push the joiner would stay invisible to the host). `onDurationChange` re-pushes once real duration is known.

Renderer state ownership: `useSyncplayStore` (`src/renderer/src/stores/syncplay.ts`) singleton-owns the `connection-status` and `room-users` subscriptions, seeded from `syncplay:get-status`/`syncplay:get-room-users`; WatchTogetherView and the player's `useSyncplayClient` both read from it. Player-scoped subscriptions (remote-state, room-event, trace, remote-episode-change) stay in `useSyncplayClient`.

## IPC Surface

Main-side handlers (see [IPC Handlers](./ipc.md)): `connect`, `disconnect`, `set-file`, `local-state`, `local-snapshot`, `set-ready`, `get-status`, `get-room-users`, `set-password`, `has-password`. Broadcasts: `connection-status`, `remote-state`, `room-users`, `room-event`, `remote-episode-change`. Settings tab "Watch Together" in `SettingsView.vue` persists host/port/room/username/autoReconnect under the `syncplay` electron-store key, and the password separately under `syncplayPassword` (see Password ownership above). The live connection itself is **not** persisted: users must rejoin after a restart.

Debug tracing gated by `SYNCPLAY_DEBUG=1` env var — dumps every inbound/outbound JSON message and state transition to the main process log.

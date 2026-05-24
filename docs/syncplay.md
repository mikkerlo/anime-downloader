# Watch Together (Syncplay)

Two (or more) users watching the same anime together over the Internet, staying in lockstep on playback position. Compatible with the [Syncplay](https://syncplay.pl) protocol — connects to community servers (`syncplay.pl:8999` default) and interoperates with the reference `syncplay.pl` desktop client (mpv/VLC), so a friend can watch along from any player Syncplay supports.

## Module: `src/main/syncplay.ts`

Standalone TCP/TLS client. **TLS-only:** `net.Socket` opens the TCP connection, the very first message we send is the Syncplay TLS probe `{TLS:{option:'send'}}`, and only after the server replies `{TLS:{startTLS:'true'}}` and `tls.connect({ socket })` finishes its handshake (with `rejectUnauthorized` left at its default `true`) do we send the `Hello` message containing username/password. Servers that do not support STARTTLS — or whose certificate fails verification against `host` — drop the connection with a clear error. Line-delimited JSON (each message is one JSON object followed by `\r\n`). All protocol-level concerns live here — the renderer only emits high-level playback events.

State machine: `idle → connecting → tls-probing → tls-handshake → hello-sent → ready → (reconnecting) → disconnected`. On transport error: exponential backoff reconnect, max 5 attempts. On protocol error (wrong password, bad handshake, server refused TLS): abort without retry.

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

## IPC Surface

Main-side handlers (see [IPC Handlers](./ipc.md)): `connect`, `disconnect`, `set-file`, `local-state`, `local-snapshot`, `get-status`. Broadcasts: `connection-status`, `remote-state`, `room-users`, `room-event`, `remote-episode-change`. Settings tab "Watch Together" in `SettingsView.vue` persists host/port/room/username/autoReconnect under the `syncplay` electron-store key — session state (currently-connected room, password) is **not** persisted across restarts.

Debug tracing gated by `SYNCPLAY_DEBUG=1` env var — dumps every inbound/outbound JSON message and state transition to the main process log.

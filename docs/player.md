# Built-in Video Player

In-app HTML5 video player with optional Anime4K WebGPU upscaling shaders. Uses `anime4k-webgpu` npm package for GPU-accelerated real-time upscaling.

## Custom Protocol

`anime-video://` protocol registered via `protocol.handle` serves local video files to the `<video>` element. The `stream: true` privilege enables HTTP range requests for seeking. The handler manually parses `Range` headers and returns 206 Partial Content responses using `fs.createReadStream({ start, end })` for proper seeking support. URL shape: `anime-video://{encodeURIComponent(filePath)}`. (MKV streaming does not use this protocol — it flows through MSE over IPC; see below.)

## Video Playback

- **Local .mp4**: Served via `anime-video://` protocol
- **Local .mkv**: Progressive playback via **MSE (MediaSource Extensions)**. The main process ffprobes the MKV for duration and codec parameters (H.264 → `avc1.…`, HEVC Main / Main 10 / Main Still Picture → `hvc1.…`, plus AAC → `mp4a.40.2/.5/.29`), then spawns ffmpeg with `-c copy -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1` and streams its stdout to the renderer via `player:stream-chunk` events. For HEVC, `-tag:v hvc1` is added so the fMP4 track carries parameter sets in the sample entry (Chromium's MSE rejects `hev1` tags). `player:remux-mkv-stream` returns `{ sessionId, duration, mimeType, hasSubtitlesPending, initialSeek }` immediately. The renderer creates a `MediaSource`, sets `duration` upfront, calls `addSourceBuffer(mimeType)`, appends each incoming chunk, and binds `<video>` to the `URL.createObjectURL(mediaSource)`. Backpressure: main tracks pending-bytes per session, pauses `ffmpeg.stdout` when pending data exceeds 64 MB, and resumes once it drains below 16 MB; renderer acks via `player:stream-ack` each 1 MB appended. Subtitle extraction runs in parallel and is pushed via `player:stream-subtitles` when ready. SourceBuffer quota is managed by evicting buffered data >60 s behind the playhead on every `updateend`, with a `QuotaExceededError` retry path. `player:cleanup-remux` SIGKILLs active ffmpeg processes and sweeps the temp dir (`os.tmpdir()/anime-dl-remux/`, used for temporary remuxed `.mp4` files and extracted subtitle files such as `.ass`).

  **Frame-accurate seeking** (#198): ffmpeg's fmp4 muxer always normalizes its output PTS to start at 0 per session (`tfdt.baseMediaDecodeTime` is written relative to track start, not absolute file PTS, even with `-copyts`), so the renderer must offset the buffer by the run's true content start to map fragments onto the absolute file timeline. Both open (`MseOpenResult.initialSeek`) and mid-stream seek (`player:stream-seek` → `timestampOffset`) hand that value back; the renderer sets `sourceBuffer.timestampOffset` to it and keeps `<video>.currentTime` on the user's exact target.

  The content start is **path-specific and must be measured, not guessed**:
  - **Stream copy** can only start at an indexed keyframe, and ffmpeg's `-ss` input seek uses the container's *sparse* seek index — on Matroska it lands on the keyframe *strictly before* the requested time (a ~0.5–1 s deadzone after each keyframe still snaps to the previous one). A frame scan sees *every* keyframe, so a pre-snapped `-ss <keyframe>` **double-snaps ~one GOP early** while the renderer labels the buffer with the un-snapped time — the buffer ends up shifted by a GOP and subtitles run seconds ahead. The fix: pass the **raw** requested time as `-ss` (no pre-snap) and measure the run's true `timestampOffset` with `probeCopyTimestampOffset` — two concurrent `ffmpeg | ffprobe` pipe pairs (nothing touches disk): one replicates the input seek with `-copyts` into NUT (the only pipeable container that preserves absolute timestamps) and reads the landing keyframe's **absolute PTS**; the other replicates the live fMP4 mux verbatim and reads the **output PTS** that keyframe is emitted at (B-frame reorder over the `-avoid_negative_ts make_zero` anchor, which zeroes on the earliest DTS across *both* streams — so the keyframe's PTS alone would be off by a sub-second margin). `timestampOffset` = absolute − emitted. The probes run concurrently with the session spawn (their result feeds only the IPC reply), so they never delay first bytes.
  - **Transcode** decodes from a keyframe and (accurate-seek) discards forward to the exact `-ss` time, so the first emitted frame *is* the requested time — `timestampOffset` = the raw request, no probe needed.

  Either way the buffer starts at a real keyframe (SAP) and is correctly labeled, so `<video>.currentTime` stays on the user's target: Chromium decodes from the leading keyframe and presents the target frame in sync — the standard in-buffer seek. For an unbuffered (skip) seek, `handleUnbufferedSeek` sends the raw target to `player:stream-seek` and, after setting the returned `timestampOffset`, leaves the playhead where the user put it. For resume-from-middle the composable lands `currentTime` on the saved position once the first fragment arrives (moving it off 0, which Chromium won't auto-jump), so `PlayerView.resumeFromSavedPosition` does *not* also seek. Play-from-start is untouched. Enable **Settings → Debug → Player seek diagnostics** (`playerDiagLogging`, applies live) or set `ANIME_DL_PLAYER_DIAG=1` to log the exact ffmpeg args and each probed landing vs the requested time — to the main-process console and to `userData/player-diag.log` (openable from the Debug tab), so packaged builds can retrieve it.

  **Seek commit + post-respawn buffer gate** (#127): the scrubber commits the seek to `<video>.currentTime` only on release (`@change`), not on every `@input` drag tick — each `currentTime` write fires a `seeking` event, and committing per-tick churns the MSE pipeline (an ffmpeg respawn per debounce window plus repeated SourceBuffer parser resets), which on Linux/WSL produces repeated `readyState=1` stalls and audio dropout. During the drag only the displayed time + tooltip update. After any unbuffered-seek respawn, `use-mse-player` pauses playback behind a buffer-ahead gate (`mkvBuffering` + `waitForBufferAhead`) until a margin of fresh data is buffered ahead, then resumes — 3 s / 15 s on the transcode path (ffmpeg runs at ~real-time with little headroom), 1.5 s / 5 s on the stream-copy path (fills far faster, but still needs the decoder to bed in before the element renders, or the same WSL stutter recurs).

  **HEVC transcode fallback**: When `MediaSource.isTypeSupported` returns false for an `hvc1`/`hev1` mime (typical on Linux Electron builds, WSL2, and any machine without a platform HEVC decoder), the renderer branches to `player:remux-mkv-stream-transcode`. This path reuses the same session/backpressure/generation-counter plumbing but replaces `-c copy` with a real-time H.264 encode. Encoder selection is performed on demand the first time this path is used via `pickH264Encoder()`, which then caches the first successful result for subsequent transcode sessions. The probe order is `h264_vaapi` (Linux, trying each available `/dev/dri/renderD*` render node), `h264_nvenc`, `h264_qsv`, and `libx264`, using a 1-frame `testsrc` dry-run encode; the first one to succeed is cached. Audio is stream-copied when the source is AAC, otherwise transcoded to AAC 192 kbps. The resulting mime is `video/mp4; codecs="avc1.640028, mp4a.40.2"`. Consent UX is controlled by the `hevcTranscodeOnPlay` setting (`ask` | `always` | `never`): in `ask` mode the renderer shows a modal with four choices — Transcode once, Always transcode (persists the setting to `always`), Open in external player (uses `shell:open-external-file` → `shell.openPath`), or Cancel. Legacy `player:remux-mkv` is still used as a fallback for other non-MSE-compatible codec combinations. To keep IPC traffic under control when the encoder runs at 30×+ realtime, the main process coalesces ffmpeg stdout into ~256 KB batches before sending `player:stream-chunk` events; without batching the renderer main thread sees 200+ IPC events per second and the video compositor starves. **Known limitation**: on systems with a weak Chromium video render path (notably WSL2), even the transcoded H.264 stream can exhibit picture-lag during steady-state playback where audio and subtitles advance at 1× but displayed frames fall progressively behind. The "Open in external player" modal option is the workaround on affected systems.
- **Non-downloaded episodes**: Streams directly from smotret-anime CDN via `player:get-stream-url` IPC

## Anime4K WebGPU Pipeline

When shaders are enabled and WebGPU is available:
1. Video frames copied to GPU texture via `device.queue.copyExternalImageToTexture()`
2. Anime4K preset pipeline processes the texture (compute shaders)
3. Output rendered to canvas via fullscreen quad render pass
4. Frame loop driven by `video.requestVideoFrameCallback()`

Preset modes: Mode A (1080p source), Mode B (720p source), Mode C (480p source). Falls back to plain `<video>` when WebGPU is unavailable.

## Subtitles

ASS subtitles are rendered natively using [JASSUB](https://github.com/ThaUnknown/jassub) (libass compiled to WASM), preserving full ASS styling — colors, positioning, fonts, effects, and sign translations. JASSUB renders subtitles onto a transparent canvas overlaid on the video element.

- **Local files**: `player:get-local-subtitles` reads raw `.ass` file alongside the `.mp4`
- **Streaming**: `player:get-stream-url` fetches raw ASS content from smotret-anime API
- Raw ASS content is passed to the renderer and fed directly to JASSUB via `subContent` option
- JASSUB worker is bundled by Vite via `?worker&url` import; at runtime, the worker code is fetched, `import.meta.url` references are replaced with concrete URLs, and a blob URL is created for classic worker compatibility (Electron doesn't support module workers with `file://` protocol). A Vite plugin (`jassub-electron-fix`) strips `type: "module"` from JASSUB's Worker constructor.
- On subtitle update (e.g., translation switch), the previous JASSUB instance is destroyed and a new one created

## Quality Selector

Dropdown in player controls showing all available stream heights (e.g., 1080p, 720p, 480p). Available streams are returned by `player:get-stream-url` IPC. On quality switch: updates `<video>` src, preserves playback position. Only visible when streaming (not for local files).

## Translation Selector

Dropdown in player controls showing all available translations for the current episode. Translations are passed from `AnimeDetailView.episodeRows` data through `App.vue` to `PlayerView` as `{ id, label, type, height }[]`. Each option shows the author name and a sub-label with type (RU SUB, EN DUB, etc.) and quality. On switch: calls `player:get-stream-url` with the new translation ID to get a fresh stream URL + subtitles, updates `<video>` src and subtitle track, preserves playback position. Only visible when streaming with more than one translation available.

## Episode Navigation

Prev/next episode buttons in the title bar for seamless binge-watching. `AnimeDetailView` passes the full `filteredEpisodes` list (all episodes, not just the current page) as `allEpisodes` prop through `App.vue` to `PlayerView`. Each entry contains `{ episodeInt, episodeFull, translations, downloadedTrIds }`.

Translation resolution for the target episode: (1) prefer any downloaded translation (downloaded wins over streaming — same ID first, then same type, then any downloaded), (2) same translationId via streaming, (3) best quality of same type via streaming, (4) first available. Cleans up previous MKV remux when switching.

Auto-advance: when video ends and next episode is available, shows a 5-second countdown overlay. User can cancel or let it auto-navigate to the next episode.

Configurable keyboard shortcuts: `playerPrevEpisode` (default Shift+ArrowLeft) and `playerNextEpisode` (default Shift+ArrowRight) in Settings > Shortcuts.

## Pre-fetch Next Episode

While the user watches episode N, `PlayerView` opportunistically enqueues a download for episode N+1 to make the next transition instant. Trigger is configurable via `prefetchNextEpisode` (Settings > Player): `off`, `open` (fires from `onDurationChange`), `time-5min` (fires from the same `cumulativePlayTime` accumulator that powers watched-flag detection — counts real playback only, not wall clock), or `progress-50` (default; fires from `onTimeUpdate` when `currentTime / duration >= 0.5`). Each episode fires at most once via a `${animeId}:${nextEpisodeInt}` key set, so seeking back and forward across the threshold doesn't re-enqueue. Translation matching prefers an exact `(type, author-label)` match on the next episode's translation list, falling back to best quality of the same type. The pre-fetch routes through the existing `download:enqueue` IPC — no new channels — and is silently skipped when the next episode is already on disk (`downloadedEpisodesGet`), already in the live queue (any non-terminal status), or — for auto-download-subscribed shows — strictly newer than the subscription's frozen `initialEpisodesAired` snapshot. The auto-downloader sets `initialEpisodesAired` to `episodes_aired` at subscribe time and never advances it, so the boundary represents "what the auto-downloader is responsible for." Older episodes — both pre-subscription backlog and any already-aired episode the user later deleted — still pre-fetch from the player. A small "Pre-fetching episode N…" toast appears for ~2.5s when an enqueue actually fires; the persistent `↓ Ep N · X% · Y MB/s` chip in the title bar tracks progress thereafter via 1s polling of `download:get-queue`. To avoid disk I/O contention with ffmpeg's source reads (which causes visible stutter on unbuffered seeks when both share a drive), the player auto-pauses the in-flight pre-fetch on `seeking` events that would trigger an ffmpeg respawn — i.e. MSE playback with the seek target outside the SourceBuffer's `buffered` ranges. In-buffer seeks (pure SourceBuffer scrubs) and non-MSE playback skip the pause entirely since they don't read from the disk we're writing to. The pause resumes 1.5s after the last `seeked` event (debounced so a burst of seeks coalesces into one pause/resume). On player close mid-debounce the resume is fired explicitly so the queue keeps draining. A small `↓ Ep N · X% · Y MB/s` indicator appears in the player title bar while a pre-fetch is in flight; status is polled via `download:get-queue` on a 1s interval to avoid clobbering AnimeDetailView's `download:progress` listener (which `removeAllListeners` would tear down). Once enqueued the download is not aborted on player close — symmetric with manual downloads.

## WebGPU Requirements

- `enable-unsafe-webgpu` CLI flag set before app ready
- `enable-features=Vulkan` for Linux Vulkan backend support
- GPU benchmark available in Settings > Debug (100 frames of Mode A at 720p→screen resolution)

## Composables

Renderer composables that own player concerns (`use-mse-player`, `use-anime4k`, `use-subtitles`, `use-remux`, `use-skip-markers`, `use-syncplay-client`, `use-player-keyboard`) are documented in [Renderer architecture](./renderer.md#composables).

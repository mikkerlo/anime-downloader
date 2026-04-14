# TODO

## Done

- [x] Show progress/message during ffmpeg+ffprobe download on first launch
- [x] Add "Retry all failed" button in DownloadsView for all failed downloads at once
- [x] Offline library support — cache anime details locally for downloaded anime
- [x] Episode pagination for long anime (>30 episodes)
- [x] Extract shared utilities (`formatBytes`, `formatSpeed`, `formatEta`, `getAnimeName`) into `renderer/utils.ts`
- [x] Batch library status loading — single `library-get-status` IPC replacing per-anime round-trips
- [x] Auto-save settings with debounced watchers, removed Save button
- [x] Download queue persistence — queue saved to queue.json, restored on startup
- [x] API token validation — "Test" button in Settings validates token against embed API
- [x] Auto-update mechanism — check/download/install via electron-updater from GitHub releases
- [x] Keyboard shortcuts — configurable Escape/Ctrl+F/Ctrl+D with rebinding in Settings > Shortcuts
- [x] System notifications on download/merge complete — configurable Off/Each Episode/Queue Complete
- [x] Pause All / Resume All buttons in Downloads — bulk pause/resume for active/paused downloads
- [x] Download speed throttle / bandwidth limiting — configurable speed limit (presets + custom MB/s) and concurrent downloads (1–3) in Settings > General
- [x] Shikimori Integration — OAuth login, episode/status tracking, MAL ID resolution from AnimeDetailView
- [x] Advanced File Management — Hot/Cold storage mode with auto-move support
- [x] Custom Dark Scrollbar Styling — thin scrollbars matching dark theme
- [x] Shikimori Anime List — Browse & sync watchlist with status filters, MAL ID resolution, To Watch view
- [x] Built-in Video Player with Anime4K Shaders — HTML5 player with WebGPU upscaling, CDN streaming, subtitles, GPU benchmark
- [x] Quality Selector in Player — quality dropdown in built-in player controls for switching stream resolution
- [x] Translation Selector in Player — translation dropdown in built-in player controls for switching between available translations
- [x] MKV Local Playback Support — on-the-fly remux via ffmpeg (`-c copy`) to temp MP4, auto-cleanup on player close
- [x] ASS Subtitle Support in Player — native ASS rendering via libass-wasm (SubtitlesOctopus), preserving styled subtitles (colors, positioning, effects). TODO: migrate to JASSUB for better rendering (WebGL, multithreading) once its ES module workers work on Windows Electron file:// protocol
- [x] Friends' Status on Anime Page — Shikimori friends' watch status, score, and progress on anime detail page
- [x] Seek Time Preview in Player — timestamp tooltip on seek bar hover/drag
- [x] Start Translation Menu with Current Type — translation menu opens directly to current translation's category
- [x] Friends Activity Feed — chronological feed of recent anime activity from Shikimori friends, globally sorted, top 50
- [x] Support Multiple Downloaded Translations — multiple local versions per episode with author-tagged filenames, marked in menus
- [x] Refactor Smotret-Anime API into a Dedicated Class — consolidated API logic into `SmotretApi` class in `smotret-api.ts`
- [x] Stabilize Anime Detail View Layout During Loading — unified loading state and session-level file scan cache
- [x] Disable "Go Back" Global Shortcut While Player Is Open — player key events no longer propagate to App.vue
- [x] Previous / Next Episode Buttons in Player — prev/next navigation, auto-advance, configurable shortcuts
- [x] Auto-Track Watch Progress and Resume Playback — track watched progress, persist position, and update Shikimori
- [x] Configurable Anime4K Shader Shortcuts in Player — Ctrl+1/2/3 for Mode A/B/C and Ctrl+` for Off, rebindable in Settings
- [x] Stream MKV Playback Without Full Remux Wait — fragmented MP4 piped to MSE SourceBuffer with on-the-fly ffmpeg respawn on unbuffered seek; legacy full-remux kept as fallback

---

## 1. HEVC (H.265) Support in MSE Streaming Path

**Priority:** Medium | **Effort:** Medium

The MSE streaming path added in v3.6.0 only accepts H.264 + AAC. `avcCodecString` in `src/main/index.ts:1735` hard-rejects anything where `codec_name !== 'h264'`, so HEVC MKVs cause `probeMkvForMse` to return `null`, `player:remux-mkv-stream` returns `{ error: 'Codecs not supported for MSE' }`, and the renderer falls back to the legacy full-remux path. That fallback is slow (10–20s blocking for a 1 GB file) and also only plays HEVC when Chromium has a platform decoder available — on Linux Electron builds without the HEVC feature flag, playback fails entirely. Many anime releases (especially 1080p+ encodes) are HEVC, so this is a meaningful gap.

**Problem details:**
- `probeMkvForMse` needs to produce a correct `hvc1.…` (or `hev1.…`) codec string. Unlike AVC, this requires: general_profile_space, tier_flag, profile_idc, profile_compatibility_flags, constraint_indicator_flags, and level_idc — fields ffprobe exposes only partially via `codec_tag_string`, `profile`, `level`. We may need to parse the `hvcC` box out of the bitstream, or use a heuristic based on common profile/level combinations.
- `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.…")` is the gate — Chromium returns `false` when HEVC is disabled at build time or no platform decoder is present. The renderer already falls back when `isTypeSupported` is false, so a correct codec string is enough; no separate platform probe needed.
- ffmpeg's fMP4 muxer tags HEVC tracks as `hev1` by default. Chromium MSE generally prefers `hvc1` (in-band parameter sets stored in the sample description box rather than in-stream). Add `-tag:v hvc1` to the ffmpeg args so the MP4 track is tagged correctly and parameter sets are inlined.
- Stream-copy still works (`-c copy` already handles HEVC bitstreams), so no re-encoding is required — good, since HEVC encoding on the fly would be prohibitively slow.

**Plan:**
1. **Add `hevcCodecString` helper** in `src/main/index.ts` (next to `avcCodecString` at line 1735). Accept an `Ffmpeg.FfprobeStream`, return a string like `hvc1.1.6.L93.B0` or `null` if the stream isn't HEVC or required fields are missing. Mapping:
   - profile_space: derive from `profile` (usually `""` → `0`); prefix letter (A/B/C) if non-zero.
   - profile_idc: `"Main"` → `1`, `"Main 10"` → `2`, `"Main Still Picture"` → `3`, `"Rext"` → `4`. Start with Main/Main 10 (covers ~99% of anime); reject others for now.
   - compatibility_flags: derive from profile (Main → `0x60000000` reversed-bit = `6`; Main 10 → `0x40000000` → `4`). These need to be encoded as a reversed 32-bit hex.
   - tier + level: from `level` (ffprobe gives an integer like `120` meaning 4.0, `150` meaning 5.0). Tier defaults to 0 (L); high tier (H) is rare for consumer content.
   - constraint flags: 6 bytes, usually all zero for typical profiles → `B0` (or `00` for legacy). Use `B0` as a safe default; Chromium is lenient here.
2. **Extend `probeMkvForMse`** (line 1719) to try `avcCodecString` first, then `hevcCodecString`. Combine with the existing `aacCodecString` into the `mimeType`. If both fail, return `null` (renderer falls back).
3. **Update ffmpeg spawn args** in `spawnFfmpegForSession` (line 1598). Detect video codec from a cached ffprobe (pass codec name into the function or re-probe cheaply) and, when HEVC, insert `-tag:v hvc1` before `-f mp4`. For H.264 keep the current args unchanged.
4. **Renderer change: none.** The existing `MediaSource.isTypeSupported(streamResult.mimeType)` check in `PlayerView.vue:startMseSession` already gates on platform support and falls back to legacy remux when unsupported. Add a console log noting "HEVC detected, MSE support=…" for diagnosis.
5. **Test matrix:**
   - H.264 MKV on Windows/Linux — must continue to work via the MSE path (regression check).
   - HEVC Main 10 MKV on Windows (with HW decoder) — expect MSE playback.
   - HEVC MKV on Linux Electron (typically no HEVC) — expect graceful fallback to full remux, and note that the full remux will also likely fail to play (document that Linux users may need to re-encode or use system mpv).
   - Unusual HEVC profiles (Rext, Main Still Picture) — expect `hevcCodecString` to return `null` and fallback to legacy remux.
6. **Follow-up (out of scope for this ticket):** ffprobe's profile/level fields aren't always enough to produce an accurate codec string for edge cases. If Chromium rejects a `hvc1.…` string for a file that should play, add a second attempt using `hev1.…` (tags can differ) before giving up. Longer term, parse the `hvcC` box directly from the first fMP4 fragment.

**Files:**
- `src/main/index.ts` — add `hevcCodecString`, extend `probeMkvForMse`, thread codec info into `spawnFfmpegForSession` for the `-tag:v hvc1` flag.
- `src/renderer/src/components/PlayerView.vue` — add diagnostic log only.


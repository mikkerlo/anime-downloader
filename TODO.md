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

---

## 1. Friends' Status on Anime Page

**Priority:** Medium | **Effort:** Medium

Show how your Shikimori friends relate to the anime you're viewing — their watch status, score, and progress. Displayed as a collapsible section on the anime detail page (e.g., "Friends: 3 watching, 2 completed").

**Plan:**
1. Add `getFriends(accessToken, userId)` to `shikimori.ts` — calls `GET /api/users/:id/friends` to fetch the friends list
2. Add `getUserRatesForAnime(accessToken, userIds[], malId)` — for each friend, call `GET /api/v2/user_rates?user_id=:id&target_id=:malId&target_type=Anime` to get their rate (batch with concurrency limit to respect Shikimori rate limits)
3. Define `ShikiFriendRate` interface: `{ nickname, avatar, status, score, episodes }` 
4. Add IPC handler `shikimori:get-friends-rates` in `main/index.ts` — takes `malId`, returns `ShikiFriendRate[]`
5. Expose in preload: `preload/index.ts` + `preload/index.d.ts`
6. Add a "Friends" collapsible section in `AnimeDetailView.vue` below the existing Shikimori status area
7. Show each friend as a compact row: avatar (small), nickname, status badge (watching/completed/dropped/etc.), score (if rated), episode progress
8. Cache friends list in memory for the session (friends don't change often) to avoid re-fetching on every anime page
9. Show a summary line at the top: "3 friends watching · 2 completed · 1 dropped"
10. Handle edge cases: not logged in (hide section), no friends (hide section), no friends watching this anime (show "None of your friends have this anime")
11. Files: `shikimori.ts`, `main/index.ts`, `preload/index.ts`, `preload/index.d.ts`, `AnimeDetailView.vue`

---

## 2. Friends Activity Feed

**Priority:** Medium | **Effort:** Medium

Add a feed view showing recent anime activity from your Shikimori friends — what they've been watching, completing, rating, and adding to their lists. Gives a social overview similar to Shikimori's own activity page but integrated into the app.

**Plan:**
1. Add `getFriends(accessToken, userId)` to `shikimori.ts` if not already added (shared with task 5)
2. Add `getFriendActivity(accessToken, userId)` — calls `GET /api/users/:id/history?limit=20&target_type=Anime` for each friend to get their recent anime history entries
3. Define `ShikiFriendActivity` interface: `{ nickname, avatar, animeName, animeImage, action, episodeNumber, score, timestamp }`
4. Add IPC handler `shikimori:get-friends-activity` in `main/index.ts` — fetches friends, then fetches recent history for each (with concurrency limit), merges and sorts by timestamp descending
5. Expose in preload: `preload/index.ts` + `preload/index.d.ts`
6. Create `FriendsActivityView.vue` — a new view accessible from the sidebar/nav alongside existing views (Library, Downloads, etc.)
7. Render activity as a chronological feed: friend avatar + name, anime poster thumbnail, action text (e.g., "watched episode 5", "completed", "rated 8/10"), relative timestamp
8. Clicking an anime in the feed navigates to its AnimeDetailView
9. Add a refresh button and auto-refresh on view mount; cache results for 5 minutes to avoid excessive API calls
10. Add pagination or "load more" if the feed grows long (initial load: 50 most recent entries across all friends)
11. Handle edge cases: not logged in (prompt to connect Shikimori), no friends (show empty state with message), API rate limits (show cached data with "last updated" notice)
12. Files: `shikimori.ts`, `main/index.ts`, `preload/index.ts`, `preload/index.d.ts`, `FriendsActivityView.vue`, `App.vue` (add nav entry)

---

## 3. Seek Time Preview in Player

**Priority:** Low | **Effort:** Small

Show the target timestamp when hovering/dragging the seek bar. Currently seeking is blind — user can't see what time they're seeking to until they release.

**Plan:**
1. Add a time tooltip element positioned above the seek bar thumb
2. Show on `mousemove` / `input` events on the seek input
3. Calculate time from mouse position relative to seek bar width
4. Format as `MM:SS` or `H:MM:SS` depending on duration
5. Hide tooltip on `mouseleave`
6. Files: `PlayerView.vue` only (pure UI change)

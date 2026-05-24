# Watch Progress & Resume

The built-in player auto-saves playback position to `watchProgress` (electron-store, keyed by `animeId:episodeInt`). The save hook runs on `timeupdate` throttled to 5s, and on `pause`/unmount (forced). On player open, after `loadedmetadata`, the saved position is restored if `position > 5s` and `position / duration < 0.95`, and a brief toast is shown.

"Watched" detection counts real playback time via `timeupdate` deltas (clamped `< 2s` to ignore seek jumps). An episode is marked `watched: true` when `position / duration >= 0.8` AND cumulative playback `>= 180s`. The flag is set once per episode per session.

When an episode is marked watched and `malId > 0`, the player fetches the current Shikimori rate and:
- If `rate.status === 'completed'`: flips to `'rewatching'`, resets `episodes` to the just-watched episode number, and increments `rewatches` by 1 (starts a fresh rewatch cycle from whichever episode the user opened — typically ep 1). The status check itself prevents double-bumping: after the flip the status is `'rewatching'`, so the branch no longer fires.
- Otherwise, if `epNum > rate.episodes`: calls `shikimoriUpdateRate` with `'watching'`, preserving the existing `rewatches` count.

`AnimeDetailView` loads all watch-progress entries for the anime on mount via `watchProgressGetAll` and renders a small ✓ badge (watched) or mini progress bar (partial) on each episode row. The view listens on a `watch-progress-updated` window event — dispatched by `PlayerView` after each save — to refresh indicators live.

The active translation choice is persisted into `watchProgress[key].translationId` from two paths: the player (`saveProgress` passes `activeTranslationId` on every save; `selectTranslation` writes it immediately on switch, bypassing the trivial-time guard) and the pre-player dropdown in `AnimeDetailView` (`onEpisodeTranslationChange` calls `watchProgressSave`, reusing any prior `position`/`duration` so partial-watch progress isn't clobbered). When `AnimeDetailView` builds `episodeRows`, the per-episode `selectedTr` is resolved by priority: (1) active queue lock → (2) per-episode override (in-session, sync) → (3) remembered `translationId` from `watchProgress` → (4) any downloaded translation → (5) global type+author default. An explicit user choice — even a stream — therefore wins over a downloaded file. Queue-lock stays at the top because the row UI replaces the dropdown with a "Queued" label while a download is in flight, preventing a race between user switching and the in-flight download.

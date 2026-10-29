# Watch Progress & Resume

The built-in player auto-saves playback position to `watchProgress` (electron-store, keyed by `animeId:episodeInt`). The save hook runs on `timeupdate` throttled to 5s, and on `pause`/unmount (forced). On player open, after `loadedmetadata`, the saved position is restored if `position > 5s` and `position / duration < 0.95`, and a brief toast is shown.

**The `episodeInt` in that key is the episode the `<video>` element is decoding, not the episode the UI has navigated to (#371).** The two diverge for the length of every episode change, because `goToEpisode` advances the index before the new source resolves — and a save landing in that window used to file the outgoing episode's position under the incoming episode's key, which `resumeFromSavedPosition` then restored, opening the fresh episode partway in. `saveProgress` and `maybeMarkWatched`'s Shikimori episode number therefore both read `playingEpisodeInt` (from `usePlayingEpisode`, adopted on the element's `loadstart` and seeded at mount); the restore side — `resumeFromSavedPosition` and `prepareMkvForPlayback`'s saved-position fetch — reads `currentEpisodeInt`, because those are about the episode being *opened*. See [Episode Navigation](./player.md) for the full inventory and the one mixed case (`persistSelectedTranslation`).

"Watched" detection counts real playback time via `timeupdate` deltas (clamped `< 2s` to ignore seek jumps). An episode is marked `watched: true` when `position / duration >= 0.8` AND cumulative playback `>= 180s`. The flag is set once per episode per session.

When an episode is marked watched and `malId > 0`, the player calls `shikimoriMarkEpisodeWatched(malId, epNum)` (`shikimori:mark-episode-watched`), and main computes the next rate from the live Shikimori rate:
- If `rate.status === 'completed'`: flips to `'rewatching'`, resets `episodes` to the just-watched episode number, and increments `rewatches` by 1 (starts a fresh rewatch cycle from whichever episode the user opened — typically ep 1). The status check itself prevents double-bumping: after the flip the status is `'rewatching'`, so the branch no longer fires.
- Otherwise, if `epNum > rate.episodes`: writes `'watching'`, preserving the existing `rewatches` count. A title with no rate yet is created this way.
- If the token refresh or the request fails with a network error or `ShikiAuthError` (an expired session), main computes the same next rate from the cached `shikimoriUserRates` entry instead and queues it in `shikimoriUpdateQueue`, exactly like an offline `shikimori:update-rate`. A title with no cached entry is queued too, with `rateId: null` and an empty `planned` `before`; the drain creates the rate. Before #565 the player fetched the rate itself first, so that fetch threw on all three cases and the mark was lost for good.

`AnimeDetailView` loads all watch-progress entries for the anime on mount via `watchProgressGetAll` and renders a small ✓ badge (watched) or mini progress bar (partial) on each episode row. The view listens on a `watch-progress-updated` window event — dispatched by `PlayerView` after each save — to refresh indicators live.

The active translation choice is persisted into `watchProgress[key].translationId` from two paths: the player (`saveProgress` passes `activeTranslationId` on every save; `selectTranslation` writes it immediately on switch, bypassing the trivial-time guard) and the pre-player dropdown in `AnimeDetailView` (`onEpisodeTranslationChange` calls `watchProgressSave`, reusing any prior `position`/`duration` so partial-watch progress isn't clobbered). When `AnimeDetailView` builds `episodeRows`, the per-episode `selectedTr` is resolved by priority: (1) active queue lock → (2) per-episode override (in-session, sync) → (3) remembered `translationId` from `watchProgress` → (4) any downloaded translation → (5) global type+author default. An explicit user choice — even a stream — therefore wins over a downloaded file. Queue-lock stays at the top because the row UI replaces the dropdown with a "Queued" label while a download is in flight, preventing a race between user switching and the in-flight download.

## Field clocks (#572)

Watch state carries per-field clocks so another PC's copy can be merged with it three ways (epic #563). A clock is `{ at, origin }`: `at` is ms since the epoch, and `origin` is this install's `installId` (a `crypto.randomUUID()` written once, on the first boot that lacks it), `'shikimori'` for a value observed on the server, or `'legacy'` for one projected from a row written before clocks existed. Types live in `src/shared/types/sync.d.ts`; the store helpers in `src/main/store/sync-meta.ts`; the pure pieces in `src/main/lib/sync-state/` (`clock.ts`, `gc.ts`). Clocks never decide *whether* a field changed (a value difference from the merge base does); they break ties and detect a re-watch. A stamp is monotonic per field: after a backwards wall-clock step it lands at the replaced clock's `at + 1` (`advanceClock`), so a newer edit never carries an older clock.

**`watchProgress[key].sync = { position?, watched? }`.** `watch-progress:save` takes a required seventh argument, `source: 'playback' | 'choice' | 'mark'` (the preload declares it non-optional, so TypeScript rejects a caller that omits it; main treats a missing one as non-stamping):
- `'playback'` is `PlayerView`'s `saveProgress`, which returns early until `durationchange` has set `duration`, so it never runs before metadata. It is the only source that moves `sync.position`, and only on a real change: |Δposition| ≥ 5 s, a changed `translationId`, or the row's first `'playback'` save (no position clock yet).
- `'choice'` is a translation pick: `persistSelectedTranslation` on open, and the detail page's per-episode override (`use-episode-list.ts`). It writes the row exactly as before, including position 0 on a watched row, but keeps the row's previous position clock. Opening an episode on one PC therefore cannot beat watching it on another.
- `'mark'` is `PlayerView`'s `markEpisodeWatched`.

`sync.watched` is stamped whenever `watched` flips (any source), and also when a `'playback'` save reports `watched: true` on a row that is already watched: a completed re-watch keeps the value but needs a newer clock. That signal is explicit and one-shot. When *this open* crosses the threshold, `maybeMarkWatched` sets the per-open `completedThisOpen` and a one-shot `completionPending`, which the next `saveProgress` consumes. Only that completing save sends `watched: true`; every later save of the open sends `false` (main keeps the flag sticky), so `sync.watched` records the completion and not the last save of the open. A failed completing save re-arms the flag. `resetEpisodeTracking` clears both. It is deliberately not `watchedReported`, which `resumeFromSavedPosition` restores from the saved row: sending that made every save of an opened watched episode read as a re-watch. `maybeMarkWatched` is gated on `completedThisOpen`, so a re-watch completes, once per open; its Shikimori mark still fires only for an episode that was not already watched when it opened, so S0's auto-mark is unchanged. `updatedAt` keeps meaning "last write" for its existing readers.

**Legacy rows.** A row with no `sync` is legacy, and nothing rewrites it at startup. Its first write (any save, or set-watched) materializes `position.at = updatedAt` and `watched.at = watchedAt ?? updatedAt`, both with origin `'legacy'`, *before* applying the write, so a non-stamping save cannot turn the moved `updatedAt` into a newer clock. Rows written since #572 always carry `sync`, possibly `{}`.

**Explicit unwatch.** `watch-progress:set-watched(animeId, episodeInt, watched)` is the first path that can clear `watched` (`watch-progress:save` keeps it sticky). It sets the flag, sets or clears `watchedAt`, zeroes `position` when marking watched (as every other watched write does, so the next open's `'playback'` save is not a move), stamps `sync.watched`, and returns the row (or `null` when there is none and nothing to do). It never touches Shikimori: `watched` and `rate.episodes` are independent. Each `EpisodeRow` has a mark-as-watched / mark-as-unwatched icon button in its actions, which toggles the *local* flag (`isEpisodeWatchedLocally`, not the Shikimori-aware `isEpisodeWatched`) through `useEpisodeDownloads.toggleEpisodeWatched`, dispatches `watch-progress-updated` like the other writers, and then reloads the view's progress.

**`syncMeta`** holds the clocks of the other per-title fields:
- `titles[animeId].starred` / `.priority`: stamped by `library-toggle` and `library-set-priority`. Unstar and unprioritise leave a tombstone, `{ deleted: true, at, origin }`; an unstar that demotes stamps both.
- `priorityOrder`: stamped whenever `priorityAnimeIds` changes (promote, demote, unstar of a prioritized title).
- `rates["<shikimoriUserId>:<malId>"][field] = { value, at, origin }` for `episodes`, `status`, `score`, `rewatches`; see [Shikimori](./shikimori.md#offline-update-queue). Keyed by owner because logout resets the rate cache, while `syncMeta` survives logout and account switch.

**Tombstone GC.** `updateSyncMeta`, the only writer, drops tombstones older than 365 days on the next write; nothing is rewritten at boot. With a merge base a deletion propagates without a tombstone, so tombstones only matter when both sides changed or there is no base yet. The one failure mode is benign: a PC that first merges with no base more than a year after an unstar can bring the star back.

## The SyncDoc and the merge field table (#572)

`src/main/lib/sync-state/` (pure: no `fs`, no store writes outside `applySyncDoc`) turns local watch state into a `SyncDoc` and back. Types are in `src/shared/types/sync.d.ts`.

**`SyncDoc` v1** is `{ stateVersion: 1, stateMinor: 0, installId, titles, priorityOrder, tombstones }`. Any further key is a newer writer's field and is kept verbatim.
- `titles[animeId]` holds `watch[episodeInt] = { position, watched, watchedAt }`, `starred`, `priority`, `rate = { malId, episodes, status, score, rewatches }`, `dismissed` (the dismissed continue-watching `episodeInt`s) and `skip`. `episodeInt` is an opaque string key, so `"12.5"` stays a watch entry and never maps to `rate.episodes`.
- The clocked fields are `{ value, at, origin }`: `position` (whose value is `{ position, duration, translationId? }`), `watched`, `starred`, `priority`, each rate field and `priorityOrder`. `watchedAt`, `dismissed` and `skip` carry no clock, because rules 3, 11 and 12 never read one.
- `priorityOrder` lists in-scope ids only. `tombstones[animeId]` holds the `{ deleted: true, at, origin }` of an unstar or unprioritise.
- `skip` is projected without local paths: each `perEpisode[episodeInt]` carries its file identity `file: { translationId, fileSize }` from the injected `resolveEpisodeFile`, plus `episodeLabel`, `durationSec`, `hashesPerSec`, `op` and `ed`. An entry whose file can't be identified is left out.
- Version rule (S5 #573): `stateMinor` goes up for an added optional field whose absence has a defined meaning and whose rule is silent; any other change bumps `stateVersion`.

**`projectSyncDoc(store, scope, deps)`** reads only the titles in `scope` and never writes. No out-of-scope id appears in the result, in any field.
- Legacy rows project their `'legacy'` clocks (`clock.ts`). A missing clock in a non-legacy row reads as `at: 0`.
- A legacy star, priority or order with no `syncMeta` clock reads as `{ at: 0, origin: 'legacy' }`.
- A rate is projected only for the signed-in owner. Its value is the rate cache, overlaid by the owner's latest queued edit and then by S9's pending overlay (`deps.pendingRates`). See the rate-clock rule below for its clocks.

**`applySyncDoc(store, doc, scope, deps)`** writes a merged doc back, touching only in-scope titles. It returns `{ applied, unapplied, clamped }`.
- It clamps first: any `at` more than 120 s in the future becomes now, and each clamp is reported.
- Watch rows take the doc's values and clocks. A row whose values and projected clocks already match is left alone; legacy rows and missing clocks compare as they project. Applying a store's own projection therefore writes nothing, and a pre-#572 profile's `updatedAt` order (continue-watching, the resume pick) survives the first merge. A row that does change takes `updatedAt` from the later of the doc's `position` and `watched` clocks (so a watched-only change, like a remote `set-watched`, moves it too), never moving it back, so episodes brought in by a sync keep their own recency.
- Legacy `{ at: 0, origin: 'legacy' }` star and priority clocks are not stamped into `syncMeta` when it has none.
- **`starred = true`** needs an `AnimeSearchResult` to create the `library` row. It looks in local `library`, then `downloadedAnime`, then `deps.sharedSearchResult` (the Shared Library's `meta/<animeId>.json` `searchResult`). With none, the field is reported `unapplied`, and S9 does not advance its base, so it is retried.
- `priority` needs the `library` row, and an unstar also unprioritises.
- **`priorityOrder`** is written back into the slots that in-scope ids occupy in the local list. Out-of-scope ids keep their positions, new in-scope members go at the end, and leftover slots are dropped.
- `dismissed` replaces the title's keys.
- A drive `skip` entry is taken only when its algorithm is this PC's and `deps.localEpisodeFile` resolves to the same `{ translationId, fileSize }`. Its `filePath` is then filled from that local file.
- Rate changes go to `deps.applyRate` (S9's pending store, never only the cache). Without it they are reported `unapplied`.
- Unknown fields at the doc and title level are kept in `syncMeta.unknown`, so the next projection writes them back.

**The merge field table** (`field-table.ts`) is frozen by #572. S9 (#584) applies it as written, and S5 (#573) serializes the fields it covers. "Changed" means a value difference from the base. Clocks only break the ties marked "later `at`", and detect a re-watch. With no base, every rule reduces to S9's first-merge table.

| # | Field | Silent rule | Conflict (held for S10 #585) |
|---|---|---|---|
| 1 | `watch[ep].position` | A change on one side is applied. Both changed: the later `position.at` wins (a tie goes to the local side). Only `'playback'` saves move the clock. | never |
| 2 | `watch[ep].watched` | A change on one side is applied, including an unwatch. | One side unwatched (true → false) while the other re-watched: it is still `true`, but its `watched.at` is newer than the base's. |
| 3 | `watch[ep].watchedAt` | The earliest non-null of the sides where `watched` is true; null once the merge unwatches. | never |
| 4 | `rate.episodes` | A change on one side is applied. Both changed to the same value: applied. Both rose: the max. | One lowered while the other rose. Both lowered, to different values. |
| 5 | `rate.status` | A change on one side is applied. Both changed to the same value: applied. | Both changed, to different values. |
| 6 | `rate.score` | Same as 5. | Both changed, to different values. |
| 7 | `rate.rewatches` | A change on one side is applied. Both lowered to the same value: applied. | Both changed to different values. Both rose, even to the same value (one rewatch or two?). |
| 8 | `starred` | A change on one side is applied. Both changed: the later `at` wins, tombstones included. | never |
| 9 | `priority` | Like `starred`. If the merged `starred` is false, `priority` becomes false. | never |
| 10 | `priorityOrder` | In-scope ids only. Both changed: the order of the side with the later `at`; merged members it lacks are appended in the other side's relative order. Applying rewrites only the in-scope slots. | never |
| 11 | `dismissed` | `(base ∪ addedA ∪ addedB) − removedA − removedB`. A local prune is a removal, so a pruned key doesn't come back. | never |
| 12 | `skip` | A cache. Keep the local entry when its algorithm matches; otherwise take the other side's when its algorithm and file identity match; otherwise none, and the episode is re-analysed locally. | never |

Global rules:
- Only in-scope titles take part.
- `watched` and `rate.episodes` merge independently, apart from owner decision 5 in S9.
- A fractional `episodeInt` never maps to `rate.episodes`.
- An imported `at` more than 120 s in the future is clamped to now. File mtimes are never a clock.
- Auto-download subscriptions are not merged.

**Rate clocks and discarded edits.** Rules 4–7 never decide on `at`, so a rate clock can't win a merge; it only feeds S10's suggestion and the log. A `syncMeta.rates` clock counts only while it records the value the projection sees (the cache, the owner's queue, S9's overlay). A queued edit that is later discarded (S0b's Discard on logout or from a parked bucket), or rejected by Shikimori, leaves its clock behind with a value Shikimori never received. Once the rate cache holds the server's value again, the clock no longer matches it and is ignored, and the field takes the Shikimori clock (`serverUpdatedAt`).

**Tombstones on the drive.** `pruneDocTombstones` drops tombstones older than 365 days, or for a title that has left the library's scope. S9 calls it before its drive write.

**The merge (#584).** `merge3` (`src/main/lib/sync-merge/`) applies this table as written, field by field, over in-scope titles; with no base every rule takes its no-base form above. A conflict leaves the field on both sides and keeps its base. Owner decision 5 is the one place `watched` reaches `rate.episodes`: on the owner's logged-in PC, the whole episodes a library flips to watched raise the rate once through `nextWatchedRate` (a rewatch raise only for flips newer than the rate's Shikimori clock, and never on a merge with no base). See [Shared Library](./shared-library.md#merge-584).

# Shikimori Integration

Syncs anime watch status and episode progress with [Shikimori](https://shikimori.one). Uses MAL IDs as the shared key between smotret-anime and Shikimori (`myAnimeListId` field on anime series).

## OAuth Flow (OOB)

```
1. User clicks "Connect Shikimori" in Settings > General
2. App opens Shikimori authorize URL in external browser
3. User authorizes → Shikimori displays authorization code
4. User pastes code into app → exchangeCode() → tokens stored
5. Token auto-refresh: ensureFreshToken() checks expiry before each API call
```

## Module: `src/main/shikimori.ts`

Standalone API client with hardcoded client credentials. All methods throw `ShikiApiError` on failure. Rate limit handling: retries on 429 with `retry-after` header.

## Centralized Rate Cache

Anime rates are persisted in `shikimoriUserRates` (electron-store). `shikimori:get-anime-rates` returns cached data instantly when available and triggers a background API refresh; the refresh result is broadcast via `shikimori:rates-refreshed` so open views update without a manual reload. `shikimori:update-rate` patches the cached entry in-place and broadcasts `shikimori:rate-updated` for surgical single-entry updates. ShikimoriView and AnimeDetailView both listen for these broadcasts. Cache is cleared on logout.

## Profile Dashboard (#178)

The ShikimoriView is a profile dashboard (Refined Dark). `shikimori:get-profile` returns a cached `ShikimoriProfile` instantly when available + kicks a background refresh (broadcast `shikimori:profile-refreshed`), persisted in `shikimoriProfile` (electron-store) and cleared on logout — same cache-first pattern as the rate cache. The payload is **assembled in the main process** from three sources:

- **`shikimori.getUserStats(token, userId)`** → `GET /api/users/:id`, which (unlike `/whoami`) carries a `stats` block. We parse only the two fields the API reliably backs: the anime **status breakdown** (`stats.statuses.anime` → `lists`) and the **score distribution** (`stats.scores.anime`, normalized to a 10-slot array indexed 1..10).
- **Cached `shikimoriUserRates`** → derives `titles` (count), `episodes` (Σ `rate.episodes`), `mean` (from the score distribution), and `daysWatched` (≈ episodes × 24 min).
- **Cached `shikimoriAnimeDetails`** → favorite **genres** aggregated over rated anime (top 8). This is *partial* — only anime the detail-prefetch worker has already fetched contribute genres.

Fields the Shikimori API does not expose (joined date, comments count, full genre coverage) are deliberately omitted — tracked as a follow-up. Presentation (status labels/colors, recent-activity feed) is owned by the renderer; the recent-activity list is derived in-view from the rate list sorted by `updated_at` (no extra fetch). `friendsCount` reuses `getFriends`.

### Detail prefetch worker

`shikimoriAnimeDetails` holds the rich `GET /api/animes/:id` payload (description, genres, studios) keyed by MAL ID. A background worker (`prefetchShikimoriDetails`) drains the missing-or-stale set, throttled to one request every 2 s to stay well under Shikimori's 5 req/s cap. Worklist filters to **Watching + Planned** statuses only — keeps the cache bounded for users with very large lists. Entries older than **30 days** are refreshed on the next pass. Triggers: post-`fetchAndCacheShikimoriRates` write, post-`shikimori:rates-refreshed` broadcast, and lazy on the `shikimori:get-anime-details` IPC when called for an uncached MAL ID. After each successful fetch, `shikimori:anime-details-updated` is broadcast so already-open AnimeDetailView instances hydrate in place without polling. The worker is fire-and-forget — no progress UI; the visible signal is descriptions/genres appearing in the AnimeDetailView Shikimori panel over time. An in-memory `prefetchInProgress` mutex prevents overlapping runs; a `prefetchAbort` flag is flipped on logout so an in-flight loop bails on the next iteration check after the current request and any in-progress 2 s inter-request sleep complete. Network errors and 401/403 abort the loop (retried on next trigger); 404 logs and skips that MAL ID. The cache is cleared on logout.

## Offline Update Queue

`shikimori:update-rate` distinguishes transport-level failures (fetch threw `TypeError` / `AbortError`) from HTTP errors (wrapped as `ShikiApiError`). HTTP errors propagate to the renderer as before. Transport failures are intercepted: the previous cached state is recorded as `before`, the requested change as `after`, and a `QueuedShikimoriUpdate` (`{ malId, rateId, before, after, queuedAt }`) is appended to `shikimoriUpdateQueue` in electron-store. The cached rate entry is then updated in place with the requested values so the UI reflects the change, and `shikimori:rate-updated` + `shikimori:offline-queue-changed` are broadcast. The handler returns a synthetic `ShikiUserRate` so callers (including `PlayerView`'s auto-tracker) don't need an offline branch. `AnimeDetailView` shows a "Working offline — N changes queued" chip while the queue is non-empty; it flips to a blue "Syncing…" variant with a spinner while the sync worker drains. The chip hydrates from `shikimori:get-offline-queue-length` + `shikimori:get-sync-status` on mount. Queue and timer are cleared on logout.

### Sync worker

When the queue is non-empty, a background worker (`syncShikimoriQueue`, module-level in `src/main/index.ts`) drains it back to Shikimori. Trigger cadence is outcome-based — same philosophy as the offline intercept classifier: rather than trusting `navigator.onLine` / `net.isOnline()`, we try the drain and let the fetch result tell us whether we're really online. The worker fires on a 60s timer (started only while the queue is non-empty), on boot if the queue is non-empty, after any successful online `shikimori:update-rate` or `fetchAndCacheShikimoriRates`, and on demand via `shikimori:trigger-sync` ("Retry now" button).

Before hitting the API, queued entries are consolidated per `malId` (first `before` + last `after`), so repeated offline bumps on the same anime produce a single PATCH. For each consolidated item the worker calls `getUserRate` to read current server state, then:

- **Server state matches `before`** — no drift; apply `after` via `updateUserRate`.
- **Server state drifted** — apply progress rule: only override if `after.episodes > current.episodes` AND the current status is not more advanced than `after.status` (ordering: `planned < watching/rewatching < on_hold/dropped < completed`). Otherwise reconcile local cache to the server's value and drop the queue item — the user's offline intent has been superseded by a more recent server-side decision.
- **Server returned no rate (deleted)** — recreate with `after` via `createUserRate`.

An in-memory mutex (`syncInProgress`) prevents overlapping drains. Items are processed sequentially with a 250 ms delay to stay under Shikimori's 5 req/s cap (the `shikiFetch` wrapper also handles 429 with `retry-after`). Network errors during drain abort the run and leave the queue intact for the next timer tick; 401/403 also abort without dropping items (user needs to re-auth); other HTTP errors drop the offending item and continue. `shikimori:rate-updated` is broadcast on both "applied" and "reconciled to server" paths so the UI stays consistent regardless of which branch fired.

## Friends Activity Feed

`FriendsActivityView.vue` shows a chronological feed of recent anime activity from the user's Shikimori friends. The main process fetches `GET /api/users/:id/friends`, then for each friend calls `GET /api/users/:id/history?limit=100&target_type=Anime` (concurrency 2 to respect rate limits — same pattern as `getFriendsRatesForAnime`). Entries with a present `target` are mapped to `ShikiFriendActivity` records, merged into a single list, sorted globally by `created_at` desc, and trimmed to the top 50 most-recent events overall (not per-friend). The per-friend fetch uses Shikimori's max page size so a single very-active friend can fully populate the feed if their entries are all newer. MAL IDs are resolved via `lookupByMalIds` so feed rows can deep-link into `AnimeDetailView`. The renderer caches results in-memory for 5 minutes to avoid re-fetching on tab switches; the description HTML is stripped of tags before display. The sidebar entry only appears when logged in to Shikimori.

## Airing Calendar

`CalendarView.vue` (sidebar entry gated on Shikimori login) renders a Mon–Sun grid of upcoming episodes for shows the user tracks as `watching` / `rewatching` / `planned`. The grid is N rows × 7 columns where N comes from the `calendarView` setting (`'week'` → 1, `'month'` → 4).

Data flow: `shikimori:get-calendar` calls Shikimori's public, unauthenticated `GET /api/calendar` (a sitewide list of currently-airing series), filters entries by the MAL ID set built from `shikimoriUserRates`, then resolves each surviving entry to a smotret-anime row via `lookupByMalIds` so card clicks deep-link into `AnimeDetailView` (rows that fail resolution show a "Not on smotret-anime" badge and are non-clickable). The handler returns `CalendarEntry[]` containing `{ malId, animeId | null, name, posterUrl, kind, episodeInt, nextEpisodeAt, userStatus }`. `episodeInt` comes from Shikimori's `next_episode` field (the actual episode scheduled to air at `nextEpisodeAt`), falling back to `episodes_aired + 1` if the API omits it — i.e. it reflects what's airing, not the user's personal next-up. The MAL ID lookup falls back to `shikiAnime.id` when older cached rates lack `rate.target_id`. If `shikimoriUserRates` is empty (user logged in but never opened ShikimoriView), the handler does an inline `fetchAndCacheShikimoriRates()` so the calendar isn't stuck empty on first use.

Cache: a 5-minute in-memory cache lives in main (`calendarCache`) — `/api/calendar` returns hundreds of entries and changes slowly, so view re-mounts during normal navigation reuse the same payload. The cache is invalidated whenever the underlying tracked-set could change: every `broadcastToAll('shikimori:rate-updated', …)` site, the `broadcastToAll('shikimori:rates-refreshed', …)` site, and `shikimori:logout`. The IPC accepts an optional `force` arg (the topbar refresh button passes `true`) to bypass the cache.

Renderer: `CalendarView` computes `pageStart` from a locale-aware first-day-of-week (`Intl.Locale(navigator.language).getWeekInfo?.().firstDay` — falls back to Monday). It bins entries by `new Date(nextEpisodeAt)` (the ISO offset is preserved so the platform converts to local TZ) into the configured rows × 7 grid. On the current page the grid is forward-looking — entries with timestamps before `now()` are dropped, so an episode that already aired earlier today disappears from today's cell. Today's cell is highlighted; status chips render Watching / Rewatching / Planned.

Prev/next chevron buttons in the topbar shift `pageOffset` by ±1 page (1 week in week mode, 4 weeks in month mode). The center button shows the current range and clicking it resets to "now"; on past/future pages the `now()` floor is dropped (every entry that falls in the page range is shown) and the today highlight disappears. Settings → General → "Calendar View" toggles the mode and broadcasts a `calendar-view-changed` window event so the open view re-syncs without a manual refresh.

## AnimeDetailView Panel

Shown when user is logged in AND anime has `myAnimeListId`. Displays:
- Status dropdown (planned/watching/rewatching/completed/on_hold/dropped)
- Episode count input
- Score dropdown (1–10)
- Rewatches numeric input (`rate.rewatches`, edited manually here; auto-incremented by PlayerView when transitioning from `completed` → `rewatching`)
- Save button to push changes
- Link to anime on Shikimori
- Auto-status: episodes > 0 → watching (from planned) / rewatching (from completed); episodes = max → completed
- When `rate.status === 'completed'`, every episode in the list is shown with the ✓ watched badge (regardless of local `watchProgress`), and "Continue" jumps to episode 1 so the user can start a rewatch.

## Series Chronology

Below the Shikimori panel, `AnimeDetailView` renders a Chronology list of the entire franchise sourced from `GET /api/animes/:id/franchise` (a public, unauthenticated endpoint, so the panel renders for logged-out users too). The main-process handler `shikimori:get-related` fetches the franchise graph (`{ nodes, links, current_id }`), then does a BFS from `current_id` through a whitelist of canonical relation edges (sequel/prequel/side_story/parent_story/alternative_version/summary/full_story/spin_off/alternative_setting) to drop unrelated bridges — e.g. the Isekai-Quartet `"other"` edges that otherwise pull Overlord/Konosuba/Re:Zero into a Youjo Senki franchise query. Reachable nodes are sorted chronologically by release `date`, then `lookupByMalIds` resolves each node's MAL ID to its smotret-anime entry (reusing the persistent `malIdMap` cache). Direct edges from `current_id` are walked to attach a `relation` label (source-side only, since Shikimori emits all current-node links as `source_id`); nodes more than one hop away simply omit the label. Each row shows title, kind badge (TV/movie/OVA/…), release year, relation label (when available), and — cross-referenced against `shikimoriUserRates` — a watch-status badge when the current user tracks that entry. Promos/CMs/music videos are filtered out. The current anime's node is highlighted with a "Current" badge and is non-clickable. Rows where `lookupByMalIds` returned no smotret-anime match display a "Not available" badge and are non-clickable. Clickable rows emit `open-anime` up through `App.vue`, which maintains a per-view navigation stack (`animeHistoryByView`) so Back returns to the previously-opened anime in the same tab rather than the list view. The panel is collapsed by default on every mount (header chevron toggles the body) so the page opens compact; users expand it on demand.

## Auto-download

`src/main/auto-downloader.ts` runs a forward-only worker that auto-queues newly-aired episodes for shows the user has explicitly subscribed to. Subscriptions live in `autoDownloadSubscriptions` and are managed per show from `AnimeDetailView` (an "Auto-download" pill next to "Add to Library", visible only when the show has a MAL ID, the user is logged into Shikimori, and `shikiDetails.status !== 'released'`).

`runAutoDownloadTick(reason)` is invoked from four places: ~30s after `app.whenReady` (`'startup'`), every 15 minutes (`'timer'`), inside `refreshShikimoriRatesInBackground` after the broadcast fires (`'rates-refreshed'`), and via the `auto-dl:trigger` IPC ("Run now" button — `'manual'`). A 60s reentrancy lock + an in-flight flag coalesces overlapping triggers.

Each tick walks every subscription, reads `episodes_aired` from the existing `shikimoriAnimeDetails[malId]` cache (skips the show silently if the cache is empty — the existing detail-prefetch worker will populate it), and walks integer episodes from `lastEnqueuedEpisodeInt + 1` to `episodes_aired`. For each candidate it dedupes against `downloadedEpisodes` (both `animeId:episodeInt:translationId` and legacy `animeId:episodeInt` keys), the live `downloadManager.getEpisodeGroups()` queue, and an in-tick set; resolves the translation by preferring the most-recent entry in `downloadedEpisodes` for the same `animeId` (falling back to the global `translationType` default with any author); probes the real height via `getEmbed`; and calls `downloadManager.enqueue(...)`. `lastEnqueuedEpisodeInt` is bumped after each successful enqueue or already-downloaded/already-queued detection (never on `no-translation`, so a not-yet-uploaded episode is retried next tick).

Hard cap of `MAX_ENQUEUES_PER_TICK = 10` per worker run protects against pathological cases (e.g. a show that suddenly reports `episodes_aired = 200`). At subscribe time, `lastEnqueuedEpisodeInt` is stamped to the current `episodes_aired`, so newly-subscribed shows never backfill — they only catch episodes that air *after* the subscription click. After each tick, `auto-dl:tick-result` broadcasts `{ ranAt, reason, enqueued, skipped, errors, details }`; per-episode `auto-dl:enqueued` fires with `{ animeId, episodeInt, animeName }`. `CalendarView` shows a ↻ chip on subscribed entries (hydrated once per mount via `auto-dl:list-subscriptions`); the master toggle, "Run now" button, and subscription list live in `Settings > General > Auto-download`. Disabling the master toggle makes ticks no-ops without dropping subscriptions.

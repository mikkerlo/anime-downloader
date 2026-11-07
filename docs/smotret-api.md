# API Endpoints (smotret-anime.app)

| Endpoint | Usage |
|----------|-------|
| `GET /api/series/?query=&fields=` | Search anime |
| `GET /api/series/{id}` | Anime details |
| `GET /api/episodes/{id}` | Episode + translations (single episode) |
| `GET /api/translations/?episodeId[]=…&fields=…` | Bulk translations for many episodes in one request |
| `GET /api/translations/embed/{id}?access_token=` | Stream URLs + subtitle info |
| `GET /translations/ass/{id}?download=1` | Subtitle file download |

The `/api` base comes from `smotretApiBase()` (`src/main/lib/api-bases.ts`); an unpackaged build can point it at a stub server with `ANIME_DL_SMOTRET_API_BASE` (#567). Every request goes through `fetchWithTimeout` (`src/main/lib/net.ts`).

**Host (#684).** smotret left `.ru` in November 2026: `smotret-anime.ru`, `smotretanime.ru` and `anime-365.ru` (`LEGACY_SMOTRET_HOSTS`) answer a poster URL with a 200 `text/html` "site moved" page. Every URL the app builds starts at `smotretOrigin()` (`https://smotret-anime.app`, the address the site gives for Russia); `.co` and `.org` are live mirrors and are never rewritten. The API echoes the request host in the poster URLs it returns (`posterUrlSmall` from `.app` is on `.app`), so fresh responses carry the new host. Absolute `.ru` URLs already in the store are not migrated; `rewriteLegacySmotretUrl(url)` moves them to the same path and query on `smotretOrigin()` where they are loaded: the renderer's requests in the session's offline gate (`lib/offline-request-gate.ts`, a `redirectURL` answer), `fetchPoster` before its fetch, and `queue.json` items in `DownloadManager.loadQueue`, since a resume refetches `item.url` and Node's fetch never passes the session.

**Posters.** `fetchPoster` returns the bytes only for an ok response whose `Content-Type` is `image/*` **and** whose bytes start with a JPEG, PNG, GIF or WebP signature (`isImageBytes`, `src/main/lib/image-signature.ts`); anything else is `null`, so `cachePosterImage` writes no file. At startup `animeCacheService.purgeNonImagePosters()` (after `cleanupStale()`) deletes any `poster-cache/<id>.jpg` that is not an image and clears that entry's `posterCached`, so the next detail load fetches it again.

The embed API returns `stream[]` with direct CDN URLs (used for downloads) and `download[]` with site redirect URLs (not used, causes 403).

`SmotretApi.getEpisodesBatch(ids)` uses the bulk `/translations?episodeId[]=…` endpoint (chunked at 30 ids/request, `limit=5000`) to load an entire episode-list page in one round-trip instead of one `/episodes/{id}` call per episode — this is the cold-load fast path for the anime detail view (#155). Each translation carries a nested `episode` object, so the flat list is grouped back into `EpisodeDetail[]`. Episodes with no translations are absent from the response.

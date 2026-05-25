# API Endpoints (smotret-anime.ru)

| Endpoint | Usage |
|----------|-------|
| `GET /api/series/?query=&fields=` | Search anime |
| `GET /api/series/{id}` | Anime details |
| `GET /api/episodes/{id}` | Episode + translations (single episode) |
| `GET /api/translations/?episodeId[]=…&fields=…` | Bulk translations for many episodes in one request |
| `GET /api/translations/embed/{id}?access_token=` | Stream URLs + subtitle info |
| `GET /translations/ass/{id}?download=1` | Subtitle file download |

The embed API returns `stream[]` with direct CDN URLs (used for downloads) and `download[]` with site redirect URLs (not used, causes 403).

`SmotretApi.getEpisodesBatch(ids)` uses the bulk `/translations?episodeId[]=…` endpoint (chunked at 30 ids/request, `limit=5000`) to load an entire episode-list page in one round-trip instead of one `/episodes/{id}` call per episode — this is the cold-load fast path for the anime detail view (#155). Each translation carries a nested `episode` object, so the flat list is grouped back into `EpisodeDetail[]`. Episodes with no translations are absent from the response.

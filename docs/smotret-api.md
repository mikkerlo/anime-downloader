# API Endpoints (smotret-anime.ru)

| Endpoint | Usage |
|----------|-------|
| `GET /api/series/?query=&fields=` | Search anime |
| `GET /api/series/{id}` | Anime details |
| `GET /api/episodes/{id}` | Episode + translations |
| `GET /api/translations/embed/{id}?access_token=` | Stream URLs + subtitle info |
| `GET /translations/ass/{id}?download=1` | Subtitle file download |

The embed API returns `stream[]` with direct CDN URLs (used for downloads) and `download[]` with site redirect URLs (not used, causes 403).

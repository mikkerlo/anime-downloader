# Anime DL App — Design Document

Electron + Vue 3 + TypeScript desktop app for downloading anime from smotret-anime.ru.

This document is an index. Each subsystem lives in its own page under [`docs/`](./docs/) so it can be read and updated independently.

## Subsystems

| Topic | File |
|---|---|
| Top-level architecture, process model, full main + renderer file map | [docs/architecture.md](./docs/architecture.md) |
| Cross-component data flow: Home, Search, Navigation, Episodes, Downloads, Merge, File Management, Cleanup, Library | [docs/data-flow.md](./docs/data-flow.md) |
| IPC channel reference + broadcast subscription contract + ownership rule | [docs/ipc.md](./docs/ipc.md) |
| Shared TypeScript types | [docs/types.md](./docs/types.md) |
| `electron-store` settings schema | [docs/settings.md](./docs/settings.md) |
| Watch progress + auto-resume + Shikimori sync on watched | [docs/watch-progress.md](./docs/watch-progress.md) |
| Hot/cold storage and on-disk file layout | [docs/storage.md](./docs/storage.md) |
| Built-in video player (MSE, Anime4K, JASSUB, prefetch, episode nav) | [docs/player.md](./docs/player.md) |
| Auto-update via `electron-updater` | [docs/auto-update.md](./docs/auto-update.md) |
| Shikimori integration: OAuth, rate cache, offline queue, Friends, Calendar, Chronology, auto-download | [docs/shikimori.md](./docs/shikimori.md) |
| Watch Together (Syncplay) | [docs/syncplay.md](./docs/syncplay.md) |
| FFmpeg merge codecs and progress | [docs/ffmpeg.md](./docs/ffmpeg.md) |
| Local OP/ED skip detection (Chromaprint) | [docs/skip-detection.md](./docs/skip-detection.md) |
| smotret-anime.ru API endpoints | [docs/smotret-api.md](./docs/smotret-api.md) |
| Build + packaging | [docs/build.md](./docs/build.md) |
| Testing: runners, layers, IPC contract guard, coverage thresholds | [docs/testing.md](./docs/testing.md) |
| Renderer architecture — component layout, Pinia stores, composables, path aliases | [docs/renderer.md](./docs/renderer.md) |

For project conventions (jj workflow, commit/release flow, IPC pattern, plan template), see [CLAUDE.md](./CLAUDE.md).

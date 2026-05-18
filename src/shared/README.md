# src/shared

Code imported by **all three** process boundaries (`main`, `preload`, `renderer`)
via the `@shared` path alias.

Reserved for the cross-cutting layer introduced by the
[structure refactor epic (#84)](https://github.com/mikkerlo/anime-downloader/issues/84):

- `ipc/channels.ts` — single source of truth for IPC channel names + payload/return types
- `types/*.ts` — shared domain types

Empty for now (Phase 0 only sets up the alias and tooling); populated in Phase 1.

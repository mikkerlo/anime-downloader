# src/shared

Code imported by **all three** process boundaries (`main`, `preload`, `renderer`)
via the `@shared` path alias.

Reserved for the cross-cutting layer introduced by the
[structure refactor epic (#84)](https://github.com/mikkerlo/anime-downloader/issues/84):

- `ipc/channels.ts` — single source of truth for IPC channel names + payload/return types
- `types/*.d.ts` — shared domain types, declared as ambient globals so no call site needs an import
- `shikimori.ts` — the Shikimori origin + its image hotlink filters
- `episode-files.ts` — the episode-file extension sets and the regexes derived from them (#429)
- `storage-roots.ts` — `ROOT_KEYS`, the storage root key list read by `storage:clear-root`, `set-setting`'s denylist, `missingConfiguredRoot()` and the Storage tab (#454)

A `.d.ts` here emits no runtime values, so a shared constant needs a real `.ts`
module; a shared *type* goes in `types/` and stays ambient.

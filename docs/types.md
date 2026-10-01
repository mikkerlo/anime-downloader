# Key Types

```typescript
// Download states
type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
type MergeStatus = 'pending' | 'merging' | 'completed' | 'failed'

// What renderer receives from progress broadcasts
interface EpisodeGroup {
  translationId: number
  animeName: string
  episodeLabel: string
  quality: number
  video: DownloadProgressItem | null
  subtitle: DownloadProgressItem | null
  mergeStatus: MergeStatus
  mergePercent?: number
  mergeError?: string
}

// What gets queued for download
interface DownloadRequest {
  translationId: number
  height: number
  animeName: string
  episodeLabel: string
  episodeInt: string
  animeId: number
  translationType: string
  author: string
}

// Persisted per-episode translation info
interface EpisodeMeta {
  translationType: string
  author: string
  quality: number
  translationId: number
}
```

Full shared type definitions live in `src/shared/types/*.d.ts` (split by domain — `anime.d.ts`, `download.d.ts`, `shikimori.d.ts`, `player.d.ts`, `storage.d.ts`, `skip.d.ts`, `syncplay.d.ts`).

`storage.d.ts` also carries `EpisodeFileEntry` / `EpisodeFileType` / `EpisodeArtifactExt` (#429), the on-disk episode-artifact shape that `file:check-episodes` and `file:episodes-changed` carry. It used to be re-typed byte-identically at 11 sites across main, preload and the renderer. Its runtime counterparts — the extension lists themselves — cannot live in a `.d.ts`, which emits no values, so they are in `src/shared/episode-files.ts`; see [storage.md](storage.md#extension-sets).

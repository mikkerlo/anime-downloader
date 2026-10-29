// Rule 12's file identity on this PC (#572 §4, #584): an episode's local file
// and its `{ translationId, fileSize }`, so a drive skip entry is taken only
// for the same file. Reads `downloadedAnime` / `downloadedEpisodes` and the
// episode-file scan; never throws.

import * as fs from 'fs'
import type { FileCheckResult } from '../../lib/episode-file-scan'
import { filterScanResult } from '../../lib/episode-file-scan'
import type { EpisodeFileIdentity } from '../../lib/sync-state/skip'
import type { StorageService } from '../../store/types'

export interface LocalFilesDeps {
  store: Pick<StorageService, 'get'>
  scanEpisodeFiles(animeName: string): FileCheckResult
  sanitizeFilename(name: string): string
  displayName(anime: AnimeSearchResult): string
  statSize?(filePath: string): number | null
}

type DownloadedEpisode = { translationId?: number; author?: string }

export function createLocalFiles(deps: LocalFilesDeps): {
  localEpisodeFile(
    animeId: string,
    episodeInt: string
  ): { filePath: string; translationId: number; fileSize: number } | null
  resolveEpisodeFile(
    animeId: string,
    episodeInt: string,
    filePath: string
  ): EpisodeFileIdentity | null
} {
  const statSize =
    deps.statSize ??
    ((p: string) => {
      try {
        return fs.statSync(p).size
      } catch {
        return null
      }
    })
  const episodeOf = (animeId: string, episodeInt: string): DownloadedEpisode | undefined =>
    deps.store.get<Record<string, DownloadedEpisode> | undefined>('downloadedEpisodes')?.[
      `${animeId}:${episodeInt}`
    ]
  return {
    localEpisodeFile(animeId, episodeInt) {
      try {
        const ep = episodeOf(animeId, episodeInt)
        const anime = deps.store.get<Record<string, AnimeSearchResult> | undefined>(
          'downloadedAnime'
        )?.[animeId]
        if (!ep || typeof ep.translationId !== 'number' || !anime) return null
        const name = deps.displayName(anime)
        const files = Object.values(
          filterScanResult(deps.scanEpisodeFiles(name), name, [episodeInt], deps.sanitizeFilename)
        ).flat()
        const file = files.find((f) => f.author === ep.author) ?? files[0]
        if (!file) return null
        const fileSize = statSize(file.filePath)
        if (fileSize === null) return null
        return { filePath: file.filePath, translationId: ep.translationId, fileSize }
      } catch {
        return null
      }
    },
    resolveEpisodeFile(animeId, episodeInt, filePath) {
      const ep = episodeOf(animeId, episodeInt)
      if (!ep || typeof ep.translationId !== 'number') return null
      const fileSize = statSize(filePath)
      return fileSize === null ? null : { translationId: ep.translationId, fileSize }
    }
  }
}

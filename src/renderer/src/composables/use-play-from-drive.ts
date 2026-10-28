// Play from drive (#578): one episode of an attached Shared Library in the
// player. Resolution goes through `player:find-local-file` with the anime id,
// so a local copy still wins and the drive file is `realpath`-checked in main
// at the moment of playing. The player's episode list is the drive's, so next
// / previous resolve on the drive the same way.

import { usePlayerStore } from '../stores/player'
import { FFMPEG_MISSING_REASON, useSharedLibrariesStore } from '../stores/shared-libraries'

function translationsOf(ep: AttachedTitleEpisode): {
  id: number
  label: string
  type: string
  height: number
}[] {
  return ep.items.map((i) => ({
    id: i.translationId,
    label: i.author,
    type: i.translationType,
    height: i.quality
  }))
}

export function usePlayFromDrive(): {
  play: (
    libraryId: string,
    animeId: number,
    target: { episodeInt: string; translationId: number },
    detail?: AttachedTitleDetail | null
  ) => Promise<string | null>
} {
  const playerStore = usePlayerStore()
  const shared = useSharedLibrariesStore()

  /** Opens the player; returns why it couldn't, or null. */
  async function play(
    libraryId: string,
    animeId: number,
    target: { episodeInt: string; translationId: number },
    detail?: AttachedTitleDetail | null
  ): Promise<string | null> {
    const title = detail ?? (await window.api.sharedLibraryGetTitle(libraryId, animeId))
    if (!title) return 'This title is no longer on the drive.'
    const index = title.episodes.findIndex((e) => e.episodeInt === target.episodeInt)
    const ep = title.episodes[index]
    const item = ep?.items.find((i) => i.translationId === target.translationId)
    if (!ep || !item) return 'This episode is no longer on the drive.'
    if (item.container === 'mkv' && !(await shared.checkFfmpeg())) return FFMPEG_MISSING_REASON
    const animeName = title.anime.title
    const found = await window.api.playerFindLocalFile(
      animeName,
      ep.episodeInt,
      item.translationId,
      ep.episodeFull,
      animeId
    )
    if (!found) return "This episode's file can't be opened from the drive."
    const playerMode = (await window.api.getSetting('playerMode')) as string
    if (playerMode !== 'builtin') {
      const err = await window.api.fileOpen(found.filePath)
      return err || null
    }
    playerStore.openPlayer({
      filePath: found.filePath,
      streamUrl: '',
      subtitleContent: found.subtitleContent || '',
      animeName,
      episodeLabel: ep.episodeInt,
      availableStreams: [],
      translationId: item.translationId,
      translations: translationsOf(ep),
      downloadedTrIds: ep.items.map((i) => i.translationId),
      // `id` is the upstream episode id, which the drive doesn't carry. The
      // player fetches by it only for an episode handed no translations, and
      // every drive episode has at least one.
      allEpisodes: title.episodes.map((e) => ({
        id: 0,
        episodeInt: e.episodeInt,
        episodeFull: e.episodeFull,
        translations: translationsOf(e),
        downloadedTrIds: e.items.map((i) => i.translationId)
      })),
      episodeIndex: index,
      animeId,
      malId: title.meta?.malId ?? 0
    })
    return null
  }

  return { play }
}

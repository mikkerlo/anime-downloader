// Injection keys shared between AnimeDetailView and its detail/* sub-components.
// Phase 5 slice 5b.4 (#118). The parent provides composable instances under
// these keys so the panel components can read state + actions without each
// of them receiving a long prop list.

import type { InjectionKey } from 'vue'
import type { useShikimori } from '../../composables/use-shikimori'
import type { useSkipDetection } from '../../composables/use-skip-detection'
import type { useEpisodeList } from '../../composables/use-episode-list'
import type { useEpisodeDownloads } from '../../composables/use-episode-downloads'

export const ShikimoriKey: InjectionKey<ReturnType<typeof useShikimori>> = Symbol('shikimori')
export const SkipDetectionKey: InjectionKey<ReturnType<typeof useSkipDetection>> =
  Symbol('skipDetection')
export const EpisodeListKey: InjectionKey<ReturnType<typeof useEpisodeList>> = Symbol('episodeList')
export const EpisodeDownloadsKey: InjectionKey<ReturnType<typeof useEpisodeDownloads>> =
  Symbol('episodeDownloads')

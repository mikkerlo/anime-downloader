// The deps of Prepare for offline's steps 3 and 4 (#592), built from the app's
// services (#659). `src/main/index.ts` hands these straight to the step
// factories, and the offline scenario matrix builds the same objects over its
// own services. Every member is a closure that reads its service when a run
// calls it: the download manager is assigned in `bootstrap()`, long after the
// steps are registered, so it comes in through a getter. The other four steps'
// deps stay inline in `index.ts`.

import * as fs from 'fs'
import type { DownloadManager } from '../../download-manager'
import type { SmotretApi } from '../../smotret-api'
import type { AnimeCacheService } from '../anime-cache'
import type { ColdStorageService } from '../cold-storage'
import { animeRecordsFrom, playerRecordFrom, subscriptionNameFrom } from '../../lib/anime-record'
import type { probeDuration as probeDurationFn } from '../../lib/probe-duration'
import { cachableIdsFrom, type MetadataStepDeps } from './steps/metadata'
import type { LocalIntegrityStepDeps } from './steps/local-integrity'

type Store = { get(key: string): unknown }

export interface LocalIntegrityWiring {
  store: Store
  coldStorageService: Pick<
    ColdStorageService,
    'isAdvanced' | 'getColdStorageDir' | 'getDownloadDir' | 'missingConfiguredRoots'
  >
  getDownloadManager: () => Pick<DownloadManager, 'getActiveDownloadByPath'> | undefined
  getFfprobePath: () => string
  probeDuration: typeof probeDurationFn
  sanitizeFilename: (name: string) => string
  getDisplayName: (anime: AnimeSearchResult) => string
}

export function localIntegrityDeps(w: LocalIntegrityWiring): LocalIntegrityStepDeps {
  const { store, coldStorageService } = w
  return {
    downloadedEpisodes: () =>
      store.get('downloadedEpisodes') as Record<string, { author?: string }>,
    downloadedAnime: () => store.get('downloadedAnime') as Record<string, AnimeSearchResult>,
    animeRecords: (id) => animeRecordsFrom(store, id),
    playerRecord: (id) => playerRecordFrom(store, id),
    subscriptionName: (id) => subscriptionNameFrom(store, id),
    displayName: w.getDisplayName,
    sanitizeFilename: w.sanitizeFilename,
    roots: () => {
      const cold = coldStorageService.isAdvanced() ? coldStorageService.getColdStorageDir() : ''
      return cold
        ? [coldStorageService.getDownloadDir(), cold]
        : [coldStorageService.getDownloadDir()]
    },
    missingRoots: () => coldStorageService.missingConfiguredRoots(),
    probeDuration: (file, signal) => {
      const ffprobe = w.getFfprobePath()
      return ffprobe && fs.existsSync(ffprobe)
        ? w.probeDuration(ffprobe, file, signal)
        : Promise.resolve(null)
    },
    isActivePart: (p) => w.getDownloadManager()?.getActiveDownloadByPath(p) != null
  }
}

export interface MetadataWiring {
  store: Store
  isCachable: (animeId: number) => boolean
  smotretApi: Pick<SmotretApi, 'getAnime' | 'getEpisodesBatch'>
  animeCacheService: Pick<AnimeCacheService, 'refreshAnimeDetail' | 'updateEpisodes'>
}

export function metadataDeps(w: MetadataWiring): MetadataStepDeps {
  const { store, smotretApi, animeCacheService } = w
  return {
    cachableIds: () => cachableIdsFrom(store, w.isCachable),
    getAnime: (id) => smotretApi.getAnime(id),
    getEpisodesBatch: (ids) => smotretApi.getEpisodesBatch(ids),
    refreshAnimeDetail: (id, detail) => animeCacheService.refreshAnimeDetail(id, detail),
    updateEpisodes: (id, details) => animeCacheService.updateEpisodes(id, details)
  }
}

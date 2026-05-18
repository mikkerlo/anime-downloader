import type Store from 'electron-store'
import type { SmotretApi, EpisodeDetail, Translation } from './smotret-api'
import type { DownloadManager, DownloadRequest } from './download-manager'
import type { AutoDownloadSubscription } from './index'
import type * as shikimori from './shikimori'

export type AutoDlReason = 'startup' | 'timer' | 'rates-refreshed' | 'manual'

export interface AutoDlOutcome {
  animeId: number
  animeName: string
  episodeInt: string
  outcome:
    | 'enqueued'
    | 'no-translation'
    | 'no-episode'
    | 'already-downloaded'
    | 'already-queued'
    | 'embed-failed'
    | 'no-episodes-aired'
    | 'cap-reached'
    | 'error'
  message?: string
}

export interface AutoDlTickResult {
  ranAt: number
  reason: AutoDlReason
  enqueued: number
  skipped: number
  errors: number
  details: AutoDlOutcome[]
}

interface DownloadedEpisodeMeta {
  translationType: string
  author: string
  quality: number
  translationId: number
}

interface ShikiAnimeDetailsCacheEntry {
  details: shikimori.ShikiAnimeDetails
  fetchedAt: number
}

interface AutoDownloaderDeps {
  store: Store<Record<string, unknown>>
  smotretApi: SmotretApi
  downloadManager: DownloadManager
  broadcast: (channel: string, ...args: unknown[]) => void
  isShikimoriLoggedIn: () => boolean
  refreshShikimoriDetails: (malId: number) => Promise<shikimori.ShikiAnimeDetails | null>
}

const MAX_ENQUEUES_PER_TICK = 10
const REENTRANCY_LOCK_MS = 60_000
const TICK_INTERVAL_MS = 15 * 60 * 1000
const DETAILS_FRESHNESS_MS = 6 * 60 * 60 * 1000

let deps: AutoDownloaderDeps | null = null
let lastTickResult: AutoDlTickResult | null = null
let tickRunning = false
let lockReleaseAt = 0
let timerHandle: ReturnType<typeof setInterval> | null = null

export function initAutoDownloader(d: AutoDownloaderDeps): void {
  deps = d
}

export function startAutoDownloaderTimer(): void {
  if (timerHandle) return
  timerHandle = setInterval(() => {
    void runAutoDownloadTick('timer').catch((err) => {
      console.warn('[auto-dl] timer tick failed:', err)
    })
  }, TICK_INTERVAL_MS)
}

export function getAutoDownloaderStatus(): {
  lastResult: AutoDlTickResult | null
  locked: boolean
  enabled: boolean
} {
  const enabled = deps ? Boolean(deps.store.get('autoDownloadEnabled')) : false
  return {
    lastResult: lastTickResult,
    locked: tickRunning || Date.now() < lockReleaseAt,
    enabled
  }
}

export function listSubscriptions(): AutoDownloadSubscription[] {
  if (!deps) return []
  const map = deps.store.get('autoDownloadSubscriptions') as Record<
    string,
    AutoDownloadSubscription
  >
  return Object.values(map)
}

export function getSubscription(animeId: number): AutoDownloadSubscription | null {
  if (!deps) return null
  const map = deps.store.get('autoDownloadSubscriptions') as Record<
    string,
    AutoDownloadSubscription
  >
  return map[String(animeId)] ?? null
}

export async function setSubscription(
  animeId: number,
  enabled: boolean,
  meta?: { malId: number; animeName: string }
): Promise<AutoDownloadSubscription | null> {
  if (!deps) return null
  const map = {
    ...(deps.store.get('autoDownloadSubscriptions') as Record<string, AutoDownloadSubscription>)
  }
  const key = String(animeId)
  if (!enabled) {
    if (key in map) {
      delete map[key]
      deps.store.set('autoDownloadSubscriptions', map)
    }
    return null
  }
  if (!meta) {
    const existing = map[key]
    if (!existing) return null
    return existing
  }
  // Stamp lastEnqueuedEpisodeInt to the current episodes_aired so we never backfill.
  // If the cache is missing or stale, inline-refresh first — otherwise an empty cache
  // would leave the stamp at 0 and the next tick would download the entire show.
  const cache = deps.store.get('shikimoriAnimeDetails') as Record<
    string,
    ShikiAnimeDetailsCacheEntry
  >
  let cacheEntry = cache[String(meta.malId)]
  const cacheAge = cacheEntry ? Date.now() - cacheEntry.fetchedAt : Infinity
  if (!cacheEntry || cacheAge > DETAILS_FRESHNESS_MS) {
    const fresh = await deps.refreshShikimoriDetails(meta.malId)
    if (fresh) {
      cacheEntry = { details: fresh, fetchedAt: Date.now() }
    }
  }
  const aired = cacheEntry?.details?.episodes_aired ?? 0
  if (aired <= 0) {
    // Refuse rather than silently arming a backfill. Caller surfaces this to the user.
    return null
  }
  const sub: AutoDownloadSubscription = {
    animeId,
    malId: meta.malId,
    animeName: meta.animeName,
    subscribedAt: Date.now(),
    lastEnqueuedEpisodeInt: aired,
    lastCheckedAt: 0,
    initialEpisodesAired: aired
  }
  map[key] = sub
  deps.store.set('autoDownloadSubscriptions', map)
  return sub
}

function pickTranslation(
  episode: EpisodeDetail,
  preferred: { type: string; author?: string } | null,
  globalType: string
): Translation | null {
  const active = episode.translations.filter((t) => t.isActive === 1)
  if (active.length === 0) return null

  const byHeightDesc = (a: Translation, b: Translation): number => b.height - a.height

  if (preferred) {
    if (preferred.author) {
      const exact = active
        .filter((t) => t.type === preferred.type && t.authorsSummary === preferred.author)
        .sort(byHeightDesc)
      if (exact[0]) return exact[0]
    }
    const sameType = active.filter((t) => t.type === preferred.type).sort(byHeightDesc)
    if (sameType[0]) return sameType[0]
  }

  const globalMatch = active.filter((t) => t.type === globalType).sort(byHeightDesc)
  if (globalMatch[0]) return globalMatch[0]
  return null
}

function mostRecentDownloadedTranslation(
  store: Store<Record<string, unknown>>,
  animeId: number
): { type: string; author: string } | null {
  const all = store.get('downloadedEpisodes') as Record<string, DownloadedEpisodeMeta>
  const prefix = `${animeId}:`
  for (const [key, meta] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue
    if (!meta?.translationType) continue
    return { type: meta.translationType, author: meta.author ?? '' }
  }
  return null
}

function isAlreadyDownloaded(
  store: Store<Record<string, unknown>>,
  animeId: number,
  episodeInt: string
): boolean {
  const all = store.get('downloadedEpisodes') as Record<string, DownloadedEpisodeMeta>
  const newPrefix = `${animeId}:${episodeInt}:`
  const legacyKey = `${animeId}:${episodeInt}`
  if (legacyKey in all) return true
  for (const key of Object.keys(all)) {
    if (key.startsWith(newPrefix)) return true
  }
  return false
}

function isAlreadyQueued(
  downloadManager: DownloadManager,
  animeId: number,
  episodeInt: string
): boolean {
  const groups = downloadManager.getEpisodeGroups()
  return groups.some((g) => g.animeId === animeId && g.episodeInt === episodeInt)
}

async function probeHeight(api: SmotretApi, tr: Translation): Promise<number> {
  try {
    const embed = await api.getEmbed(tr.id)
    const streams = embed.stream || []
    if (streams.length > 0) {
      return streams.reduce((a, b) => (a.height > b.height ? a : b)).height
    }
  } catch {
    // fall through
  }
  return tr.height
}

export async function runAutoDownloadTick(reason: AutoDlReason): Promise<AutoDlTickResult> {
  const result: AutoDlTickResult = {
    ranAt: Date.now(),
    reason,
    enqueued: 0,
    skipped: 0,
    errors: 0,
    details: []
  }

  if (!deps) return result

  const now = Date.now()
  if (tickRunning || now < lockReleaseAt) {
    return result
  }
  tickRunning = true
  lockReleaseAt = now + REENTRANCY_LOCK_MS

  try {
    if (!deps.store.get('autoDownloadEnabled')) {
      lastTickResult = result
      deps.broadcast('auto-dl:tick-result', result)
      return result
    }

    const map = {
      ...(deps.store.get('autoDownloadSubscriptions') as Record<string, AutoDownloadSubscription>)
    }
    const subscriptions = Object.values(map)
    if (subscriptions.length === 0) {
      lastTickResult = result
      deps.broadcast('auto-dl:tick-result', result)
      return result
    }

    if (!deps.isShikimoriLoggedIn()) {
      lastTickResult = result
      deps.broadcast('auto-dl:tick-result', result)
      return result
    }

    const globalTranslationType = (deps.store.get('translationType') as string) || 'subRu'

    const enqueuedThisTick = new Set<string>()
    let mapDirty = false

    for (const sub of subscriptions) {
      sub.lastCheckedAt = Date.now()
      mapDirty = true

      const detailsCache = deps.store.get('shikimoriAnimeDetails') as Record<
        string,
        ShikiAnimeDetailsCacheEntry
      >
      let cacheEntry = detailsCache[String(sub.malId)]
      const cacheAge = cacheEntry ? Date.now() - cacheEntry.fetchedAt : Infinity
      if (cacheAge > DETAILS_FRESHNESS_MS) {
        const fresh = await deps.refreshShikimoriDetails(sub.malId)
        if (fresh) {
          cacheEntry = { details: fresh, fetchedAt: Date.now() }
        }
      }
      const aired = cacheEntry?.details?.episodes_aired ?? 0
      const totalEpisodes = cacheEntry?.details?.episodes ?? 0
      if (aired <= 0) {
        result.details.push({
          animeId: sub.animeId,
          animeName: sub.animeName,
          episodeInt: '',
          outcome: 'no-episodes-aired'
        })
        continue
      }

      let candidate = sub.lastEnqueuedEpisodeInt + 1
      while (candidate <= aired) {
        if (totalEpisodes > 0 && candidate > totalEpisodes) break
        if (result.enqueued >= MAX_ENQUEUES_PER_TICK) {
          result.details.push({
            animeId: sub.animeId,
            animeName: sub.animeName,
            episodeInt: String(candidate),
            outcome: 'cap-reached'
          })
          break
        }

        const episodeInt = String(candidate)
        const dedupKey = `${sub.animeId}:${episodeInt}`
        if (enqueuedThisTick.has(dedupKey)) {
          candidate += 1
          continue
        }

        if (isAlreadyDownloaded(deps.store, sub.animeId, episodeInt)) {
          result.details.push({
            animeId: sub.animeId,
            animeName: sub.animeName,
            episodeInt,
            outcome: 'already-downloaded'
          })
          sub.lastEnqueuedEpisodeInt = candidate
          candidate += 1
          continue
        }

        if (isAlreadyQueued(deps.downloadManager, sub.animeId, episodeInt)) {
          result.details.push({
            animeId: sub.animeId,
            animeName: sub.animeName,
            episodeInt,
            outcome: 'already-queued'
          })
          sub.lastEnqueuedEpisodeInt = candidate
          candidate += 1
          continue
        }

        try {
          const animeData = await deps.smotretApi.getAnime(sub.animeId)
          const epSummary = animeData.data.episodes.find((e) => e.episodeInt === episodeInt)
          if (!epSummary) {
            result.details.push({
              animeId: sub.animeId,
              animeName: sub.animeName,
              episodeInt,
              outcome: 'no-episode'
            })
            result.skipped += 1
            break
          }

          const epDetail = (await deps.smotretApi.getEpisode(epSummary.id)).data
          const preferred = mostRecentDownloadedTranslation(deps.store, sub.animeId)
          const translation = pickTranslation(epDetail, preferred, globalTranslationType)
          if (!translation) {
            result.details.push({
              animeId: sub.animeId,
              animeName: sub.animeName,
              episodeInt,
              outcome: 'no-translation'
            })
            result.skipped += 1
            break
          }

          const height = await probeHeight(deps.smotretApi, translation)
          const request: DownloadRequest = {
            translationId: translation.id,
            height,
            animeName: sub.animeName,
            episodeLabel: epDetail.episodeFull,
            episodeInt,
            animeId: sub.animeId,
            translationType: translation.type,
            author: translation.authorsSummary
          }

          await deps.downloadManager.enqueue([request])
          enqueuedThisTick.add(dedupKey)
          sub.lastEnqueuedEpisodeInt = candidate
          result.enqueued += 1
          result.details.push({
            animeId: sub.animeId,
            animeName: sub.animeName,
            episodeInt,
            outcome: 'enqueued'
          })
          deps.broadcast('auto-dl:enqueued', {
            animeId: sub.animeId,
            episodeInt,
            animeName: sub.animeName
          })
        } catch (err) {
          result.errors += 1
          result.details.push({
            animeId: sub.animeId,
            animeName: sub.animeName,
            episodeInt,
            outcome: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
          break
        }

        candidate += 1
      }

      map[String(sub.animeId)] = sub
    }

    if (mapDirty) {
      deps.store.set('autoDownloadSubscriptions', map)
    }

    lastTickResult = result
    deps.broadcast('auto-dl:tick-result', result)
    return result
  } finally {
    tickRunning = false
    // Keep lockReleaseAt as the cooldown deadline so manual triggers actually wait REENTRANCY_LOCK_MS.
  }
}

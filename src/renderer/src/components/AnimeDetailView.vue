<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { formatBytes, formatSpeed, formatEta, getAnimeName as _getAnimeName, sanitizeFilename } from '../utils'

const props = defineProps<{
  animeId: number
  initialPrefs?: { translationType?: string; author?: string }
}>()

const emit = defineEmits<{
  back: []
  prefsChanged: [animeId: number, translationType: string, author: string]
  playFile: [filePath: string, streamUrl: string, subtitleContent: string, animeName: string, episodeLabel: string, availableStreams: { height: number; url: string }[], translationId: number, translations: { id: number; label: string; type: string; height: number }[], downloadedTrIds: number[], allEpisodes: { episodeInt: string; episodeFull: string; translations: { id: number; label: string; type: string; height: number }[]; downloadedTrIds: number[] }[], episodeIndex: number, animeId: number, malId: number]
}>()

const anime = ref<AnimeDetail | null>(null)
const episodes = ref<Map<number, EpisodeDetail>>(new Map())
const loading = ref(true)
const loadingEpisodes = ref(false)
const translationType = ref('subRu')
const selectedAuthor = ref('')

const dataSource = ref<'api' | 'cache' | null>(null)
const isOffline = computed(() => dataSource.value === 'cache')

const episodeOverrides = ref<Map<number, number>>(new Map()) // episodeId -> translationId
const realQuality = ref<Map<number, number>>(new Map()) // translationId -> actual height from embed

// Shikimori state
const shikiUser = ref<ShikiUser | null>(null)
const shikiRate = ref<ShikiUserRate | null>(null)
const shikiStatus = ref<ShikiUserRateStatus>('planned')
const shikiEpisodes = ref(0)
const shikiScore = ref(0)
const shikiLoading = ref(false)
const shikiSaving = ref(false)
const shikiError = ref('')
const offlineQueueLength = ref(0)

// Friends state
const friendsRates = ref<ShikiFriendRate[]>([])
const friendsLoading = ref(false)
const friendsCollapsed = ref(false)
const shikiUserChecked = ref(false)

const friendsSummary = computed(() => {
  const counts = new Map<string, number>()
  for (const r of friendsRates.value) {
    counts.set(r.status, (counts.get(r.status) || 0) + 1)
  }
  const labels: Record<string, string> = {
    watching: 'watching', completed: 'completed', planned: 'planned',
    on_hold: 'on hold', dropped: 'dropped', rewatching: 'rewatching'
  }
  return [...counts.entries()]
    .map(([status, count]) => `${count} ${labels[status] || status}`)
    .join(' \u00b7 ')
})

const playerMode = ref<'system' | 'builtin'>('system')

const TRANSLATION_TYPES = [
  { value: 'subRu', label: 'Russian Subtitles', short: 'RU SUB', color: '#6ab04c' },
  { value: 'subEn', label: 'English Subtitles', short: 'EN SUB', color: '#3498db' },
  { value: 'voiceRu', label: 'Russian Voice', short: 'RU DUB', color: '#e94560' },
  { value: 'voiceEn', label: 'English Voice', short: 'EN DUB', color: '#9b59b6' },
  { value: 'raw', label: 'RAW', short: 'RAW', color: '#6a6a8a' }
]

const filteredEpisodes = computed(() => {
  if (!anime.value) return []

  const allActive = anime.value.episodes.filter(ep => ep.isActive === 1 && ep.episodeType !== 'preview')

  if (!anime.value.type) return allActive

  const matchedEpisodes = anime.value.episodes.filter(
    ep => ep.isActive === 1 && ep.episodeType === anime.value!.type
  )

  if (matchedEpisodes.length === 0) return allActive
  if (anime.value.numberOfEpisodes && matchedEpisodes.length !== anime.value.numberOfEpisodes) return allActive

  return matchedEpisodes
})

const PAGE_SIZE = 30
const currentPage = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(filteredEpisodes.value.length / PAGE_SIZE)))
const isPaginated = computed(() => filteredEpisodes.value.length > PAGE_SIZE)
const pagedEpisodes = computed(() => {
  if (!isPaginated.value) return filteredEpisodes.value
  const start = currentPage.value * PAGE_SIZE
  return filteredEpisodes.value.slice(start, start + PAGE_SIZE)
})

// Count unique episodes per translation type
const translationTypeCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const ep of episodes.value.values()) {
    const typesInEp = new Set<string>()
    for (const tr of ep.translations) {
      if (tr.isActive === 1) typesInEp.add(tr.type)
    }
    for (const t of typesInEp) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return counts
})

const availableAuthors = computed(() => {
  const counts = new Map<string, number>()
  for (const ep of episodes.value.values()) {
    // Track unique authors per episode (count each author once per episode)
    const seen = new Set<string>()
    for (const tr of ep.translations) {
      if (tr.type === translationType.value && tr.isActive === 1 && !seen.has(tr.authorsSummary)) {
        seen.add(tr.authorsSummary)
        counts.set(tr.authorsSummary, (counts.get(tr.authorsSummary) || 0) + 1)
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

interface EpisodeRow {
  episode: EpisodeSummary
  allTranslations: Translation[]
  selectedTr: Translation | null
  isLocked: boolean
  lockSource: 'downloaded' | 'queued' | null
  downloadedTrIds: Set<number>
}

// For each author+type combo, keep only the best quality translation
function bestPerAuthor(translations: Translation[]): Translation[] {
  const best = new Map<string, Translation>()
  for (const tr of translations) {
    const key = `${tr.type}:${tr.authorsSummary}`
    const existing = best.get(key)
    if (!existing || getRealHeight(tr) > getRealHeight(existing)) {
      best.set(key, tr)
    }
  }
  return [...best.values()]
}

const episodeRows = computed((): EpisodeRow[] => {
  return pagedEpisodes.value.map(ep => {
    const detail = episodes.value.get(ep.id)
    const rawTranslations = detail
      ? detail.translations.filter(tr => tr.isActive === 1)
      : []
    const allTranslations = bestPerAuthor(rawTranslations)

    // Sort: global type first, then by quality desc, then by type order
    const sorted = [...allTranslations].sort((a, b) => {
      const aMatch = a.type === translationType.value ? 0 : 1
      const bMatch = b.type === translationType.value ? 0 : 1
      if (aMatch !== bMatch) return aMatch - bMatch
      const aH = getRealHeight(a), bH = getRealHeight(b)
      if (aH !== bH) return bH - aH
      const typeOrder = TRANSLATION_TYPES.map(t => t.value)
      return typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)
    })

    const metas = episodeMeta.value[ep.episodeInt] || []
    const group = downloadGroups.value.get(ep.episodeFull)

    // Build set of downloaded translation IDs from metadata + files on disk
    const downloadedTrIds = new Set<number>()
    for (const m of metas) {
      if (m.translationId) downloadedTrIds.add(m.translationId)
    }

    let selectedTr: Translation | null = null
    let isLocked = false
    let lockSource: 'downloaded' | 'queued' | null = null

    // Priority 1: In download queue (active) — lock the row
    if (group && group.video && !['completed', 'cancelled', 'failed'].includes(group.video.status)) {
      selectedTr = sorted.find(tr => tr.id === group.translationId) || null
      if (selectedTr) {
        isLocked = true
        lockSource = 'queued'
      }
    }

    // Priority 2: User per-episode override
    if (!isLocked && episodeOverrides.value.has(ep.id)) {
      selectedTr = sorted.find(tr => tr.id === episodeOverrides.value.get(ep.id)) || null
    }

    // Priority 3: Global default (same type + author)
    if (!isLocked && !selectedTr) {
      const typeFiltered = sorted.filter(tr => tr.type === translationType.value)
      selectedTr = typeFiltered.find(tr => tr.authorsSummary === selectedAuthor.value)
        || typeFiltered[0] || null
    }

    return { episode: ep, allTranslations: sorted, selectedTr, isLocked, lockSource, downloadedTrIds }
  })
})

function onEpisodeTranslationChange(episodeId: number, translationId: number): void {
  episodeOverrides.value = new Map(episodeOverrides.value.set(episodeId, translationId))
}

function onMouseBack(e: MouseEvent): void {
  if (e.button === 3) {
    e.preventDefault()
    emit('back')
  }
}

async function loadShikimoriData(): Promise<void> {
  try {
    shikiUser.value = await window.api.shikimoriGetUser()
  } catch (err) {
    console.error('Failed to load Shikimori user:', err)
  } finally {
    shikiUserChecked.value = true
  }
  if (!shikiUser.value || !anime.value?.myAnimeListId) return

  shikiLoading.value = true
  friendsLoading.value = true

  // Load rate and friends in parallel, neither blocks the other
  const ratePromise = window.api.shikimoriGetRate(anime.value.myAnimeListId)
    .then(rate => {
      shikiRate.value = rate
      if (rate) {
        shikiStatus.value = rate.status
        shikiEpisodes.value = rate.episodes
        shikiScore.value = rate.score
      }
    })
    .catch(err => console.error('Failed to load Shikimori rate:', err))
    .finally(() => { shikiLoading.value = false })

  const friendsPromise = window.api.shikimoriGetFriendsRates(anime.value.myAnimeListId)
    .then(rates => { friendsRates.value = rates })
    .catch(err => console.error('Failed to load friends rates:', err))
    .finally(() => { friendsLoading.value = false })

  await Promise.all([ratePromise, friendsPromise])
}

onMounted(async () => {
  window.addEventListener('mouseup', onMouseBack)
  playerMode.value = ((await window.api.getSetting('playerMode')) as string as typeof playerMode.value) || 'system'
  if (props.initialPrefs?.translationType) {
    translationType.value = props.initialPrefs.translationType
  } else {
    translationType.value = (await window.api.getSetting('translationType') as string) || 'subRu'
  }

  try {
    const res = await window.api.getAnime(props.animeId)
    anime.value = res.data
    dataSource.value = res.source
    await loadPageEpisodes()
    await checkFileStatus()
    // If the user hasn't explicitly picked a translation type on this anime
    // before, and something is already downloaded, prefer the (type, author)
    // of the downloaded file(s) over the global settings default.
    if (!props.initialPrefs?.translationType) {
      const counts = new Map<string, number>()
      for (const metaArr of Object.values(episodeMeta.value)) {
        for (const m of metaArr) {
          const key = `${m.translationType}\u0000${m.author}`
          counts.set(key, (counts.get(key) || 0) + 1)
        }
      }
      if (counts.size > 0) {
        let bestKey = ''
        let bestCount = 0
        for (const [key, count] of counts) {
          if (count > bestCount) { bestKey = key; bestCount = count }
        }
        if (bestKey) {
          const [bestType, bestAuthor] = bestKey.split('\u0000')
          translationType.value = bestType
          // Only override selectedAuthor if the downloaded author is still
          // offered for this type — the translation may have been deactivated
          // or removed upstream, which would leave the <select> blank.
          if (bestAuthor && availableAuthors.value.some(([a]) => a === bestAuthor)) {
            selectedAuthor.value = bestAuthor
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to load anime detail view:', err)
  } finally {
    loading.value = false
  }

  // If served from cache, try a background refresh
  if (dataSource.value === 'cache') {
    backgroundRefresh()
  }

  // Subscribe to download progress
  const queue = await window.api.downloadGetQueue()
  updateDownloadGroups(queue)
  window.api.onDownloadProgress(updateDownloadGroups)

  // Subscribe to background file rescan updates
  window.api.onFileEpisodesChanged((animeName, data) => {
    if (anime.value && animeName === getAnimeName()) {
      const episodeInts = filteredEpisodes.value.map(ep => ep.episodeInt)
      const baseMap = new Map<string, string>()
      for (const epInt of episodeInts) {
        const padded = epInt.padStart(2, '0')
        const base = sanitizeFilename(`${animeName} - ${padded}`)
        baseMap.set(base, epInt)
      }
      const filtered: typeof fileStatus.value = {}
      for (const [base, files] of Object.entries(data)) {
        const epInt = baseMap.get(base)
        if (epInt) filtered[epInt] = files
      }
      fileStatus.value = filtered
    }
  })

  // Load Shikimori data (non-blocking — don't hold up the episode list)
  loadShikimoriData()

  // Load watch progress for episode indicators
  loadWatchProgress()
  window.addEventListener('watch-progress-updated', loadWatchProgress)

  window.api.onShikimoriRateUpdated((entry) => {
    if (anime.value?.myAnimeListId && entry.rate.target_id === anime.value.myAnimeListId) {
      shikiRate.value = {
        id: entry.rate.id,
        score: entry.rate.score,
        status: entry.rate.status,
        episodes: entry.rate.episodes,
        target_id: entry.rate.target_id,
        target_type: 'Anime'
      }
      shikiStatus.value = entry.rate.status
      shikiEpisodes.value = entry.rate.episodes
      shikiScore.value = entry.rate.score
    }
  })

  window.api.onShikimoriRatesRefreshed((entries) => {
    if (!anime.value?.myAnimeListId) return
    const match = entries.find((e) => e.rate.target_id === anime.value!.myAnimeListId)
    if (match) {
      shikiRate.value = {
        id: match.rate.id,
        score: match.rate.score,
        status: match.rate.status,
        episodes: match.rate.episodes,
        target_id: match.rate.target_id,
        target_type: 'Anime'
      }
      shikiStatus.value = match.rate.status
      shikiEpisodes.value = match.rate.episodes
      shikiScore.value = match.rate.score
    }
  })

  window.api.shikimoriGetOfflineQueueLength().then((n) => {
    offlineQueueLength.value = n
  })
  window.api.onShikimoriOfflineQueueChanged((data) => {
    offlineQueueLength.value = data.length
  })
})

onUnmounted(() => {
  window.removeEventListener('mouseup', onMouseBack)
  window.removeEventListener('watch-progress-updated', loadWatchProgress)
  window.api.offDownloadProgress()
  window.api.offFileEpisodesChanged()
  window.api.offShikimoriRateUpdated()
  window.api.offShikimoriRatesRefreshed()
  window.api.offShikimoriOfflineQueueChanged()
})

const SHIKI_STATUSES: { value: ShikiUserRateStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'watching', label: 'Watching' },
  { value: 'rewatching', label: 'Rewatching' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'dropped', label: 'Dropped' }
]

watch(shikiEpisodes, (eps) => {
  if (anime.value?.numberOfEpisodes && eps >= anime.value.numberOfEpisodes) {
    shikiStatus.value = 'completed'
  } else if (eps > 0) {
    if (shikiStatus.value === 'completed') {
      shikiStatus.value = 'rewatching'
    } else if (shikiStatus.value === 'planned') {
      shikiStatus.value = 'watching'
    }
  }
})

async function shikiSave(): Promise<void> {
  if (!anime.value?.myAnimeListId) return
  shikiSaving.value = true
  shikiError.value = ''
  try {
    const rate = await window.api.shikimoriUpdateRate(
      anime.value.myAnimeListId,
      shikiEpisodes.value,
      shikiStatus.value,
      shikiScore.value
    )
    shikiRate.value = rate
  } catch (err) {
    shikiError.value = String(err)
  } finally {
    shikiSaving.value = false
  }
}

async function loadPageEpisodes(): Promise<void> {
  if (!anime.value || pagedEpisodes.value.length === 0) return
  loadingEpisodes.value = true

  const batch = 5
  const toLoad = pagedEpisodes.value.filter(ep => !episodes.value.has(ep.id))

  for (let i = 0; i < toLoad.length; i += batch) {
    const chunk = toLoad.slice(i, i + batch)
    const fetched = await Promise.all(
      chunk.map(ep => window.api.getEpisode(ep.id, props.animeId).then(r => r.data))
    )
    const updated = new Map(episodes.value)
    for (const ep of fetched) {
      updated.set(ep.id, ep)
    }
    episodes.value = updated
  }

  if (availableAuthors.value.length > 0 && !selectedAuthor.value) {
    if (props.initialPrefs?.author && availableAuthors.value.some(([a]) => a === props.initialPrefs!.author)) {
      selectedAuthor.value = props.initialPrefs.author
    } else {
      selectedAuthor.value = availableAuthors.value[0][0]
    }
  }

  loadingEpisodes.value = false
  probeSelectedQualities()
}

async function goToPage(page: number): Promise<void> {
  currentPage.value = page
  await loadPageEpisodes()
  await checkFileStatus()
}

let probeGeneration = 0

async function probeSelectedQualities(): Promise<void> {
  const gen = ++probeGeneration

  // Build translation metadata lookup
  const trMeta = new Map<number, Translation>()
  for (const row of episodeRows.value) {
    for (const tr of row.allTranslations) {
      trMeta.set(tr.id, tr)
    }
  }

  // Phase 1: probe only currently selected translations
  const selectedIds: number[] = []
  for (const row of episodeRows.value) {
    if (row.selectedTr && !realQuality.value.has(row.selectedTr.id)) {
      selectedIds.push(row.selectedTr.id)
    }
  }

  if (selectedIds.length > 0) {
    const updated = await probeIds(selectedIds, trMeta, gen)
    if (updated) realQuality.value = updated
  }

  if (gen !== probeGeneration) return

  // Phase 2: full scan only if enabled in settings and needed
  const bgProbeEnabled = await window.api.getSetting('backgroundQualityProbe') as boolean
  if (!bgProbeEnabled) return

  const episodeCount = filteredEpisodes.value.length
  const needsFullScan = await window.api.probeFullScanNeeded(props.animeId, episodeCount)
  if (!needsFullScan || gen !== probeGeneration) return

  const remainingIds: number[] = []
  for (const id of trMeta.keys()) {
    if (!realQuality.value.has(id)) {
      remainingIds.push(id)
    }
  }

  if (remainingIds.length > 0) {
    const updated = await probeIds(remainingIds, trMeta, gen, true)
    if (updated) realQuality.value = updated
  }

  if (gen === probeGeneration) {
    window.api.probeFullScanDone(props.animeId, episodeCount)
  }
}

async function probeIds(
  ids: number[],
  trMeta: Map<number, Translation>,
  gen: number,
  throttle = false
): Promise<Map<number, number> | null> {
  const batchSize = throttle ? 2 : 5
  const collected = new Map<number, number>()
  for (let i = 0; i < ids.length; i += batchSize) {
    if (gen !== probeGeneration) return null
    if (throttle) await new Promise(r => setTimeout(r, 100))
    const batch = ids.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(id => window.api.probeEmbedQuality(id, props.animeId).then(h => ({ id, height: h })))
    )
    for (const r of results) {
      if (r.height !== null) {
        collected.set(r.id, r.height)
        const tr = trMeta.get(r.id)
        if (tr && tr.height !== r.height) {
          console.warn(`[quality-mismatch] Translation ${r.id} (${tr.authorsSummary}, ${tr.type}): reported=${tr.height}p, actual=${r.height}p`)
          window.api.reportQualityMismatch({
            translationId: r.id, author: tr.authorsSummary, type: tr.type,
            reported: tr.height, actual: r.height
          })
        }
      }
    }
  }
  if (gen !== probeGeneration) return null
  const merged = new Map(realQuality.value)
  for (const [id, h] of collected) {
    merged.set(id, h)
  }
  return merged
}

function getRealHeight(tr: Translation): number {
  return realQuality.value.get(tr.id) ?? tr.height
}

function qualityLabel(height: number): string {
  if (height >= 1080) return '1080p'
  if (height >= 720) return '720p'
  if (height >= 480) return '480p'
  return `${height}p`
}

const fileStatus = ref<Record<string, { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]>>({})
const watchProgress = ref<Record<string, WatchProgressEntry>>({})

async function loadWatchProgress(): Promise<void> {
  try {
    watchProgress.value = await window.api.watchProgressGetAll(props.animeId)
  } catch (err) {
    console.error('Failed to load watch progress:', err)
  }
}

function episodeProgressPercent(episodeInt: string): number {
  const entry = watchProgress.value[episodeInt]
  if (!entry || !entry.duration) return 0
  const pct = Math.min(100, Math.round((entry.position / entry.duration) * 100))
  return pct < 2 ? 0 : pct
}

function isEpisodeWatched(episodeInt: string): boolean {
  return !!watchProgress.value[episodeInt]?.watched
}

const continueTarget = computed((): EpisodeSummary | null => {
  const eps = filteredEpisodes.value
  if (eps.length === 0) return null

  // 1) If Shikimori reports N completed episodes, jump to episode N+1.
  // Shikimori is authoritative — ignore local saved positions for earlier episodes.
  if (shikiUser.value && shikiEpisodes.value > 0 && shikiEpisodes.value < eps.length) {
    return eps[shikiEpisodes.value]
  }

  // 2) Prefer an episode with an unfinished saved position (most recent).
  let bestResume: EpisodeSummary | null = null
  let bestUpdatedAt = 0
  for (const ep of eps) {
    const entry = watchProgress.value[ep.episodeInt]
    if (!entry || entry.watched) continue
    if (!entry.position || !entry.duration) continue
    if (entry.updatedAt > bestUpdatedAt) {
      bestUpdatedAt = entry.updatedAt
      bestResume = ep
    }
  }
  if (bestResume) return bestResume

  // 3) First episode after the last locally-watched one.
  let lastWatchedIdx = -1
  for (let i = 0; i < eps.length; i++) {
    if (isEpisodeWatched(eps[i].episodeInt)) lastWatchedIdx = i
  }
  const nextIdx = lastWatchedIdx + 1
  if (nextIdx < eps.length) return eps[nextIdx]

  // 4) Everything watched — fall back to the last episode.
  return eps[eps.length - 1]
})

const continueReady = computed((): boolean => {
  if (!anime.value || filteredEpisodes.value.length === 0) return false
  if (loadingEpisodes.value) return false
  if (anime.value.myAnimeListId && !shikiUserChecked.value) return false
  if (shikiUser.value && shikiLoading.value) return false
  return continueTarget.value !== null
})

const continueLabel = computed((): string => {
  const target = continueTarget.value
  if (!target) return 'Continue'
  const entry = watchProgress.value[target.episodeInt]
  const verb = entry && entry.position > 0 && !entry.watched ? 'Resume' : 'Continue'
  return `${verb} · Ep ${target.episodeInt}`
})

async function continueWatching(): Promise<void> {
  const target = continueTarget.value
  if (!target) return

  const eps = filteredEpisodes.value
  const targetIdx = eps.findIndex(e => e.episodeInt === target.episodeInt)
  if (targetIdx < 0) return

  const targetPage = isPaginated.value ? Math.floor(targetIdx / PAGE_SIZE) : 0
  if (targetPage !== currentPage.value) {
    await goToPage(targetPage)
  }
  await nextTick()

  const row = episodeRows.value.find(r => r.episode.episodeInt === target.episodeInt)
  if (!row || !row.selectedTr) return

  if (selectedTrHasFile(row)) {
    await openFile(row)
  } else {
    await playStream(row)
  }
}

const episodeMeta = ref<Record<string, EpisodeMeta[]>>({})
const downloadGroups = ref<Map<string, EpisodeGroup>>(new Map())
const downloading = ref(false)
const errorMessage = ref('')

function getAnimeName(): string {
  if (!anime.value) return ''
  return _getAnimeName(anime.value)
}

async function checkToken(): Promise<boolean> {
  const token = await window.api.getSetting('token') as string
  if (!token) {
    errorMessage.value = 'API token is required for downloads. Set it in Settings.'
    setTimeout(() => { errorMessage.value = '' }, 5000)
    return false
  }
  return true
}

async function downloadAll(): Promise<void> {
  if (!anime.value) return
  if (!(await checkToken())) return

  const name = getAnimeName()
  const requests: DownloadRequest[] = []

  for (const row of episodeRows.value) {
    if (row.selectedTr && !row.isLocked && !selectedTrHasFile(row)) {
      requests.push({
        translationId: row.selectedTr.id,
        height: getRealHeight(row.selectedTr),
        animeName: name,
        episodeLabel: row.episode.episodeFull,
        episodeInt: row.episode.episodeInt,
        animeId: anime.value!.id,
        translationType: row.selectedTr.type,
        author: row.selectedTr.authorsSummary
      })
    }
  }

  if (requests.length === 0) return
  downloading.value = true
  try {
    await window.api.downloadedAnimeAdd(JSON.parse(JSON.stringify(anime.value)))
    await window.api.downloadEnqueue(requests)
  } finally {
    downloading.value = false
  }
}

async function downloadEpisode(row: EpisodeRow): Promise<void> {
  if (!row.selectedTr || !anime.value) return
  if (!(await checkToken())) return

  await window.api.downloadedAnimeAdd(JSON.parse(JSON.stringify(anime.value)))
  await window.api.downloadEnqueue([{
    translationId: row.selectedTr.id,
    height: getRealHeight(row.selectedTr),
    animeName: getAnimeName(),
    episodeLabel: row.episode.episodeFull,
    episodeInt: row.episode.episodeInt,
    animeId: anime.value!.id,
    translationType: row.selectedTr.type,
    author: row.selectedTr.authorsSummary
  }])
}

function downloadGroupChanged(a: EpisodeGroup | undefined, b: EpisodeGroup | undefined): boolean {
  if (!a && !b) return false
  if (!a || !b) return true
  if (a.mergeStatus !== b.mergeStatus || a.mergePercent !== b.mergePercent) return true
  const av = a.video, bv = b.video
  if (!av && !bv) return false
  if (!av || !bv) return true
  return av.status !== bv.status || av.bytesReceived !== bv.bytesReceived || av.totalBytes !== bv.totalBytes || av.speed !== bv.speed
}

function updateDownloadGroups(groups: EpisodeGroup[]): void {
  const prev = downloadGroups.value
  const map = new Map<string, EpisodeGroup>()
  let newlyCompleted = false
  let changed = false
  for (const g of groups) {
    if (g.animeName === getAnimeName()) {
      map.set(g.episodeLabel, g)
      const old = prev.get(g.episodeLabel)
      if (downloadGroupChanged(old, g)) changed = true
      if (g.mergeStatus === 'completed' && old?.mergeStatus !== 'completed') {
        newlyCompleted = true
      }
      if (g.video?.status === 'completed' && old?.video?.status !== 'completed') {
        newlyCompleted = true
      }
    }
  }
  // Also detect removals (prev had entries that new map doesn't)
  if (prev.size !== map.size) changed = true
  if (!changed) return
  downloadGroups.value = map
  if (newlyCompleted) {
    checkFileStatus()
  }
}

function dlProgress(item: DownloadProgressItem | null): number {
  if (!item || item.totalBytes <= 0) return 0
  return (item.bytesReceived / item.totalBytes) * 100
}


function getGroup(episodeFull: string): EpisodeGroup | undefined {
  return downloadGroups.value.get(episodeFull)
}

watch([translationType, selectedAuthor], () => {
  episodeOverrides.value = new Map()
  emit('prefsChanged', props.animeId, translationType.value, selectedAuthor.value)
  probeSelectedQualities()
})

async function backgroundRefresh(): Promise<void> {
  try {
    const res = await window.api.getAnime(props.animeId)
    if (res.source === 'api') {
      anime.value = res.data
      dataSource.value = 'api'
      await loadPageEpisodes()
    }
  } catch {
    // Stay on cached data
  }
}

const posterSrc = ref('')
const posterFallbackAttempted = ref(false)

watch(anime, async (val) => {
  if (val) {
    posterSrc.value = val.posterUrl || val.posterUrlSmall
    posterFallbackAttempted.value = false
  }
}, { immediate: true })

async function onPosterError(): Promise<void> {
  if (posterFallbackAttempted.value) return
  posterFallbackAttempted.value = true
  const cached = await window.api.getCachedPoster(props.animeId)
  if (cached) posterSrc.value = cached
}

async function checkFileStatus(): Promise<void> {
  if (!anime.value || filteredEpisodes.value.length === 0) return
  const name = getAnimeName()
  const episodeInts = filteredEpisodes.value.map(ep => ep.episodeInt)
  fileStatus.value = await window.api.fileCheckEpisodes(name, episodeInts)
  episodeMeta.value = await window.api.downloadedEpisodesGet(props.animeId)
}

function buildTranslationList(row: EpisodeRow | undefined): { id: number; label: string; type: string; height: number }[] {
  if (!row) return []
  return row.allTranslations.map(tr => ({
    id: tr.id,
    label: tr.authorsSummary,
    type: tr.type,
    height: getRealHeight(tr)
  }))
}

function buildAllEpisodes(): { episodeInt: string; episodeFull: string; translations: { id: number; label: string; type: string; height: number }[]; downloadedTrIds: number[] }[] {
  return filteredEpisodes.value.map(ep => {
    const detail = episodes.value.get(ep.id)
    const translations = detail
      ? detail.translations.filter(t => t.isActive === 1).map(t => ({ id: t.id, label: t.authorsSummary, type: t.type, height: getRealHeight(t) }))
      : []
    const metas = episodeMeta.value[ep.episodeInt] || []
    const downloadedTrIds = metas.map(m => m.translationId)
    return { episodeInt: ep.episodeInt, episodeFull: ep.episodeFull, translations, downloadedTrIds }
  })
}

function getFileForTranslation(episodeInt: string, translationId: number | undefined): { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string } | null {
  const files = fileStatus.value[episodeInt]
  if (!files || files.length === 0) return null
  // Find file matching the translation's author via metadata
  if (translationId) {
    const metas = episodeMeta.value[episodeInt] || []
    const meta = metas.find(m => m.translationId === translationId)
    if (meta) {
      // Match by author tag
      const authorTag = sanitizeFilename(meta.author)
      const match = files.find(f => f.author === authorTag)
      if (match) return match
      // Legacy file (no author tag) — only match if it's the sole metadata entry
      if (metas.length === 1 && files.length === 1 && !files[0].author) {
        return files[0]
      }
    }
  }
  // No specific match found
  return null
}

function hasAnyFile(episodeInt: string): boolean {
  const files = fileStatus.value[episodeInt]
  return !!files && files.length > 0
}

function selectedTrHasFile(row: EpisodeRow): boolean {
  if (!row.selectedTr) return false
  return !!getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
}

async function openFile(row: EpisodeRow): Promise<void> {
  if (!row.selectedTr) return
  const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
  if (!info) return

  if (playerMode.value === 'builtin') {
    const name = anime.value ? getAnimeName() : ''
    const localSubs = await window.api.playerGetLocalSubtitles(info.filePath)
    const allEps = buildAllEpisodes()
    const epIdx = allEps.findIndex(e => e.episodeInt === row.episode.episodeInt)
    emit('playFile', info.filePath, '', localSubs || '', name, row.episode.episodeInt, [], row.selectedTr.id, buildTranslationList(row), [...row.downloadedTrIds], allEps, epIdx, props.animeId, anime.value?.myAnimeListId ?? 0)
  } else {
    const result = await window.api.fileOpen(info.filePath)
    if (result) {
      errorMessage.value = result
      await checkFileStatus()
    }
  }
}

async function playStream(row: EpisodeRow): Promise<void> {
  if (!row.selectedTr) return
  const name = anime.value ? getAnimeName() : ''
  const result = await window.api.playerGetStreamUrl(row.selectedTr.id, getRealHeight(row.selectedTr))
  if (result) {
    const allEps = buildAllEpisodes()
    const epIdx = allEps.findIndex(e => e.episodeInt === row.episode.episodeInt)
    emit('playFile', '', result.streamUrl, result.subtitleContent || '', name, row.episode.episodeInt, result.availableStreams, row.selectedTr.id, buildTranslationList(row), [...row.downloadedTrIds], allEps, epIdx, props.animeId, anime.value?.myAnimeListId ?? 0)
  }
}

function showInFolder(row: EpisodeRow): void {
  if (!row.selectedTr) return
  const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
  if (!info) return
  window.api.fileShowInFolder(info.filePath)
}

async function deleteFile(row: EpisodeRow): Promise<void> {
  if (!row.selectedTr) return
  const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
  if (!info) return
  await window.api.fileDeleteEpisode(getAnimeName(), row.episode.episodeInt, props.animeId, row.selectedTr.id)
  await checkFileStatus()
}

async function cancelEpisodeDownload(episodeLabel: string): Promise<void> {
  await window.api.downloadCancelByEpisode(getAnimeName(), episodeLabel)
}

const hasActiveDownloads = computed(() => downloadGroups.value.size > 0)

async function cancelAllDownloads(): Promise<void> {
  await window.api.downloadCancelByEpisode(getAnimeName())
}

function translationTypeLabel(type: string): string {
  const t = TRANSLATION_TYPES.find(tt => tt.value === type)
  return t ? t.label : type
}

function typeChip(type: string): { short: string; color: string } {
  const t = TRANSLATION_TYPES.find(tt => tt.value === type)
  return t ? { short: t.short, color: t.color } : { short: type, color: '#6a6a8a' }
}
</script>

<template>
  <main class="detail-view">
    <header class="topbar">
      <button class="back-btn" @click="emit('back')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        Back
      </button>
    </header>

    <div v-if="loading" class="status-text">Loading...</div>

    <div v-else-if="anime" class="body">
      <div class="anime-header">
        <div class="poster-col">
          <img :src="posterSrc" :alt="anime.title" class="detail-poster" @error="onPosterError" />
          <button
            class="continue-btn"
            :disabled="!continueReady"
            :title="continueReady ? 'Continue watching' : 'Loading...'"
            @click="continueWatching"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M8 5v14l11-7z" />
            </svg>
            {{ continueLabel }}
          </button>
        </div>
        <div class="anime-info">
          <h2 class="anime-title">
            {{ getAnimeName() }}
            <span v-if="isOffline" class="offline-badge">OFFLINE</span>
          </h2>
          <div class="anime-meta">
            <span v-if="anime.typeTitle">{{ anime.typeTitle }}</span>
            <span v-if="anime.year"> · {{ anime.year }}</span>
            <span v-if="anime.numberOfEpisodes"> · {{ anime.numberOfEpisodes }} episodes</span>
          </div>
          <div v-if="anime.genres?.length" class="genres">
            <span v-for="g in anime.genres" :key="g.id" class="genre-tag">{{ g.title }}</span>
          </div>
          <p v-if="anime.descriptions?.length" class="description">{{ anime.descriptions[0].value }}</p>
        </div>
      </div>

      <div v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)" class="shiki-panel">
        <template v-if="shikiUser">
          <div class="shiki-header">
            <span class="shiki-label">Shikimori</span>
            <a :href="`https://shikimori.one/animes/${anime.myAnimeListId}`" target="_blank" class="shiki-link">
              Open on Shikimori
            </a>
          </div>
          <div v-if="shikiLoading" class="shiki-loading">Loading...</div>
          <div v-else class="shiki-controls">
            <select v-model="shikiStatus" class="select shiki-select">
              <option v-for="s in SHIKI_STATUSES" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
            <div class="shiki-episodes">
              <span>Episodes:</span>
              <input
                v-model.number="shikiEpisodes"
                type="number"
                min="0"
                :max="anime.numberOfEpisodes || undefined"
                class="shiki-ep-input"
              />
              <span v-if="anime.numberOfEpisodes" class="shiki-ep-total">/ {{ anime.numberOfEpisodes }}</span>
            </div>
            <div class="shiki-episodes">
              <span>Score:</span>
              <select v-model.number="shikiScore" class="select shiki-score-select">
                <option :value="0">—</option>
                <option v-for="n in 10" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <button class="shiki-save-btn" :disabled="shikiSaving" @click="shikiSave">
              {{ shikiSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
          <div v-if="shikiError" class="shiki-error">{{ shikiError }}</div>
          <div v-if="offlineQueueLength > 0" class="shiki-offline">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M12 5a7 7 0 016.95 6.155A4 4 0 0118 19H9m-3-2a4 4 0 01-1.9-7.516" />
            </svg>
            Working offline — {{ offlineQueueLength }} change{{ offlineQueueLength > 1 ? 's' : '' }} queued
          </div>
        </template>
        <div v-else class="shiki-loading">Loading...</div>
      </div>

      <div v-if="anime.myAnimeListId && (shikiUser || !shikiUserChecked)" class="friends-panel">
        <div class="friends-header" @click="friendsCollapsed = !friendsCollapsed">
          <div class="friends-header-left">
            <svg
              class="friends-chevron"
              :class="{ collapsed: friendsCollapsed }"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/>
            </svg>
            <span class="friends-label">Friends</span>
          </div>
          <span v-if="!friendsLoading && friendsRates.length > 0" class="friends-summary">{{ friendsSummary }}</span>
          <span v-if="friendsLoading" class="friends-summary">Loading...</span>
        </div>
        <div v-if="!friendsCollapsed" class="friends-body">
          <div v-if="friendsLoading" class="friends-loading">Loading friends...</div>
          <div v-else-if="friendsRates.length === 0" class="friends-empty">None of your friends have watched this anime</div>
          <div v-else class="friends-list">
            <div v-for="friend in friendsRates" :key="friend.nickname" class="friend-row">
              <img :src="friend.avatar" class="friend-avatar" />
              <span class="friend-name">{{ friend.nickname }}</span>
              <span class="friend-status-badge" :class="'status-' + friend.status">
                {{ { planned: 'Planned', watching: 'Watching', rewatching: 'Rewatching', completed: 'Completed', on_hold: 'On Hold', dropped: 'Dropped' }[friend.status] }}
              </span>
              <span class="friend-score">{{ friend.score > 0 ? friend.score + '/10' : '—' }}</span>
              <span class="friend-episodes">{{ friend.episodes > 0 ? 'ep ' + friend.episodes + (anime.numberOfEpisodes ? '/' + anime.numberOfEpisodes : '') : '' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="controls">
        <div class="control-group">
          <label>Translation type</label>
          <select v-model="translationType" class="select">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">{{ t.label }} ({{ translationTypeCounts.get(t.value) || 0 }}/{{ filteredEpisodes.length }})</option>
          </select>
        </div>
        <div class="control-group">
          <label>Author</label>
          <select v-model="selectedAuthor" class="select">
            <option v-for="[author, count] in availableAuthors" :key="author" :value="author">
              {{ author }} ({{ count }}/{{ filteredEpisodes.length }})
            </option>
          </select>
        </div>
        <button class="download-btn" @click="downloadAll" :disabled="episodeRows.every(r => !r.selectedTr) || downloading">
          {{ downloading ? 'Enqueuing...' : isPaginated ? `Download Page ${currentPage + 1}` : 'Download All' }}
        </button>
        <button v-if="hasActiveDownloads" class="cancel-all-btn" @click="cancelAllDownloads">
          Cancel All
        </button>
      </div>

      <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>

      <div v-if="loadingEpisodes" class="status-text">Loading episodes...</div>

      <div v-if="isPaginated" class="pagination">
        <button class="page-btn" :disabled="currentPage === 0" @click="goToPage(currentPage - 1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <button v-for="p in totalPages" :key="p - 1"
          class="page-btn" :class="{ active: currentPage === p - 1 }"
          @click="goToPage(p - 1)">
          {{ p }}
        </button>
        <button class="page-btn" :disabled="currentPage === totalPages - 1" @click="goToPage(currentPage + 1)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
        <span class="page-info">{{ filteredEpisodes.length }} episodes</span>
      </div>

      <div class="episode-list">
        <div v-for="row in episodeRows" :key="row.episode.id" class="episode-row">
          <span class="ep-name">{{ row.episode.episodeFull }}</span>
          <template v-if="row.isLocked">
            <span class="ep-author locked">
              {{ row.selectedTr?.authorsSummary || 'Unknown' }}
              <span class="lock-label">Queued</span>
            </span>
          </template>
          <template v-else-if="row.allTranslations.length > 0">
            <select
              class="ep-select"
              :value="row.selectedTr?.id || ''"
              @change="onEpisodeTranslationChange(row.episode.id, Number(($event.target as HTMLSelectElement).value))"
            >
              <!-- Show selected type first, then the rest -->
              <template v-for="type in [TRANSLATION_TYPES.find(t => t.value === translationType)!, ...TRANSLATION_TYPES.filter(t => t.value !== translationType)]" :key="type.value">
                <optgroup v-if="row.allTranslations.some(tr => tr.type === type.value)"
                          :label="type.label">
                  <option v-for="tr in row.allTranslations.filter(t => t.type === type.value).sort((a, b) => getRealHeight(b) - getRealHeight(a))"
                          :key="tr.id" :value="tr.id">
                    {{ row.downloadedTrIds.has(tr.id) ? '⬇ ' : '' }}{{ tr.authorsSummary }} ({{ qualityLabel(getRealHeight(tr)) }})
                  </option>
                </optgroup>
              </template>
            </select>
          </template>
          <span v-else class="ep-missing">No translation</span>
          <!-- Download / merge status -->
          <div v-if="getGroup(row.episode.episodeFull)?.mergeStatus === 'merging'" class="ep-dl-status merging">
            Merging {{ getGroup(row.episode.episodeFull)?.mergePercent != null ? getGroup(row.episode.episodeFull)?.mergePercent + '%' : '...' }}
          </div>
          <div v-else-if="getGroup(row.episode.episodeFull)?.mergeStatus === 'failed'" class="ep-dl-status merge-failed">
            Merge failed
          </div>
          <div v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'downloading'" class="ep-dl-status">
            <div class="ep-progress-wrap">
              <div class="ep-progress-bar" :style="{ width: dlProgress(getGroup(row.episode.episodeFull)!.video) + '%' }"></div>
            </div>
            <span class="ep-dl-text">{{ formatSpeed(getGroup(row.episode.episodeFull)!.video!.speed) }}</span>
            <span class="ep-dl-text">ETA {{ formatEta(getGroup(row.episode.episodeFull)!.video!) }}</span>
          </div>
          <div v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'queued'" class="ep-dl-status queued">
            Queued
          </div>
          <div v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'paused'" class="ep-dl-status paused">
            Paused ({{ Math.round(dlProgress(getGroup(row.episode.episodeFull)!.video)) }}%)
          </div>
          <div v-else-if="getGroup(row.episode.episodeFull)?.video?.status === 'failed'" class="ep-dl-status failed">
            Failed
          </div>
          <div class="ep-right">
            <span v-if="isEpisodeWatched(row.episode.episodeInt)" class="watched-badge" title="Watched">✓</span>
            <span
              v-else-if="episodeProgressPercent(row.episode.episodeInt) > 0"
              class="watch-progress-badge"
              :title="`Watched ${episodeProgressPercent(row.episode.episodeInt)}%`"
            >
              {{ episodeProgressPercent(row.episode.episodeInt) }}%
            </span>
            <span v-if="row.selectedTr" class="type-chip" :style="{ backgroundColor: typeChip(row.selectedTr.type).color + '22', color: typeChip(row.selectedTr.type).color }">{{ typeChip(row.selectedTr.type).short }}</span>
            <span v-if="row.selectedTr" class="quality-badge" :class="{ hd: getRealHeight(row.selectedTr) >= 1080 }">{{ qualityLabel(getRealHeight(row.selectedTr)) }}</span>
            <template v-if="selectedTrHasFile(row)">
              <span class="file-type-badge">{{ getFileForTranslation(row.episode.episodeInt, row.selectedTr?.id)?.type.toUpperCase() }}</span>
            </template>
            <template v-else-if="hasAnyFile(row.episode.episodeInt)">
              <span class="file-type-badge other-dl">⬇</span>
            </template>
          </div>
          <div class="ep-links">
            <template v-if="selectedTrHasFile(row)">
              <button class="link-btn open" @click="openFile(row)" title="Open file">Open</button>
              <button class="link-btn folder" @click="showInFolder(row)" title="Show in folder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2 7.5V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-6.5l-2-2.5H4a2 2 0 00-2 2z"/>
                </svg>
              </button>
              <button class="link-btn delete" @click="deleteFile(row)" title="Delete file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </template>
            <button v-if="getGroup(row.episode.episodeFull) && (!['completed','cancelled'].includes(getGroup(row.episode.episodeFull)?.video?.status || '') || getGroup(row.episode.episodeFull)?.mergeStatus === 'merging')" class="link-btn cancel" @click="cancelEpisodeDownload(row.episode.episodeFull)" title="Cancel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
            <button v-if="playerMode === 'builtin' && row.selectedTr && !selectedTrHasFile(row)" class="link-btn play" @click="playStream(row)" title="Play (stream)">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
            <button v-if="row.selectedTr && !row.isLocked && !selectedTrHasFile(row)" class="link-btn dl" @click="downloadEpisode(row)" title="Download this episode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2 19.5h20M12 2v14m0 0l-4-4m4 4l4-4"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.detail-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  padding: 12px 24px;
  border-bottom: 1px solid #0f3460;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #e94560;
  font-size: 0.9rem;
  cursor: pointer;
  padding: 4px 0;
}

.back-btn:hover {
  color: #ff6b81;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.anime-header {
  display: flex;
  gap: 24px;
  margin-bottom: 24px;
}

.poster-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}

.detail-poster {
  width: 200px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
}

.continue-btn {
  width: 200px;
  padding: 10px 14px;
  background: #e94560;
  border: none;
  border-radius: 8px;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.continue-btn:hover:not(:disabled) {
  background: #d63651;
}

.continue-btn:disabled {
  background: #2a2a4a;
  color: #6a6a8a;
  cursor: not-allowed;
}

.anime-info {
  flex: 1;
  min-width: 0;
}

.anime-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: #e0e0e0;
  margin-bottom: 6px;
}

.offline-badge {
  display: inline-block;
  padding: 2px 8px;
  background-color: rgba(243, 156, 18, 0.15);
  border: 1px solid #f39c12;
  border-radius: 4px;
  color: #f39c12;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin-left: 10px;
  vertical-align: middle;
}

.anime-meta {
  color: #6a6a8a;
  font-size: 0.9rem;
  margin-bottom: 10px;
}

.genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.genre-tag {
  background-color: #0f3460;
  color: #a0a0b8;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.75rem;
}

.description {
  color: #8a8aa8;
  font-size: 0.85rem;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}

.controls {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.control-group label {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.select {
  padding: 8px 12px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 0.85rem;
  outline: none;
  min-width: 200px;
}

.select:focus {
  border-color: #e94560;
}

.download-btn {
  padding: 8px 20px;
  background-color: #6ab04c;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.download-btn:hover {
  background-color: #5a9a3c;
}

.download-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #a0a0b8;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}

.page-btn:hover:not(:disabled) {
  border-color: #e94560;
  color: #e0e0e0;
}

.page-btn.active {
  background-color: #e94560;
  border-color: #e94560;
  color: white;
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-info {
  margin-left: 8px;
  color: #6a6a8a;
  font-size: 0.8rem;
}

.cancel-all-btn {
  padding: 8px 20px;
  background-color: #e94560;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.cancel-all-btn:hover {
  background-color: #d63851;
}

.error-banner {
  padding: 10px 16px;
  background-color: rgba(233, 69, 96, 0.15);
  border: 1px solid #e94560;
  border-radius: 8px;
  color: #e94560;
  font-size: 0.85rem;
  margin-bottom: 16px;
}

.episode-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.episode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  background-color: #16213e;
  border-radius: 6px;
}

.ep-name {
  font-size: 0.9rem;
  color: #e0e0e0;
  min-width: 100px;
}

.ep-author {
  flex: 1;
  font-size: 0.8rem;
  color: #6a6a8a;
}

.ep-author.locked {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lock-label {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: #0f3460;
  color: #3498db;
  flex-shrink: 0;
  height: 20px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.ep-select {
  padding: 4px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.8rem;
  outline: none;
  min-width: 150px;
  max-width: 300px;
  flex: 1;
}

.ep-select:focus {
  border-color: #e94560;
}

.ep-missing {
  flex: 1;
  font-size: 0.8rem;
  color: #e94560;
  opacity: 0.6;
}

.ep-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.type-chip, .quality-badge, .file-type-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 700;
  flex-shrink: 0;
  line-height: 1;
  height: 20px;
  display: inline-flex;
  align-items: center;
}

.type-chip {
  letter-spacing: 0.3px;
}

.watched-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background-color: rgba(106, 176, 76, 0.2);
  color: #6ab04c;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.watch-progress-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: rgba(233, 69, 96, 0.15);
  color: #e94560;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  height: 20px;
  flex-shrink: 0;
}

.quality-badge {
  background-color: #0f3460;
  color: #6a6a8a;
}

.quality-badge.hd {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.ep-links {
  display: flex;
  gap: 6px;
}

.link-btn {
  padding: 4px 12px;
  background-color: #0f3460;
  border-radius: 4px;
  color: #e94560;
  font-size: 0.75rem;
  text-decoration: none;
  font-weight: 600;
  transition: background-color 0.15s;
}

.link-btn:hover {
  background-color: #1a4a7a;
}

.link-btn.play {
  color: #e94560;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.dl {
  color: #3498db;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.open {
  color: #6ab04c;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.folder {
  color: #f0932b;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.delete {
  color: #e94560;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.cancel {
  color: #f39c12;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.meta-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 600;
  background-color: #0f3460;
  color: #6a6a8a;
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ep-dl-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: #3498db;
  min-width: 120px;
  flex-shrink: 0;
}

.ep-dl-status.queued { color: #6a6a8a; }
.ep-dl-status.paused { color: #f39c12; }
.ep-dl-status.failed { color: #e94560; }
.ep-dl-status.merging { color: #f39c12; font-weight: 600; }
.ep-dl-status.merge-failed { color: #e94560; }

.ep-progress-wrap {
  flex: 1;
  height: 4px;
  background-color: #0f3460;
  border-radius: 2px;
  overflow: hidden;
  min-width: 50px;
}

.ep-progress-bar {
  height: 100%;
  background-color: #3498db;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.ep-dl-text {
  font-size: 0.65rem;
  color: #6a6a8a;
  white-space: nowrap;
}

.file-type-badge {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.file-type-badge.other-dl {
  background-color: #0f3460;
  color: #3498db;
  font-size: 0.7rem;
}

.status-text {
  text-align: center;
  color: #4a4a6a;
  font-size: 1.1rem;
  padding-top: 100px;
}

.shiki-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.shiki-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.shiki-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.shiki-link {
  font-size: 0.8rem;
  color: #3498db;
  text-decoration: none;
}

.shiki-link:hover {
  text-decoration: underline;
}

.shiki-loading {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.shiki-controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.shiki-select {
  min-width: 130px;
}

.shiki-episodes {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #a0a0b8;
}

.shiki-ep-input {
  width: 60px;
  padding: 6px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  text-align: center;
}

.shiki-ep-input:focus {
  outline: none;
  border-color: #e94560;
}

.shiki-ep-total {
  color: #6a6a8a;
}

.shiki-score-select {
  width: 60px;
}

.shiki-save-btn {
  padding: 6px 16px;
  background-color: #0f3460;
  border: none;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.shiki-save-btn:hover {
  background-color: #1a4a7a;
}

.shiki-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.shiki-error {
  margin-top: 8px;
  font-size: 0.8rem;
  color: #e94560;
}

.shiki-offline {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 0.78rem;
  color: #f0a75f;
  background: rgba(240, 167, 95, 0.12);
  border: 1px solid rgba(240, 167, 95, 0.3);
  border-radius: 4px;
}

.friends-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.friends-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.friends-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.friends-chevron {
  color: #a0a0b8;
  transition: transform 0.15s;
}

.friends-chevron.collapsed {
  transform: rotate(-90deg);
}

.friends-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.friends-summary {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.friends-body {
  margin-top: 10px;
}

.friends-loading,
.friends-empty {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.friends-list {
  display: grid;
  grid-template-columns: 24px minmax(80px, auto) auto auto auto;
  gap: 8px 12px;
  align-items: center;
  font-size: 0.85rem;
}

.friend-row {
  display: contents;
}

.friend-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.friend-name {
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.friend-status-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.75rem;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.status-watching { background-color: #27ae601a; color: #6ab04c; }
.status-completed { background-color: #3498db1a; color: #3498db; }
.status-planned { background-color: #9b59b61a; color: #9b59b6; }
.status-on_hold { background-color: #f39c121a; color: #f39c12; }
.status-dropped { background-color: #e945601a; color: #e94560; }
.status-rewatching { background-color: #1abc9c1a; color: #1abc9c; }

.friend-score {
  color: #f39c12;
  font-size: 0.8rem;
  text-align: right;
  white-space: nowrap;
}

.friend-episodes {
  color: #6a6a8a;
  font-size: 0.8rem;
  white-space: nowrap;
}
</style>

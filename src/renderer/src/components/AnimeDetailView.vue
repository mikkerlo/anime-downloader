<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { formatBytes, formatSpeed, formatEta, getAnimeName as _getAnimeName } from '../utils'

const props = defineProps<{
  animeId: number
  initialPrefs?: { translationType?: string; author?: string }
}>()

const emit = defineEmits<{
  back: []
  prefsChanged: [animeId: number, translationType: string, author: string]
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

const TRANSLATION_TYPES = [
  { value: 'subRu', label: 'Russian Subtitles', short: 'RU SUB', color: '#6ab04c' },
  { value: 'subEn', label: 'English Subtitles', short: 'EN SUB', color: '#3498db' },
  { value: 'voiceRu', label: 'Russian Voice', short: 'RU DUB', color: '#e94560' },
  { value: 'voiceEn', label: 'English Voice', short: 'EN DUB', color: '#9b59b6' },
  { value: 'raw', label: 'RAW', short: 'RAW', color: '#6a6a8a' }
]

const tvEpisodes = computed(() => {
  if (!anime.value) return []
  return anime.value.episodes.filter(ep => ep.episodeType === anime.value!.type && ep.isActive === 1)
})

const PAGE_SIZE = 30
const currentPage = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(tvEpisodes.value.length / PAGE_SIZE)))
const isPaginated = computed(() => tvEpisodes.value.length > PAGE_SIZE)
const pagedEpisodes = computed(() => {
  if (!isPaginated.value) return tvEpisodes.value
  const start = currentPage.value * PAGE_SIZE
  return tvEpisodes.value.slice(start, start + PAGE_SIZE)
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

    const meta = episodeMeta.value[ep.episodeInt]
    const group = downloadGroups.value.get(ep.episodeFull)

    let selectedTr: Translation | null = null
    let isLocked = false
    let lockSource: 'downloaded' | 'queued' | null = null

    // Priority 1: Downloaded file on disk
    if (fileStatus.value[ep.episodeInt] && meta) {
      selectedTr = sorted.find(tr => tr.id === meta.translationId) || null
      if (selectedTr) {
        isLocked = true
        lockSource = 'downloaded'
      }
    }

    // Priority 2: In download queue (active)
    if (!isLocked && group && group.video && !['completed', 'cancelled', 'failed'].includes(group.video.status)) {
      selectedTr = sorted.find(tr => tr.id === group.translationId) || null
      if (selectedTr) {
        isLocked = true
        lockSource = 'queued'
      }
    }

    // Priority 3: User per-episode override
    if (!isLocked && episodeOverrides.value.has(ep.id)) {
      selectedTr = sorted.find(tr => tr.id === episodeOverrides.value.get(ep.id)) || null
    }

    // Priority 4: Global default (same type + author)
    if (!isLocked && !selectedTr) {
      const typeFiltered = sorted.filter(tr => tr.type === translationType.value)
      selectedTr = typeFiltered.find(tr => tr.authorsSummary === selectedAuthor.value)
        || typeFiltered[0] || null
    }

    return { episode: ep, allTranslations: sorted, selectedTr, isLocked, lockSource }
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

onMounted(async () => {
  window.addEventListener('mouseup', onMouseBack)
  if (props.initialPrefs?.translationType) {
    translationType.value = props.initialPrefs.translationType
  } else {
    translationType.value = (await window.api.getSetting('translationType') as string) || 'subRu'
  }

  try {
    const res = await window.api.getAnime(props.animeId)
    anime.value = res.data
    dataSource.value = res.source
  } catch (err) {
    console.error('Failed to load anime:', err)
  } finally {
    loading.value = false
  }

  await loadPageEpisodes()
  await checkFileStatus()

  // If served from cache, try a background refresh
  if (dataSource.value === 'cache') {
    backgroundRefresh()
  }

  // Subscribe to download progress
  const queue = await window.api.downloadGetQueue()
  updateDownloadGroups(queue)
  window.api.onDownloadProgress(updateDownloadGroups)

  // Load Shikimori data
  shikiUser.value = await window.api.shikimoriGetUser()
  if (shikiUser.value && anime.value?.myAnimeListId) {
    shikiLoading.value = true
    try {
      const rate = await window.api.shikimoriGetRate(anime.value.myAnimeListId)
      shikiRate.value = rate
      if (rate) {
        shikiStatus.value = rate.status
        shikiEpisodes.value = rate.episodes
        shikiScore.value = rate.score
      }
    } catch (err) {
      console.error('Failed to load Shikimori rate:', err)
    } finally {
      shikiLoading.value = false
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('mouseup', onMouseBack)
  window.api.offDownloadProgress()
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

async function probeSelectedQualities(): Promise<void> {
  // Build a lookup of translation metadata for mismatch logging
  const trMeta = new Map<number, Translation>()
  for (const row of episodeRows.value) {
    for (const tr of row.allTranslations) {
      trMeta.set(tr.id, tr)
    }
  }

  // Collect unique translation IDs to probe
  const toProbe = new Set<number>()
  for (const id of trMeta.keys()) {
    if (!realQuality.value.has(id)) {
      toProbe.add(id)
    }
  }

  // Probe in batches of 5
  const ids = [...toProbe]
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5)
    const results = await Promise.all(
      batch.map(id => window.api.probeEmbedQuality(id, props.animeId).then(h => ({ id, height: h })))
    )
    const updated = new Map(realQuality.value)
    for (const r of results) {
      if (r.height !== null) {
        updated.set(r.id, r.height)
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
    realQuality.value = updated
  }
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

const fileStatus = ref<Record<string, { type: 'mkv' | 'mp4'; filePath: string }>>({})
const episodeMeta = ref<Record<string, EpisodeMeta>>({})
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
    if (row.selectedTr && !row.isLocked) {
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

function updateDownloadGroups(groups: EpisodeGroup[]): void {
  const prev = downloadGroups.value
  const map = new Map<string, EpisodeGroup>()
  let newlyCompleted = false
  for (const g of groups) {
    if (g.animeName === getAnimeName()) {
      map.set(g.episodeLabel, g)
      const old = prev.get(g.episodeLabel)
      if (g.mergeStatus === 'completed' && old?.mergeStatus !== 'completed') {
        newlyCompleted = true
      }
      if (g.video?.status === 'completed' && old?.video?.status !== 'completed') {
        newlyCompleted = true
      }
    }
  }
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
  if (!anime.value || tvEpisodes.value.length === 0) return
  const name = getAnimeName()
  const episodeInts = tvEpisodes.value.map(ep => ep.episodeInt)
  fileStatus.value = await window.api.fileCheckEpisodes(name, episodeInts)
  episodeMeta.value = await window.api.downloadedEpisodesGet(props.animeId)
}

async function openFile(episodeInt: string): Promise<void> {
  const info = fileStatus.value[episodeInt]
  if (!info) return
  await window.api.fileOpen(info.filePath)
}

function showInFolder(episodeInt: string): void {
  const info = fileStatus.value[episodeInt]
  if (!info) return
  window.api.fileShowInFolder(info.filePath)
}

async function deleteFile(episodeInt: string): Promise<void> {
  const info = fileStatus.value[episodeInt]
  if (!info) return
  // Clear override so it reverts to global default
  const ep = tvEpisodes.value.find(e => e.episodeInt === episodeInt)
  if (ep) {
    episodeOverrides.value.delete(ep.id)
    episodeOverrides.value = new Map(episodeOverrides.value)
  }
  await window.api.fileDeleteEpisode(getAnimeName(), episodeInt, props.animeId)
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
        <img :src="posterSrc" :alt="anime.title" class="detail-poster" @error="onPosterError" />
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

      <div v-if="shikiUser && anime.myAnimeListId" class="shiki-panel">
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
      </div>

      <div class="controls">
        <div class="control-group">
          <label>Translation type</label>
          <select v-model="translationType" class="select">
            <option v-for="t in TRANSLATION_TYPES" :key="t.value" :value="t.value">{{ t.label }} ({{ translationTypeCounts.get(t.value) || 0 }}/{{ tvEpisodes.length }})</option>
          </select>
        </div>
        <div class="control-group">
          <label>Author</label>
          <select v-model="selectedAuthor" class="select">
            <option v-for="[author, count] in availableAuthors" :key="author" :value="author">
              {{ author }} ({{ count }}/{{ tvEpisodes.length }})
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
        <span class="page-info">{{ tvEpisodes.length }} episodes</span>
      </div>

      <div class="episode-list">
        <div v-for="row in episodeRows" :key="row.episode.id" class="episode-row">
          <span class="ep-name">{{ row.episode.episodeFull }}</span>
          <template v-if="row.isLocked">
            <span class="ep-author locked">
              {{ row.selectedTr?.authorsSummary || 'Unknown' }}
              <span class="lock-label">{{ row.lockSource === 'downloaded' ? 'Downloaded' : 'Queued' }}</span>
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
                    {{ tr.authorsSummary }} ({{ qualityLabel(getRealHeight(tr)) }})
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
            <span v-if="row.selectedTr" class="type-chip" :style="{ backgroundColor: typeChip(row.selectedTr.type).color + '22', color: typeChip(row.selectedTr.type).color }">{{ typeChip(row.selectedTr.type).short }}</span>
            <span v-if="row.selectedTr" class="quality-badge" :class="{ hd: getRealHeight(row.selectedTr) >= 1080 }">{{ qualityLabel(getRealHeight(row.selectedTr)) }}</span>
            <template v-if="fileStatus[row.episode.episodeInt]">
              <span class="file-type-badge">{{ fileStatus[row.episode.episodeInt].type.toUpperCase() }}</span>
            </template>
          </div>
          <div class="ep-links">
            <template v-if="fileStatus[row.episode.episodeInt]">
              <button class="link-btn open" @click="openFile(row.episode.episodeInt)" title="Open file">Open</button>
              <button class="link-btn folder" @click="showInFolder(row.episode.episodeInt)" title="Show in folder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2 7.5V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-6.5l-2-2.5H4a2 2 0 00-2 2z"/>
                </svg>
              </button>
              <button class="link-btn delete" @click="deleteFile(row.episode.episodeInt)" title="Delete file">
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
            <button v-if="row.selectedTr && !row.isLocked" class="link-btn dl" @click="downloadEpisode(row)" title="Download this episode">
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

.detail-poster {
  width: 200px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
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
</style>

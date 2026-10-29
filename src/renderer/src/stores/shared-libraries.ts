// Attached Shared Libraries (#578), mirrored from main's AttachedLibraryService.
//
// One `shared-libraries:changed` and one `shared-library:found` (#581)
// subscription for the app's lifetime (Pinia singleton, created by App.vue).
// The ffmpeg availability is read through the existing `ffmpeg:check` once a
// library is listed, again on window focus and before each `.mkv` Play, so the
// missing-ffmpeg banner clears once ffmpeg is installed.

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { formatAgo } from '../utils'

export const FFMPEG_MISSING_REASON =
  "ffmpeg isn't installed on this PC, so MKV episodes can't play. Connect to the internet once to download it, or use Prepare for offline."

export function ffmpegMissingText(mkvCount: number): string {
  const n = `${mkvCount} MKV episode${mkvCount === 1 ? '' : 's'}`
  return `ffmpeg isn't installed on this PC, so ${n} can't play. MP4 episodes with .ass subtitles still play. Connect to the internet once to download it, or use Prepare for offline.`
}

export function pathOverflowText(count: number): string {
  const n = `${count} file${count === 1 ? ' is' : 's are'}`
  return `${n} past Windows' 260-character path limit at this location. They play in the app, but other players may not open them. Move the library to a shorter folder to fix this.`
}

/** A library's badge in its management row (#581). */
export const ROLE_BADGE: Record<AttachedLibraryRole, string> = {
  videos: 'Videos only',
  foreign: 'Videos only',
  owner: 'Owner',
  claim: 'Claimed'
}

/** The read-only badge (#582) and its tooltip, one per reason. */
export const READ_ONLY_BADGE = 'Read-only on this computer'
export const READ_ONLY_REASON: Record<AttachedLibraryAccessReason, string> = {
  mount: 'The drive is mounted read-only on this computer.',
  'write-failed':
    "A write to the drive failed, so it's treated as read-only until it's connected again.",
  version: "The library's format is newer than this app.",
  size: 'This library is larger than this version can open.',
  interrupted: 'This library was interrupted while being written.'
}

export function readOnlyTitle(lib: Pick<AttachedLibraryInfo, 'accessReason'>): string {
  return lib.accessReason ? READ_ONLY_REASON[lib.accessReason] : READ_ONLY_BADGE
}

/** An unplugged library's titles (#582): the tooltip names the library and when it was last seen. */
export const DRIVE_NOT_CONNECTED = 'Drive not connected'
export function notConnectedTitle(
  lib: Pick<AttachedLibraryInfo, 'name' | 'lastSeenAt'>,
  now = Date.now()
): string {
  return `${lib.name}: drive not connected. Last seen ${formatAgo(lib.lastSeenAt, now)}.`
}

/** A claim PC's rate of an attached title, from the library base (#582). */
export function rateText(rate: AttachedTitleRate): string {
  const parts = [rate.status, `${rate.episodes} ep`]
  if (rate.score > 0) parts.unshift(`★ ${rate.score}`)
  return parts.join(' · ')
}

/** "never" until the first merge with the library (#584). */
export function lastSyncWhen(lastSyncAt: number | null, now = Date.now()): string {
  return lastSyncAt === null ? 'never' : formatAgo(lastSyncAt, now)
}

/**
 * A library row's status line (#584), until S10 (#585)'s toast and review
 * sheet: "N changes synced, M need review", or why the last run didn't write.
 */
export function syncStatusText(
  entry: { last: SyncLibraryResult | null; needReview: number } | undefined
): string {
  if (!entry) return ''
  const parts: string[] = []
  const last = entry.last
  if (last?.drive === 'error') {
    parts.push(
      last.driveReason === 'write-failed-read-only'
        ? "Couldn't write to the drive"
        : last.driveReason === 'unreadable'
          ? "Couldn't read the drive"
          : 'Sync failed, will retry'
    )
  } else if (last && (last.drive === 'ok' || last.shikimori === 'ok')) {
    parts.push(`${plural(last.counts.applied, 'change', 'changes')} synced`)
  }
  if (entry.needReview > 0) parts.push(`${entry.needReview} need review`)
  return parts.join(', ')
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The Forget confirmation (#581): no warning with nothing pending; a zero part is left out. */
export function forgetConfirmText(name: string, pending: SharedLibraryPendingCount): string {
  const n = pending.libraryChanges
  const m = pending.resolutions
  if (n <= 0 && m <= 0) return `Forget ${name}? The drive isn't changed.`
  const parts: string[] = []
  if (n > 0) parts.push(`${plural(n, 'change', 'changes')} from this library`)
  if (m > 0) parts.push(`${plural(m, 'review-screen choice', 'review-screen choices')} for it`)
  return `Forget ${name}? ${parts.join(' and ')} will be discarded. Your watch state on this PC isn't changed, and the drive isn't changed.`
}

/** The found-on-a-drive toast (#581): every unknown library on one volume. */
export function foundText(found: SharedLibraryFound): string {
  const names = found.candidates
    .map((c) => `'${c.name}'${c.ownerNickname ? ` (${c.ownerNickname})` : ''}`)
    .join(', ')
  const what = found.candidates.length === 1 ? 'Shared Library' : 'Shared Libraries'
  return `${what} ${names} found on ${found.volume}`
}

export const useSharedLibrariesStore = defineStore('shared-libraries', () => {
  const libraries = ref<AttachedLibraryInfo[]>([])
  // Unknown libraries the poller found on newly mounted drives (#581), oldest first.
  const found = ref<SharedLibraryFound[]>([])
  // The toast's Open: App.vue shows the open flow on these candidates.
  const openingFound = ref<SharedLibraryFound | null>(null)
  // Optimistic until the first check answers, so nothing flashes disabled.
  const ffmpegAvailable = ref(true)
  let ffmpegChecked = false
  // Set by "Show in Library" after an open; LibraryView selects the tab and clears it.
  const focusTab = ref(false)

  const attachedCount = computed(() => libraries.value.length)

  /** animeId → the libraries holding it, in list order. */
  const librariesByAnimeId = computed(() => {
    const map = new Map<number, AttachedLibraryInfo[]>()
    for (const lib of libraries.value) {
      for (const t of lib.titles) {
        const list = map.get(t.animeId) ?? []
        list.push(lib)
        map.set(t.animeId, list)
      }
    }
    return map
  })

  async function refresh(): Promise<void> {
    const list = await window.api.sharedLibraryList()
    libraries.value = Array.isArray(list) ? list : []
    if (!ffmpegChecked && libraries.value.length > 0) void checkFfmpeg()
    // A library attached meanwhile (by the toast or by hand) is no longer offered.
    const attached = new Set(libraries.value.map((l) => l.libraryId))
    found.value = found.value
      .map((f) => ({ ...f, candidates: f.candidates.filter((c) => !attached.has(c.libraryId!)) }))
      .filter((f) => f.candidates.length > 0)
  }

  function addFound(f: SharedLibraryFound): void {
    if (!f || !Array.isArray(f.candidates) || f.candidates.length === 0) return
    found.value = [...found.value.filter((x) => x.dir !== f.dir), f]
  }

  function dropFound(f: SharedLibraryFound): void {
    found.value = found.value.filter((x) => x !== f)
  }

  /** The toast's Open: the S7a open flow on the drive's libraries. */
  function openFound(f: SharedLibraryFound): void {
    dropFound(f)
    openingFound.value = f
  }

  /** "Don't ask for this drive": remembered by `libraryId`. */
  async function dontAskFound(f: SharedLibraryFound): Promise<void> {
    dropFound(f)
    await window.api.sharedLibraryDismissPrompt(
      f.candidates.map((c) => c.libraryId).filter((id): id is string => !!id)
    )
  }

  async function checkFfmpeg(): Promise<boolean> {
    ffmpegChecked = true
    try {
      ffmpegAvailable.value = (await window.api.ffmpegCheck())?.available === true
    } catch {
      ffmpegAvailable.value = false
    }
    return ffmpegAvailable.value
  }

  /** The target a title's Play from drive starts, or null when nothing on it can play here. */
  function playTarget(title: AttachedLibraryTitle): AttachedPlayTarget | null {
    return ffmpegAvailable.value ? title.play.any : title.play.withoutFfmpeg
  }

  /** Whether the library is connected; null when it isn't attached (#582). */
  function isAvailable(libraryId: string): boolean | null {
    return libraries.value.find((l) => l.libraryId === libraryId)?.available ?? null
  }

  /**
   * Resolves true once the library is reported unavailable: at once when the
   * store already says so, else on the next `shared-libraries:changed` that
   * does, within `timeoutMs` (one poll interval). False when it stays
   * available, so a sleeping drive that wakes up is not a disconnect (#582).
   */
  function waitForUnavailable(libraryId: string, timeoutMs: number): Promise<boolean> {
    if (isAvailable(libraryId) === false) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (v: boolean): void => {
        if (done) return
        done = true
        stop()
        clearTimeout(timer)
        resolve(v)
      }
      const stop = watch(
        libraries,
        () => {
          if (isAvailable(libraryId) === false) finish(true)
        },
        { flush: 'sync' }
      )
      const timer = setTimeout(() => finish(false), timeoutMs)
    })
  }

  // --- The merge (#584): Sync now, and each library's last result.
  const syncStatus = ref<SyncStatus>({ running: [], libraries: {} })
  // Sync now scopes in flight: 'all', or `title:<animeId>`.
  const syncing = ref<string[]>([])

  async function refreshSyncStatus(): Promise<void> {
    const s = await window.api.syncGetStatus()
    if (s && Array.isArray(s.running)) syncStatus.value = s
  }

  /** Every attached owned or claimed library, or only those holding `animeId`, restricted to it. */
  async function syncNow(animeId?: number): Promise<void> {
    const key = animeId === undefined ? 'all' : `title:${animeId}`
    if (syncing.value.includes(key)) return
    syncing.value = [...syncing.value, key]
    try {
      await window.api.sharedLibrarySyncNow(animeId === undefined ? {} : { animeId })
    } finally {
      syncing.value = syncing.value.filter((k) => k !== key)
      await refreshSyncStatus().catch(() => {})
    }
  }

  /** Whether an owned or claimed library has `animeId` in scope (the detail page's Sync now). */
  function canSyncTitle(animeId: number): boolean {
    return libraries.value.some(
      (l) =>
        l.mode === 'metadata' &&
        (l.role === 'owner' || l.role === 'claim') &&
        l.titles.some((t) => t.animeId === animeId)
    )
  }

  void window.api.onSyncRunFinished(() => {
    void refreshSyncStatus().catch(() => {})
  })
  void window.api.onSharedLibrariesChanged(() => {
    void refresh().catch(() => {})
  })
  void window.api.onSharedLibraryFound((f) => addFound(f))
  // App.vue creates this store at startup (#581), so only a PC with a library
  // attached pays for the `ffmpeg -version` spawn: the first check waits for a
  // `refresh()` that lists one, and focus re-checks only while one is.
  window.addEventListener('focus', () => {
    if (libraries.value.length > 0) void checkFfmpeg()
  })
  void refresh().catch(() => {})
  void refreshSyncStatus().catch(() => {})

  return {
    syncStatus,
    syncing,
    syncNow,
    canSyncTitle,
    refreshSyncStatus,
    libraries,
    found,
    openingFound,
    ffmpegAvailable,
    focusTab,
    attachedCount,
    librariesByAnimeId,
    refresh,
    checkFfmpeg,
    playTarget,
    isAvailable,
    waitForUnavailable,
    addFound,
    dropFound,
    openFound,
    dontAskFound
  }
})

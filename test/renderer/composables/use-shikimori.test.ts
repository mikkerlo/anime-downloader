import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { useShikimori } from '../../../src/renderer/src/composables/use-shikimori'

type Api = {
  shikimoriGetUser: () => Promise<ShikiUser | null>
  shikimoriGetRate: (malId: number) => Promise<ShikiUserRate | null>
  shikimoriGetFriendsRates: (malId: number) => Promise<ShikiFriendRate[]>
  shikimoriGetAnimeDetails: (malId: number) => Promise<ShikiAnimeDetails | null>
  shikimoriUpdateRate: (
    malId: number,
    episodes: number,
    status: ShikiUserRateStatus,
    score: number,
    rewatches: number
  ) => Promise<ShikiUserRate>
  shikimoriTriggerSync: () => Promise<void>
  shikimoriGetSyncStatus: () => Promise<unknown>
  shikimoriGetOfflineQueueLength: () => Promise<number>
  shikimoriGetAnimeRates: () => Promise<unknown[]>
  onShikimoriRateUpdated: (cb: (entry: unknown) => void) => Unsubscribe
  onShikimoriRatesRefreshed: (cb: (entries: unknown[]) => void) => Unsubscribe
  onShikimoriProfileRefreshed: (cb: (profile: unknown) => void) => Unsubscribe
  onShikimoriFriendsRefreshed: (cb: (friends: unknown[]) => void) => Unsubscribe
  onShikimoriRecommendationsRefreshed: (cb: (recs: unknown[]) => void) => Unsubscribe
  onShikimoriAnimeDetailsUpdated: (cb: (data: unknown) => void) => Unsubscribe
  onShikimoriOfflineQueueChanged: (cb: (data: unknown) => void) => Unsubscribe
  onShikimoriSyncStatus: (cb: (data: unknown) => void) => Unsubscribe
}

function noopSub(): Unsubscribe {
  return () => {}
}

const STORE_BROADCAST_STUBS: Partial<Api> = {
  onShikimoriRateUpdated: noopSub,
  onShikimoriRatesRefreshed: noopSub,
  onShikimoriProfileRefreshed: noopSub,
  onShikimoriFriendsRefreshed: noopSub,
  onShikimoriRecommendationsRefreshed: noopSub,
  onShikimoriAnimeDetailsUpdated: noopSub,
  onShikimoriOfflineQueueChanged: noopSub,
  onShikimoriSyncStatus: noopSub
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

function installDefaultApi(): void {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = {
    api: { ...STORE_BROADCAST_STUBS }
  }
}

function mkAnime(
  opts: { id?: number; malId?: number; numberOfEpisodes?: number } = {}
): AnimeDetail {
  return {
    id: opts.id ?? 1,
    myAnimeListId: opts.malId ?? 99,
    numberOfEpisodes: opts.numberOfEpisodes ?? 12
  } as unknown as AnimeDetail
}

function makeDeps(opts: { anime?: AnimeDetail | null } = {}) {
  setActivePinia(createPinia())
  return {
    anime: ref<AnimeDetail | null>(opts.anime ?? null),
    shikimoriStore: useShikimoriStore()
  }
}

beforeEach(() => {
  installDefaultApi()
})

describe('useShikimori — initial state', () => {
  it('starts with idle defaults', () => {
    const s = useShikimori(makeDeps())
    expect(s.shikiUser.value).toBeNull()
    expect(s.shikiRate.value).toBeNull()
    expect(s.shikiStatus.value).toBe('planned')
    expect(s.shikiEpisodes.value).toBe(0)
    expect(s.shikiScore.value).toBe(0)
    expect(s.shikiRewatches.value).toBe(0)
    expect(s.shikiLoading.value).toBe(false)
    expect(s.shikiSaving.value).toBe(false)
    expect(s.shikiError.value).toBe('')
    expect(s.shikiUserChecked.value).toBe(false)
    expect(s.friendsRates.value).toEqual([])
    expect(s.descExpanded.value).toBe(false)
  })

  it('shikiDetailsDescription strips BBCode tags', () => {
    const s = useShikimori(makeDeps())
    s.shikiDetails.value = {
      description: '[b]Bold[/b] world [url=foo]link[/url]'
    } as unknown as ShikiAnimeDetails
    expect(s.shikiDetailsDescription.value).toBe('Bold world link')
  })

  it('shikiDetailsDescription strips HTML when description_html is the source', () => {
    const s = useShikimori(makeDeps())
    s.shikiDetails.value = {
      description: '',
      description_html: '<p>Hello <b>world</b></p>'
    } as unknown as ShikiAnimeDetails
    expect(s.shikiDetailsDescription.value).toBe('Hello world')
  })
})

describe('useShikimori — auto-status from shikiEpisodes', () => {
  it('flips to completed when reaching numberOfEpisodes', async () => {
    const anime = ref<AnimeDetail | null>(mkAnime({ numberOfEpisodes: 12 }))
    const s = useShikimori({ ...makeDeps(), anime })
    s.shikiStatus.value = 'watching'
    s.shikiEpisodes.value = 12
    await nextTick()
    expect(s.shikiStatus.value).toBe('completed')
  })

  it('flips planned → watching on first episode', async () => {
    const s = useShikimori(makeDeps({ anime: mkAnime() }))
    s.shikiStatus.value = 'planned'
    s.shikiEpisodes.value = 1
    await nextTick()
    expect(s.shikiStatus.value).toBe('watching')
  })

  it('flips completed → rewatching when episodes change again', async () => {
    const s = useShikimori(makeDeps({ anime: mkAnime() }))
    s.shikiStatus.value = 'completed'
    s.shikiEpisodes.value = 5
    await nextTick()
    expect(s.shikiStatus.value).toBe('rewatching')
  })

  it('does not nudge when status is dropped or on_hold', async () => {
    const s = useShikimori(makeDeps({ anime: mkAnime() }))
    s.shikiStatus.value = 'on_hold'
    s.shikiEpisodes.value = 3
    await nextTick()
    expect(s.shikiStatus.value).toBe('on_hold')
  })
})

describe('useShikimori — loadShikimoriData', () => {
  it('loads user then short-circuits without MAL id', async () => {
    setApi({ shikimoriGetUser: vi.fn().mockResolvedValue({ id: 1 } as ShikiUser) })
    const loadRelated = vi.fn().mockResolvedValue(undefined)
    const s = useShikimori(makeDeps({ anime: { id: 1 } as unknown as AnimeDetail }))
    await s.loadShikimoriData(loadRelated)
    expect(s.shikiUserChecked.value).toBe(true)
    expect(s.shikiUser.value?.id).toBe(1)
    expect(loadRelated).not.toHaveBeenCalled()
  })

  it('loads rate + friends + details + related when user is signed in', async () => {
    const rate: ShikiUserRate = {
      id: 10,
      status: 'watching',
      episodes: 3,
      score: 7,
      rewatches: 0,
      target_id: 99,
      target_type: 'Anime'
    } as unknown as ShikiUserRate
    const friends: ShikiFriendRate[] = [{ nickname: 'F' } as unknown as ShikiFriendRate]
    const details = { description: 'd' } as unknown as ShikiAnimeDetails
    setApi({
      shikimoriGetUser: vi.fn().mockResolvedValue({ id: 1 } as ShikiUser),
      shikimoriGetRate: vi.fn().mockResolvedValue(rate),
      shikimoriGetFriendsRates: vi.fn().mockResolvedValue(friends),
      shikimoriGetAnimeDetails: vi.fn().mockResolvedValue(details)
    })
    const loadRelated = vi.fn().mockResolvedValue(undefined)
    const s = useShikimori(makeDeps({ anime: mkAnime({ malId: 99 }) }))
    await s.loadShikimoriData(loadRelated)
    expect(loadRelated).toHaveBeenCalledWith(99)
    expect(s.shikiRate.value).toEqual(rate)
    expect(s.shikiStatus.value).toBe('watching')
    expect(s.shikiEpisodes.value).toBe(3)
    expect(s.shikiScore.value).toBe(7)
    expect(s.friendsRates.value).toEqual(friends)
    expect(s.shikiDetails.value).toEqual(details)
    expect(s.shikiLoading.value).toBe(false)
    expect(s.friendsLoading.value).toBe(false)
  })

  it('clears shikiUserChecked even when getUser throws', async () => {
    setApi({ shikimoriGetUser: vi.fn().mockRejectedValue(new Error('boom')) })
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = useShikimori(makeDeps({ anime: { id: 1 } as unknown as AnimeDetail }))
    await s.loadShikimoriData(vi.fn().mockResolvedValue(undefined))
    expect(s.shikiUserChecked.value).toBe(true)
    expect(s.shikiUser.value).toBeNull()
    consoleErr.mockRestore()
  })
})

describe('useShikimori — shikiSave', () => {
  it('persists via IPC and updates rate/rewatches', async () => {
    const rate: ShikiUserRate = {
      id: 1,
      status: 'watching',
      episodes: 5,
      score: 8,
      rewatches: 2,
      target_id: 99,
      target_type: 'Anime'
    } as unknown as ShikiUserRate
    const update = vi.fn().mockResolvedValue(rate)
    setApi({ shikimoriUpdateRate: update })
    const s = useShikimori(makeDeps({ anime: mkAnime({ malId: 99 }) }))
    s.shikiEpisodes.value = 5
    s.shikiStatus.value = 'watching'
    s.shikiScore.value = 8
    s.shikiRewatches.value = 1
    await s.shikiSave()
    expect(update).toHaveBeenCalledWith(99, 5, 'watching', 8, 1)
    expect(s.shikiRate.value).toEqual(rate)
    expect(s.shikiRewatches.value).toBe(2)
    expect(s.shikiError.value).toBe('')
  })

  it('captures error message on IPC failure', async () => {
    setApi({ shikimoriUpdateRate: vi.fn().mockRejectedValue(new Error('network')) })
    const s = useShikimori(makeDeps({ anime: mkAnime() }))
    await s.shikiSave()
    expect(s.shikiError.value).toMatch(/network/i)
    expect(s.shikiSaving.value).toBe(false)
  })

  it('no-ops without a MAL id', async () => {
    const update = vi.fn()
    setApi({ shikimoriUpdateRate: update })
    const s = useShikimori(makeDeps({ anime: { id: 1 } as unknown as AnimeDetail }))
    await s.shikiSave()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('useShikimori — triggerSyncNow', () => {
  it('delegates to shikimoriStore.triggerSync', async () => {
    setApi({ shikimoriTriggerSync: vi.fn().mockResolvedValue(undefined) })
    const deps = makeDeps()
    const spy = vi.spyOn(deps.shikimoriStore, 'triggerSync')
    const s = useShikimori(deps)
    await s.triggerSyncNow()
    expect(spy).toHaveBeenCalled()
  })
})

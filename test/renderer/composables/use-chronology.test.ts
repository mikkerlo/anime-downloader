import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChronology } from '../../../src/renderer/src/composables/use-chronology'
import { accountsState, trackersApi } from '../../helpers/trackers-api'

type Api = Record<string, unknown> & {
  trackerGetRelated?: (malId: number) => Promise<ShikiRelatedEntry[]>
}

/** The trackers store's half plus `api`; `accounts` answers its first accounts read. */
function setApi(
  api: Partial<Api>,
  accounts?: TrackerAccountsState | Promise<TrackerAccountsState>
): void {
  const trackers = trackersApi({ accounts: accounts instanceof Promise ? undefined : accounts })
  if (accounts instanceof Promise) trackers.api.trackerListAccounts.mockReturnValue(accounts)
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: { ...trackers.api, onTrackerDetailsUpdated: () => () => {}, ...api }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

const withChronology = (source: TrackerId): TrackerAccountsState => ({
  ...accountsState([source]),
  featureSources: { chronology: source }
})

beforeEach(() => {
  setApi({})
  setActivePinia(createPinia())
})

describe('useChronology', () => {
  it('starts empty, idle, and collapsed', () => {
    const { shikiRelated, relatedLoading, relatedCollapsed, relatedDeferred } = useChronology()
    expect(shikiRelated.value).toEqual([])
    expect(relatedLoading.value).toBe(false)
    expect(relatedCollapsed.value).toBe(true)
    expect(relatedDeferred.value).toBe(false)
  })

  it('loadRelated fetches via IPC and toggles loading', async () => {
    const fake: ShikiRelatedEntry[] = [
      {
        relation: 'Sequel',
        anime: { id: 1, name: 'Foo', russian: 'Foo', kind: 'tv', episodes: 12 }
      } as unknown as ShikiRelatedEntry
    ]
    const spy = vi.fn().mockResolvedValue(fake)
    setApi({ trackerGetRelated: spy })

    const { shikiRelated, relatedLoading, loadRelated } = useChronology()
    const p = loadRelated(123)
    expect(relatedLoading.value).toBe(true)
    await p
    expect(relatedLoading.value).toBe(false)
    expect(spy).toHaveBeenCalledWith(123)
    expect(shikiRelated.value).toEqual(fake)
  })

  it('loadRelated(0) is a no-op', async () => {
    const spy = vi.fn()
    setApi({ trackerGetRelated: spy })
    const { loadRelated, relatedLoading } = useChronology()
    await loadRelated(0)
    expect(spy).not.toHaveBeenCalled()
    expect(relatedLoading.value).toBe(false)
  })

  it('still clears loading on IPC failure', async () => {
    const err = new Error('boom')
    setApi({ trackerGetRelated: vi.fn().mockRejectedValue(err) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadRelated, relatedLoading, shikiRelated } = useChronology()
    await loadRelated(7)
    expect(relatedLoading.value).toBe(false)
    expect(shikiRelated.value).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('useChronology — the chronology source (#710)', () => {
  it('a MAL source defers: no call on load, one on the first expand, none after', async () => {
    const entries = [{ relation: 'sequel' } as ShikiRelatedEntry]
    const spy = vi.fn().mockResolvedValue(entries)
    setApi({ trackerGetRelated: spy }, withChronology('mal'))
    const c = useChronology()

    await c.loadRelated(5114)
    expect(spy).not.toHaveBeenCalled()
    expect(c.relatedDeferred.value).toBe(true)
    expect(c.relatedLoading.value).toBe(false)

    c.relatedCollapsed.value = false
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(5114)
    expect(c.shikiRelated.value).toEqual(entries)
    expect(c.relatedDeferred.value).toBe(false)

    c.relatedCollapsed.value = true
    await flush()
    c.relatedCollapsed.value = false
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a MAL walk that fails on expand clears relatedDeferred and leaves the list empty', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.fn().mockRejectedValue(new Error('MAL down'))
    setApi({ trackerGetRelated: spy }, withChronology('mal'))
    const c = useChronology()
    await c.loadRelated(5114)
    c.relatedCollapsed.value = false
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(c.relatedDeferred.value).toBe(false)
    expect(c.relatedLoading.value).toBe(false)
    expect(c.shikiRelated.value).toEqual([])
    errSpy.mockRestore()
  })

  it('before accountsLoaded a MAL source never takes the eager path', async () => {
    const spy = vi.fn().mockResolvedValue([])
    // The first accounts read never settles.
    setApi({ trackerGetRelated: spy }, new Promise(() => {}))
    const c = useChronology()
    void c.loadRelated(5114)
    await flush()
    expect(spy).not.toHaveBeenCalled()
    expect(c.relatedDeferred.value).toBe(false)
  })

  it('waits for accountsLoaded, then defers for MAL', async () => {
    const spy = vi.fn().mockResolvedValue([])
    let settle!: (s: TrackerAccountsState) => void
    setApi({ trackerGetRelated: spy }, new Promise((r) => (settle = r)))
    const c = useChronology()
    const p = c.loadRelated(5114)
    await flush()
    expect(spy).not.toHaveBeenCalled()
    settle(withChronology('mal'))
    await p
    expect(spy).not.toHaveBeenCalled()
    expect(c.relatedDeferred.value).toBe(true)
  })

  it('Shikimori and AniList sources call it at once', async () => {
    for (const source of ['shikimori', 'anilist'] as const) {
      setActivePinia(createPinia())
      const spy = vi.fn().mockResolvedValue([])
      setApi({ trackerGetRelated: spy }, withChronology(source))
      const c = useChronology()
      await c.loadRelated(5114)
      expect(spy).toHaveBeenCalledWith(5114)
      expect(c.relatedDeferred.value).toBe(false)
    }
  })
})

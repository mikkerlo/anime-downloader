// @vitest-environment happy-dom
// The mirror chips under the primary's rate panel (#705, T8b). The chips
// render main's per-title signals (`tracker:get-rate`'s `stale`, `queued`,
// `unmapped`, `differs`) and the store's `rateFor` values; they compute no
// difference themselves. Mounted through `TrackerPanel`, which shows them only
// with two or more trackers connected.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import TrackerPanel from '../../../src/renderer/src/components/detail/TrackerPanel.vue'
import { TrackerKey } from '../../../src/renderer/src/components/detail/keys'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import {
  accountsState,
  trackerEntry,
  trackersApi,
  type TrackersApi
} from '../../helpers/trackers-api'

const MAL = 5114

const IDLE: TrackerSyncStatus = {
  state: 'idle',
  queueLength: 0,
  lastSyncAt: 0,
  lastSyncError: null,
  sessionExpired: false,
  needsSetup: false
}

const PRIMARY: TrackerRateValues = { episodes: 9, status: 'watching', score: 8, rewatches: 0 }

function entry(trackerId: TrackerId, values: TrackerRateValues): TrackerRateEntry {
  return { ...trackerEntry(trackerId, MAL, values.status), values: { ...values } }
}

function result(over: Partial<TrackerRateResult> = {}): TrackerRateResult {
  return { values: null, stale: false, queued: false, unmapped: false, differs: [], ...over }
}

interface Setup {
  connected?: TrackerId[]
  mirror?: TrackerAccountsState['mirror']
  rates?: Partial<Record<TrackerId, TrackerRateValues>>
  queuedAfter?: Partial<Record<TrackerId, Record<number, TrackerRateValues>>>
  results?: Partial<Record<TrackerId, TrackerRateResult>>
  status?: Partial<Record<TrackerId, Partial<TrackerSyncStatus>>>
  numberOfEpisodes?: number
}

function trackerRateStub() {
  return {
    rateStale: computed(() => false),
    mediaId: ref<number | undefined>(undefined),
    rateStatus: ref('watching'),
    rateEpisodes: ref(9),
    rateScore: ref(8),
    rateRewatches: ref(0),
    loading: ref(false),
    saving: ref(false),
    saveError: ref(''),
    syncState: computed(() => 'idle' as const),
    lastSyncError: computed(() => null),
    save: vi.fn(),
    triggerSyncNow: vi.fn()
  }
}

let trackers: TrackersApi
let results: Partial<Record<TrackerId, TrackerRateResult>>
let copyFromPrimary: ReturnType<typeof vi.fn>

async function mountPanel(s: Setup = {}) {
  const connected = s.connected ?? ['shikimori', 'anilist']
  const rates = Object.fromEntries(
    Object.entries(s.rates ?? { shikimori: PRIMARY }).map(([id, v]) => [
      id,
      [entry(id as TrackerId, v)]
    ])
  )
  trackers = trackersApi({
    accounts: { ...accountsState(connected), mirror: s.mirror ?? {} },
    rates
  })
  trackers.api.trackerGetRates.mockImplementation(async (id: TrackerId) => ({
    trackerId: id,
    entries: rates[id] ?? [],
    queuedAfter: s.queuedAfter?.[id] ?? {}
  }))
  trackers.api.trackerGetSyncStatus.mockImplementation(async (id: TrackerId) => ({
    ...IDLE,
    ...s.status?.[id]
  }))
  results = { ...s.results }
  trackers.api.trackerGetRate.mockImplementation(async (id: TrackerId) => results[id] ?? null)
  copyFromPrimary = vi.fn(async () => null)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { ...trackers.api, trackerCopyFromPrimary: copyFromPrimary } as Record<string, unknown>,
    { get: (target, prop) => (prop in target ? target[prop as string] : () => () => {}) }
  )
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrackerPanel, {
    props: {
      anime: {
        myAnimeListId: MAL,
        numberOfEpisodes: s.numberOfEpisodes ?? 24
      } as unknown as AnimeDetail
    },
    global: {
      plugins: [pinia],
      provide: { [TrackerKey as unknown as symbol]: trackerRateStub() }
    }
  })
  await flushPromises()
  return wrapper
}

const chip = (w: Awaited<ReturnType<typeof mountPanel>>, id: TrackerId) =>
  w.find(`[data-testid="mirror-chip-${id}"]`)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TrackerMirrorChips: when they show', () => {
  it('one tracker: no chip row, and no per-title read', async () => {
    const w = await mountPanel({ connected: ['shikimori'] })
    expect(w.find('[data-testid="mirror-chips"]').exists()).toBe(false)
    expect(trackers.api.trackerGetRate).not.toHaveBeenCalled()
  })

  it('two trackers: one chip for the mirror with status, eps/total and score', async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY, anilist: { ...PRIMARY, episodes: 7, score: 6 } },
      results: { anilist: result({ values: { ...PRIMARY, episodes: 7, score: 6 } }) }
    })
    const chips = w.findAll('[data-testid^="mirror-chip-"]')
    expect(chips).toHaveLength(1)
    expect(chip(w, 'anilist').text()).toContain('AL')
    // The total is the entry's `anime.episodes` (12), not the page's 24.
    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Watching · 7/12 · ★ 6')
    expect(trackers.api.trackerGetRate).toHaveBeenCalledWith('anilist', MAL)
  })

  it("the total falls back to the page's episode count for a queued-only title", async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY },
      queuedAfter: { anilist: { [MAL]: { ...PRIMARY, episodes: 3, score: 0 } } },
      results: { anilist: result({ queued: true }) }
    })
    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Watching · 3/24 · ★ –')
  })

  it('one chip per mirror, in tracker order, with three connected', async () => {
    const w = await mountPanel({ connected: ['shikimori', 'anilist', 'mal'] })
    expect(
      w.findAll('[data-testid^="mirror-chip-"]').map((c) => c.attributes('data-testid'))
    ).toEqual(['mirror-chip-anilist', 'mirror-chip-mal'])
  })
})

describe('TrackerMirrorChips: states', () => {
  it('queued', async () => {
    const w = await mountPanel({ results: { anilist: result({ values: PRIMARY, queued: true }) } })
    expect(chip(w, 'anilist').find('[data-testid="mc-queued"]').exists()).toBe(true)
    expect(chip(w, 'anilist').find('[data-testid="mc-stale"]').exists()).toBe(false)
  })

  it('stale', async () => {
    const w = await mountPanel({ results: { anilist: result({ values: PRIMARY, stale: true }) } })
    expect(chip(w, 'anilist').find('[data-testid="mc-stale"]').exists()).toBe(true)
  })

  it('session expired, with the queued icon beside it, and a link to its Settings card', async () => {
    const w = await mountPanel({
      status: { anilist: { sessionExpired: true } },
      results: { anilist: result({ values: PRIMARY, queued: true }) }
    })
    const expired = chip(w, 'anilist').find('[data-testid="mc-expired"]')
    expect(expired.exists()).toBe(true)
    expect(chip(w, 'anilist').find('[data-testid="mc-queued"]').exists()).toBe(true)
    const library = useLibraryStore()
    const nav = vi.spyOn(library, 'navigateToSettingsTab')
    await expired.trigger('click')
    expect(nav).toHaveBeenCalledWith('trackers', 'anilist')
  })

  it('needs setup, with a link to its Settings card', async () => {
    const w = await mountPanel({
      connected: ['shikimori', 'mal'],
      status: { mal: { needsSetup: true } },
      results: { mal: result({ values: PRIMARY }) }
    })
    const setup = chip(w, 'mal').find('[data-testid="mc-needs-setup"]')
    expect(setup.exists()).toBe(true)
    const nav = vi.spyOn(useLibraryStore(), 'navigateToSettingsTab')
    await setup.trigger('click')
    expect(nav).toHaveBeenCalledWith('trackers', 'mal')
  })

  it('"not on AniList" replaces the values and offers no copy', async () => {
    const w = await mountPanel({
      results: { anilist: result({ unmapped: true }) }
    })
    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Not on AniList')
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').exists()).toBe(false)
  })

  it('mirroring off is marked, and the copy stays available', async () => {
    const w = await mountPanel({
      mirror: { anilist: false },
      rates: { shikimori: PRIMARY, anilist: { ...PRIMARY, episodes: 7 } },
      results: { anilist: result({ values: { ...PRIMARY, episodes: 7 }, differs: ['episodes'] }) }
    })
    expect(chip(w, 'anilist').find('[data-testid="mc-mirror-off"]').text()).toBe('mirroring off')
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').exists()).toBe(true)
  })

  it('a mirror with mirroring on carries no "mirroring off" mark', async () => {
    const w = await mountPanel({ results: { anilist: result({ values: PRIMARY }) } })
    expect(chip(w, 'anilist').find('[data-testid="mc-mirror-off"]').exists()).toBe(false)
  })
})

describe('TrackerMirrorChips: the mismatch chip and "Copy from primary"', () => {
  it('a non-empty differs shows the warning chip and the button; a click copies, disabled until it resolves', async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY, anilist: { ...PRIMARY, episodes: 7 } },
      results: { anilist: result({ values: { ...PRIMARY, episodes: 7 }, differs: ['episodes'] }) }
    })
    expect(chip(w, 'anilist').classes()).toContain('mirror-chip-warn')
    let resolve!: (v: TrackerRateValues | null) => void
    copyFromPrimary.mockImplementation(() => new Promise((r) => (resolve = r)))
    const button = chip(w, 'anilist').find('[data-testid="mc-copy"]')
    expect(button.text()).toBe('Copy from primary')

    await button.trigger('click')
    expect(copyFromPrimary).toHaveBeenCalledWith('anilist', MAL)
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').attributes('disabled')).toBeDefined()
    await chip(w, 'anilist').find('[data-testid="mc-copy"]').trigger('click')
    expect(copyFromPrimary).toHaveBeenCalledTimes(1)

    resolve(PRIMARY)
    await flushPromises()
    expect(
      chip(w, 'anilist').find('[data-testid="mc-copy"]').attributes('disabled')
    ).toBeUndefined()
  })

  it('a refused copy shows an error on that chip only', async () => {
    const w = await mountPanel({
      connected: ['shikimori', 'anilist', 'mal'],
      results: {
        anilist: result({ values: PRIMARY, differs: ['episodes'] }),
        mal: result({ values: PRIMARY, differs: ['score'] })
      }
    })
    copyFromPrimary.mockRejectedValueOnce(new Error('This title is not on AniList'))
    await chip(w, 'anilist').find('[data-testid="mc-copy"]').trigger('click')
    await flushPromises()
    expect(chip(w, 'anilist').find('[data-testid="mc-error"]').exists()).toBe(true)
    expect(chip(w, 'mal').find('[data-testid="mc-error"]').exists()).toBe(false)
  })

  it('the chip follows differs only: on-screen values that differ, with differs [], show no mismatch', async () => {
    const w = await mountPanel({
      // A POINT_5 read-back: the app's 7 came back as 8. Main says no difference.
      rates: { shikimori: { ...PRIMARY, score: 7 }, anilist: PRIMARY },
      results: { anilist: result({ values: PRIMARY, differs: [] }) }
    })
    expect(chip(w, 'anilist').classes()).not.toContain('mirror-chip-warn')
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').exists()).toBe(false)
  })

  it('an in-flight mirror write that already matches: the queued icon, and no "Copy from primary"', async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY, anilist: { ...PRIMARY, episodes: 7 } },
      queuedAfter: { anilist: { [MAL]: PRIMARY } },
      results: { anilist: result({ values: { ...PRIMARY, episodes: 7 }, queued: true }) }
    })
    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Watching · 9/12 · ★ 8')
    expect(chip(w, 'anilist').find('[data-testid="mc-queued"]').exists()).toBe(true)
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').exists()).toBe(false)
  })
})

describe('TrackerMirrorChips: refetches', () => {
  it('a negative entry expires: "not on AniList", then the values again after a refetch', async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY },
      results: { anilist: result({ unmapped: true }) }
    })
    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Not on AniList')

    results.anilist = result({
      unmapped: false,
      differs: ['episodes', 'status', 'score', 'rewatches']
    })
    trackers.emitRatesRefreshed({ trackerId: 'anilist', entries: [] })
    await flushPromises()

    expect(chip(w, 'anilist').find('.mc-values').text()).toBe('Not in list')
    expect(chip(w, 'anilist').find('[data-testid="mc-copy"]').exists()).toBe(true)
  })

  it('a queued-only change clears the icon: the queue event alone refetches, with no rate update', async () => {
    const w = await mountPanel({
      rates: { shikimori: PRIMARY, anilist: PRIMARY },
      queuedAfter: { anilist: { [MAL]: PRIMARY } },
      results: { anilist: result({ values: PRIMARY, queued: true }) }
    })
    expect(chip(w, 'anilist').find('[data-testid="mc-queued"]').exists()).toBe(true)
    const reads = trackers.api.trackerGetRate.mock.calls.length

    results.anilist = result({ values: PRIMARY, queued: false })
    trackers.emitQueueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    await flushPromises()

    expect(trackers.api.trackerGetRate.mock.calls.length).toBeGreaterThan(reads)
    expect(chip(w, 'anilist').find('[data-testid="mc-queued"]').exists()).toBe(false)
  })

  it('unmounting releases the hold: a later queue event reads nothing', async () => {
    const w = await mountPanel({
      queuedAfter: { anilist: { [MAL]: PRIMARY } },
      results: { anilist: result({ values: PRIMARY, queued: true }) }
    })
    w.unmount()
    const reads = trackers.api.trackerGetRate.mock.calls.length
    trackers.emitQueueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    await flushPromises()
    expect(trackers.api.trackerGetRate.mock.calls.length).toBe(reads)
  })
})
